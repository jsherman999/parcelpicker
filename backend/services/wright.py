from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from time import monotonic
from typing import Any

import httpx


WRIGHT_QUERY_URL = (
    "https://web.co.wright.mn.us/arcgisserver/rest/services/"
    "Wright_County_Parcels/MapServer/1/query"
)
CENSUS_GEOCODE_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"


@dataclass(slots=True)
class RequestBudget:
    max_requests: int
    used_requests: int = 0

    def consume(self) -> None:
        self.used_requests += 1
        if self.used_requests > self.max_requests:
            raise RuntimeError(
                "Request budget exceeded while querying parcel providers. "
                "Increase MAX_REQUESTS_PER_RUN if needed."
            )


@dataclass(slots=True)
class ParcelRecord:
    parcel_id: str
    owner_name: str
    site_address: str
    geometry: dict[str, Any] | None
    source: str
    matched_by: str


class WrightParcelService:
    def __init__(
        self,
        *,
        client: httpx.AsyncClient | None = None,
        timeout_seconds: float = 20.0,
        max_retries: int = 2,
        retry_backoff_seconds: float = 0.8,
        min_interval_seconds: float = 0.15,
    ) -> None:
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
        cleaned = self._normalize_address(address)
        if not cleaned:
            raise ValueError("Address must not be empty.")

        cached = self._address_cache.get(cleaned)
        if cached is not None:
            return cached

        feature = await self._query_by_address(cleaned, budget=budget)
        if feature is not None:
            record = self._feature_to_record(feature, matched_by="wright_address")
            self._cache_record(cleaned, record)
            return record

        geocoded = await self._geocode_with_census(cleaned, budget=budget)
        if geocoded is None:
            return None

        lon, lat = geocoded
        feature = await self._query_by_point(lon, lat, budget=budget)
        if feature is None:
            return None

        record = self._feature_to_record(feature, matched_by="census_point_intersect")
        self._cache_record(cleaned, record)
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

        esri_geometry = self._to_esri_polygon(geometry)
        if esri_geometry is None:
            return []

        features = await self._query_wright(
            {
                "where": "1=1",
                "geometry": json.dumps(esri_geometry),
                "geometryType": "esriGeometryPolygon",
                "spatialRel": "esriSpatialRelTouches",
                "inSR": "4326",
                "outFields": "PID,OWNNAME,PHYSADDR",
                "returnGeometry": "true",
                "outSR": "4326",
                "resultRecordCount": str(limit),
            },
            budget=budget,
        )

        neighbors: list[ParcelRecord] = []
        for feature in features:
            record = self._feature_to_record(feature, matched_by="wright_touches")
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
        exact_where = f"UPPER(PHYSADDR) = '{self._sql_escape(cleaned)}'"
        features = await self._query_wright(
            {
                "where": exact_where,
                "outFields": "PID,OWNNAME,PHYSADDR",
                "returnGeometry": "true",
                "outSR": "4326",
            },
            budget=budget,
        )
        if features:
            return features[0]

        contains_where = f"UPPER(PHYSADDR) LIKE '%{self._sql_escape(cleaned)}%'"
        features = await self._query_wright(
            {
                "where": contains_where,
                "outFields": "PID,OWNNAME,PHYSADDR",
                "returnGeometry": "true",
                "outSR": "4326",
            },
            budget=budget,
        )
        return features[0] if features else None

    async def _query_by_point(
        self,
        lon: float,
        lat: float,
        *,
        budget: RequestBudget,
    ) -> dict[str, Any] | None:
        features = await self._query_wright(
            {
                "where": "1=1",
                "geometry": f"{lon},{lat}",
                "geometryType": "esriGeometryPoint",
                "spatialRel": "esriSpatialRelIntersects",
                "inSR": "4326",
                "outFields": "PID,OWNNAME,PHYSADDR",
                "returnGeometry": "true",
                "outSR": "4326",
            },
            budget=budget,
        )
        return features[0] if features else None

    async def _query_wright(
        self,
        params: dict[str, str],
        *,
        budget: RequestBudget,
    ) -> list[dict[str, Any]]:
        payload = {"f": "json", **params}
        data = await self._get_json(WRIGHT_QUERY_URL, payload, budget=budget)
        if "error" in data:
            message = data["error"].get("message", "ArcGIS query error")
            raise RuntimeError(f"Wright County parcel query failed: {message}")
        return data.get("features", [])

    async def _geocode_with_census(
        self,
        address: str,
        *,
        budget: RequestBudget,
    ) -> tuple[float, float] | None:
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
        return float(x), float(y)

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

    def _feature_to_record(
        self,
        feature: dict[str, Any],
        *,
        matched_by: str,
    ) -> ParcelRecord:
        attrs = feature.get("attributes", {})
        geometry = self._geometry_to_geojson(feature.get("geometry"))

        parcel_id = str(attrs.get("PID") or "").strip()
        owner_name = str(attrs.get("OWNNAME") or "").strip()
        site_address = str(attrs.get("PHYSADDR") or "").strip()

        return ParcelRecord(
            parcel_id=parcel_id,
            owner_name=owner_name,
            site_address=site_address,
            geometry=geometry,
            source="wright_county_arcgis",
            matched_by=matched_by,
        )

    def _geometry_to_geojson(self, geometry: dict[str, Any] | None) -> dict[str, Any] | None:
        if not geometry:
            return None

        if "rings" in geometry:
            return {"type": "Polygon", "coordinates": geometry["rings"]}

        if "x" in geometry and "y" in geometry:
            return {"type": "Point", "coordinates": [geometry["x"], geometry["y"]]}

        return None

    def _to_esri_polygon(self, geojson_geometry: dict[str, Any]) -> dict[str, Any] | None:
        geo_type = geojson_geometry.get("type")
        if geo_type != "Polygon":
            return None
        rings = geojson_geometry.get("coordinates")
        if not isinstance(rings, list):
            return None
        return {
            "rings": rings,
            "spatialReference": {"wkid": 4326},
        }

    def _normalize_address(self, address: str) -> str:
        return " ".join(address.strip().upper().split())

    def _sql_escape(self, value: str) -> str:
        return value.replace("'", "''")

    def _cache_record(self, normalized_address: str | None, record: ParcelRecord) -> None:
        if normalized_address:
            self._address_cache[normalized_address] = record
        if record.parcel_id:
            self._parcel_cache[record.parcel_id] = record
