from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx


WRIGHT_QUERY_URL = (
    "https://web.co.wright.mn.us/arcgisserver/rest/services/"
    "Wright_County_Parcels/MapServer/1/query"
)
CENSUS_GEOCODE_URL = (
    "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
)


@dataclass(slots=True)
class ParcelLookupResult:
    parcel_id: str
    owner_name: str
    site_address: str
    geometry: dict[str, Any] | None
    source: str
    matched_by: str


class WrightParcelService:
    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._external_client = client

    async def lookup(self, address: str) -> ParcelLookupResult | None:
        cleaned = self._normalize_address(address)
        if not cleaned:
            raise ValueError("Address must not be empty.")

        feature = await self._query_by_address(cleaned)
        if feature is not None:
            return self._feature_to_result(feature, matched_by="wright_address")

        geocoded = await self._geocode_with_census(cleaned)
        if geocoded is None:
            return None

        lon, lat = geocoded
        feature = await self._query_by_point(lon, lat)
        if feature is None:
            return None

        return self._feature_to_result(feature, matched_by="census_point_intersect")

    async def _query_by_address(self, cleaned: str) -> dict[str, Any] | None:
        exact_where = f"UPPER(PHYSADDR) = '{self._sql_escape(cleaned)}'"
        features = await self._query_wright(
            {
                "where": exact_where,
                "outFields": "PID,OWNNAME,PHYSADDR",
                "returnGeometry": "true",
                "outSR": "4326",
            }
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
            }
        )
        return features[0] if features else None

    async def _query_by_point(self, lon: float, lat: float) -> dict[str, Any] | None:
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
            }
        )
        return features[0] if features else None

    async def _query_wright(self, params: dict[str, str]) -> list[dict[str, Any]]:
        payload = {"f": "json", **params}
        data = await self._get_json(WRIGHT_QUERY_URL, payload)
        if "error" in data:
            message = data["error"].get("message", "ArcGIS query error")
            raise RuntimeError(f"Wright County parcel query failed: {message}")
        return data.get("features", [])

    async def _geocode_with_census(self, address: str) -> tuple[float, float] | None:
        params = {
            "address": address,
            "benchmark": "Public_AR_Current",
            "format": "json",
        }
        data = await self._get_json(CENSUS_GEOCODE_URL, params)
        matches = (
            data.get("result", {})
            .get("addressMatches", [])
        )
        if not matches:
            return None
        coords = matches[0].get("coordinates", {})
        x = coords.get("x")
        y = coords.get("y")
        if x is None or y is None:
            return None
        return float(x), float(y)

    async def _get_json(self, url: str, params: dict[str, str]) -> dict[str, Any]:
        if self._external_client is not None:
            response = await self._external_client.get(url, params=params)
            response.raise_for_status()
            return response.json()

        timeout = httpx.Timeout(20.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(url, params=params)
            response.raise_for_status()
            return response.json()

    def _feature_to_result(
        self,
        feature: dict[str, Any],
        *,
        matched_by: str,
    ) -> ParcelLookupResult:
        attrs = feature.get("attributes", {})
        geometry = self._geometry_to_geojson(feature.get("geometry"))

        parcel_id = str(attrs.get("PID") or "").strip()
        owner_name = str(attrs.get("OWNNAME") or "").strip()
        site_address = str(attrs.get("PHYSADDR") or "").strip()

        return ParcelLookupResult(
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

    def _normalize_address(self, address: str) -> str:
        return " ".join(address.strip().upper().split())

    def _sql_escape(self, value: str) -> str:
        return value.replace("'", "''")
