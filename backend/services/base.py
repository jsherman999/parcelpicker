from __future__ import annotations

import asyncio
import json
import math
import re
from dataclasses import dataclass
from time import monotonic
from typing import Any

import httpx

from backend.services.geometry import esri_to_geojson, geojson_to_esri
from backend.services.parcel import ParcelRecord, normalize_text

CENSUS_GEOCODE_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"

# Common US street-type and directional tokens, used to bound a street prefix
# extracted from a full "street, city, state zip" input (mirrors the sets in
# web/js/providers/base.js).
STREET_TYPE_TOKENS = frozenset({
    "AVE", "AVENUE", "ST", "STREET", "RD", "ROAD", "LN", "LANE", "DR", "DRIVE",
    "BLVD", "BOULEVARD", "CT", "COURT", "CIR", "CIRCLE", "TRL", "TRAIL", "WAY",
    "PL", "PLACE", "PKWY", "PARKWAY", "HWY", "HIGHWAY", "TER", "TERRACE",
    "LOOP", "PATH", "PT", "POINT", "RUN", "PASS", "CV", "COVE", "XING",
    "CROSSING", "SQ", "SQUARE", "ALY", "ALLEY", "ROW", "BND", "BEND", "CRES",
    "CRESCENT",
})

DIRECTIONAL_TOKENS = frozenset({"N", "S", "E", "W", "NE", "NW", "SE", "SW"})


def street_prefix(address: str) -> str | None:
    """House number + street name (+ type + directional), cut at the first
    street-type token so a trailing city token is excluded.

    "30281 NATURE RD ROYALTON" -> "30281 NATURE RD"
    Falls back to the first 4 tokens when no street-type token is present
    ("12005 TOWN ROAD 129 BAUDETTE" -> "12005 TOWN ROAD 129").
    """
    tokens = str(address or "").split()
    if not tokens or not tokens[0].isdigit():
        return None
    for i in range(1, len(tokens)):
        if tokens[i].upper() in STREET_TYPE_TOKENS:
            # A numeric token right after the type means it is part of the
            # street name ("TOWN ROAD 129"), not a boundary.
            if i + 1 < len(tokens) and tokens[i + 1].isdigit():
                continue
            end = i
            if i + 1 < len(tokens) and tokens[i + 1].upper() in DIRECTIONAL_TOKENS:
                end = i + 1
            return " ".join(tokens[: end + 1])
    return " ".join(tokens[:4])


# County layers mark "no value" with -9999, 0, "NULL", blanks or runs of
# spaces (mirrors cleanText / cleanAmount in web/js/providers/base.js).
_NO_VALUE_TEXT = re.compile(r"^(?:NULL|-9999(?:\.0+)?|0(?:\.0+)?)?$", re.IGNORECASE)
_LEADING_NUMBER = re.compile(r"^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?")


def clean_text(value: Any) -> str:
    text = " ".join(str("" if value is None else value).split())
    return "" if _NO_VALUE_TEXT.match(text) else text


def clean_amount(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        number = float(value)
    else:
        match = _LEADING_NUMBER.match(re.sub(r"[$,\s]", "", str(value)))
        if not match:
            return None
        number = float(match.group(0))
    return number if math.isfinite(number) and number > 0 else None


class BudgetExceededError(RuntimeError):
    """The run's request budget is spent."""


@dataclass(slots=True)
class RequestBudget:
    max_requests: int
    used_requests: int = 0

    def consume(self) -> None:
        self.used_requests += 1
        if self.used_requests > self.max_requests:
            raise BudgetExceededError(
                "Request budget exceeded while querying parcel providers. "
                "Increase MAX_REQUESTS_PER_RUN if needed."
            )


@dataclass(slots=True)
class GeocodeResult:
    lon: float
    lat: float
    matched_address: str


class BaseParcelProvider:

    endpoint_url: str = ""
    source_id: str = ""
    parcel_id_field: str = ""
    owner_field: str = ""
    address_field: str = ""
    extra_out_fields: list[str] = []
    adjacent_spatial_rel: str = "esriSpatialRelTouches"
    # Estimated Market Value: one field, or a list of fields that are summed
    # (Sherburne publishes land and building EMV separately).
    # value_year_field is the layer's assessment or market year, when it has
    # one. "" means the county doesn't publish it.
    value_field: str | list[str] = ""
    value_year_field: str = ""
    land_use_field: str = ""

    def __init__(
        self,
        *,
        county: str = "",
        client: httpx.AsyncClient | None = None,
        timeout_seconds: float = 20.0,
        max_retries: int = 2,
        retry_backoff_seconds: float = 0.8,
        min_interval_seconds: float = 0.15,
    ) -> None:
        self.county = county
        self._external_client = client
        self._timeout_seconds = timeout_seconds
        self._max_retries = max_retries
        self._retry_backoff_seconds = retry_backoff_seconds
        self._min_interval_seconds = min_interval_seconds
        self._throttle_lock = asyncio.Lock()
        self._last_request_at = 0.0

        self._address_cache: dict[str, ParcelRecord] = {}
        self._parcel_cache: dict[str, ParcelRecord] = {}

    async def lookup(
        self,
        address: str,
        *,
        budget: RequestBudget,
    ) -> ParcelRecord | None:
        cleaned = normalize_text(address)
        if not cleaned:
            raise ValueError("Address must not be empty.")

        cached = self._address_cache.get(cleaned)
        if cached is not None:
            return cached

        feature = await self._query_by_address(cleaned, budget=budget)
        if feature is not None:
            record = self._feature_to_record(feature, matched_by="address")
            self._cache_record(cleaned, record)
            return record

        geocoded = await self._geocode_with_census(cleaned, budget=budget)
        if geocoded is None:
            return None

        street_only = self._extract_street_address(geocoded.matched_address)
        if street_only and street_only != cleaned:
            feature = await self._query_by_address(street_only, budget=budget)
            if feature is not None:
                record = self._feature_to_record(
                    feature,
                    matched_by="address",
                )
                self._cache_record(cleaned, record)
                self._cache_record(street_only, record)
                return record

        feature = await self._query_by_point(geocoded.lon, geocoded.lat, budget=budget)
        if feature is None:
            return None

        record = self._feature_to_record(feature, matched_by="geocode_point")
        self._cache_record(cleaned, record)
        return record

    async def lookup_by_point(
        self,
        *,
        lon: float,
        lat: float,
        budget: RequestBudget,
    ) -> ParcelRecord | None:
        feature = await self._query_by_point(lon, lat, budget=budget)
        if feature is None:
            return None
        record = self._feature_to_record(feature, matched_by="map_point")
        self._cache_record(None, record)
        return record

    async def query_adjacent(
        self,
        geometry: dict[str, Any] | None,
        *,
        budget: RequestBudget,
        exclude_ids: set[str],
        limit: int,
    ) -> list[ParcelRecord]:
        if not geometry:
            return []

        esri_geometry = geojson_to_esri(geometry)
        if esri_geometry is None:
            return []

        features = await self._query_county(
            {
                "where": "1=1",
                "geometry": json.dumps(esri_geometry),
                "geometryType": "esriGeometryPolygon",
                "spatialRel": self.adjacent_spatial_rel,
                "inSR": "4326",
                "outFields": self._get_outfields(),
                "returnGeometry": "true",
                "outSR": "4326",
                "resultRecordCount": str(limit),
            },
            budget=budget,
        )

        neighbors: list[ParcelRecord] = []
        for feature in features:
            record = self._feature_to_record(feature, matched_by="adjacent")
            if not record.parcel_id or record.parcel_id in exclude_ids:
                continue
            neighbors.append(record)
            self._cache_record(None, record)
        return neighbors

    async def _query_by_address(
        self,
        cleaned: str,
        *,
        budget: RequestBudget,
    ) -> dict[str, Any] | None:
        exact_where = self._get_address_where_exact(cleaned)
        features = await self._query_county(
            {
                "where": exact_where,
                "outFields": self._get_outfields(),
                "returnGeometry": "true",
                "outSR": "4326",
            },
            budget=budget,
        )
        feature = self._first_feature_with_pid(features)
        if feature is not None:
            return feature

        contains_where = self._get_address_where_contains(cleaned)
        features = await self._query_county(
            {
                "where": contains_where,
                "outFields": self._get_outfields(),
                "returnGeometry": "true",
                "outSR": "4326",
            },
            budget=budget,
        )
        return self._first_feature_with_pid(features)

    async def _query_by_point(
        self,
        lon: float,
        lat: float,
        *,
        budget: RequestBudget,
    ) -> dict[str, Any] | None:
        features = await self._query_county(
            {
                "where": "1=1",
                "geometry": f"{lon},{lat}",
                "geometryType": "esriGeometryPoint",
                "spatialRel": "esriSpatialRelIntersects",
                "inSR": "4326",
                "outFields": self._get_outfields(),
                "returnGeometry": "true",
                "outSR": "4326",
            },
            budget=budget,
        )
        return self._first_feature_with_pid(features)

    async def _query_county(
        self,
        params: dict[str, str],
        *,
        budget: RequestBudget,
    ) -> list[dict[str, Any]]:
        payload = {"f": "json", **params}
        data = await self._get_json(self.endpoint_url, payload, budget=budget)
        if "error" in data:
            message = data["error"].get("message", "ArcGIS query error")
            raise RuntimeError(f"Parcel query failed: {message}")
        return data.get("features", [])

    async def _geocode_with_census(
        self,
        address: str,
        *,
        budget: RequestBudget,
    ) -> GeocodeResult | None:
        params = {
            "address": address,
            "benchmark": "Public_AR_Current",
            "format": "json",
        }
        data = await self._get_json(CENSUS_GEOCODE_URL, params, budget=budget)
        matches = data.get("result", {}).get("addressMatches", [])
        if not matches:
            return None
        coords = matches[0].get("coordinates", {})
        x = coords.get("x")
        y = coords.get("y")
        if x is None or y is None:
            return None
        matched_address = str(matches[0].get("matchedAddress") or "").strip()
        return GeocodeResult(
            lon=float(x),
            lat=float(y),
            matched_address=matched_address,
        )

    async def _get_json(
        self,
        url: str,
        params: dict[str, str],
        *,
        budget: RequestBudget,
    ) -> dict[str, Any]:
        budget.consume()
        attempt = 0

        while True:
            await self._throttle()
            try:
                if self._external_client is not None:
                    response = await self._external_client.get(url, params=params)
                else:
                    timeout = httpx.Timeout(self._timeout_seconds)
                    async with httpx.AsyncClient(timeout=timeout) as client:
                        response = await client.get(url, params=params)

                if response.status_code == 429 or response.status_code >= 500:
                    response.raise_for_status()

                if response.status_code >= 400:
                    text = response.text[:500]
                    raise RuntimeError(
                        f"Provider returned HTTP {response.status_code}: {text}"
                    )
                return response.json()
            except (httpx.TimeoutException, httpx.NetworkError, httpx.HTTPStatusError) as exc:
                if attempt >= self._max_retries:
                    raise RuntimeError(f"Provider request failed after retries: {exc}") from exc
                await asyncio.sleep(self._retry_backoff_seconds * (2 ** attempt))
                attempt += 1

    async def _throttle(self) -> None:
        if self._min_interval_seconds <= 0:
            return

        async with self._throttle_lock:
            now = monotonic()
            elapsed = now - self._last_request_at
            wait_seconds = self._min_interval_seconds - elapsed
            if wait_seconds > 0:
                await asyncio.sleep(wait_seconds)
            self._last_request_at = monotonic()

    def _get_outfields(self) -> str:
        fields = [self.parcel_id_field, self.owner_field]
        if self.address_field:
            fields.append(self.address_field)
        fields.extend(self.extra_out_fields)
        fields.extend(self._value_fields())
        if self.value_year_field:
            fields.append(self.value_year_field)
        if self.land_use_field:
            fields.append(self.land_use_field)
        return ",".join(dict.fromkeys(fields))

    def _value_fields(self) -> list[str]:
        fields = self.value_field if isinstance(self.value_field, list) else [self.value_field]
        return [field for field in fields if field]

    def _market_value(self, attrs: dict[str, Any]) -> float | None:
        parts = [clean_amount(attrs.get(field)) for field in self._value_fields()]
        values = [part for part in parts if part is not None]
        return sum(values) if values else None

    def _market_value_year(self, attrs: dict[str, Any]) -> str:
        if not self.value_year_field:
            return ""
        year = int(clean_amount(attrs.get(self.value_year_field)) or 0)
        return str(year) if 1990 <= year <= 2100 else ""

    def _get_address_where_exact(self, cleaned: str) -> str:
        return f"UPPER({self.address_field}) = '{self._sql_escape(cleaned)}'"

    def _get_address_where_contains(self, cleaned: str) -> str:
        return f"UPPER({self.address_field}) LIKE '%{self._sql_escape(cleaned)}%'"

    def _build_address(self, attrs: dict[str, Any]) -> str:
        return str(attrs.get(self.address_field) or "").strip()

    def _feature_to_record(
        self,
        feature: dict[str, Any],
        *,
        matched_by: str,
    ) -> ParcelRecord:
        attrs = feature.get("attributes", {})
        return ParcelRecord(
            county=self.county,
            parcel_id=str(attrs.get(self.parcel_id_field) or "").strip(),
            owner_name=str(attrs.get(self.owner_field) or "").strip(),
            site_address=self._build_address(attrs),
            market_value=self._market_value(attrs),
            market_value_year=self._market_value_year(attrs),
            land_use=clean_text(attrs.get(self.land_use_field)) if self.land_use_field else "",
            geometry=esri_to_geojson(feature.get("geometry")),
            source_id=self.source_id,
            matched_by=matched_by,
        )

    def _extract_street_address(self, matched_address: str) -> str | None:
        if not matched_address:
            return None
        street_segment = matched_address.split(",", maxsplit=1)[0].strip()
        if not street_segment:
            return None
        street_segment = normalize_text(street_segment)
        street_segment = re.sub(r"\s+\d{5}(?:-\d{4})?$", "", street_segment).strip()
        return street_segment or None

    def _sql_escape(self, value: str) -> str:
        return value.replace("'", "''")

    def _first_feature_with_pid(
        self,
        features: list[dict[str, Any]],
    ) -> dict[str, Any] | None:
        for feature in features:
            attrs = feature.get("attributes", {})
            parcel_id = str(attrs.get(self.parcel_id_field) or "").strip()
            if parcel_id:
                return feature
        return None

    def _cache_record(self, normalized_address: str | None, record: ParcelRecord) -> None:
        if normalized_address:
            self._address_cache[normalized_address] = record
        if record.parcel_id:
            self._parcel_cache[record.parcel_id] = record
