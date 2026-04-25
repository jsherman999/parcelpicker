from __future__ import annotations

import re
from typing import Any

from backend.services.base import BaseParcelService, RequestBudget


HENNEPIN_PARCEL_URL = (
    "https://gis.hennepin.us/arcgis/rest/services/"
    "HennepinData/LAND_PROPERTY/MapServer/1/query"
)
HENNEPIN_ADDRESS_POINTS_URL = (
    "https://gis.hennepin.us/arcgis/rest/services/"
    "HennepinData/LAND_PROPERTY/MapServer/0/query"
)


class HennepinParcelService(BaseParcelService):

    endpoint_url = HENNEPIN_PARCEL_URL
    source_label = "hennepin_county_arcgis"
    parcel_id_field = "PID"
    owner_field = "OWNER_NM"
    address_field = ""
    extra_out_fields = ["HOUSE_NO", "FRAC_HOUSE_NO", "STREET_NM", "MAILING_MUNIC_NM", "ZIP_CD"]

    def _get_outfields(self) -> str:
        fields = [self.parcel_id_field, self.owner_field]
        fields.extend(self.extra_out_fields)
        return ",".join(fields)

    def _build_address(self, attrs: dict[str, Any]) -> str:
        house_no = attrs.get("HOUSE_NO")
        frac_no = str(attrs.get("FRAC_HOUSE_NO") or "").strip()
        street_nm = str(attrs.get("STREET_NM") or "").strip()
        city = str(attrs.get("MAILING_MUNIC_NM") or "").strip()
        zip_cd = str(attrs.get("ZIP_CD") or "").strip()

        number_parts = []
        if house_no is not None and int(house_no) != 0:
            number_parts.append(str(int(house_no)))
        if frac_no:
            number_parts.append(frac_no)

        number = " ".join(number_parts)
        street_line = f"{number} {street_nm}".strip() if number else street_nm

        suffix_parts = []
        if city:
            suffix_parts.append(city)
        suffix_parts.append("MN")
        if zip_cd:
            suffix_parts.append(zip_cd)
        suffix = " ".join(suffix_parts)

        if street_line and suffix:
            return f"{street_line}, {suffix}"
        return street_line or suffix

    async def _query_by_address(
        self,
        cleaned: str,
        *,
        budget: RequestBudget,
    ) -> dict[str, Any] | None:
        feature = await self._query_address_points(cleaned, budget=budget)
        if feature is not None:
            return feature

        feature = await self._query_parcels_by_address(cleaned, budget=budget)
        if feature is not None:
            return feature

        return None

    async def _query_address_points(
        self,
        cleaned: str,
        *,
        budget: RequestBudget,
    ) -> dict[str, Any] | None:
        where = f"UPPER(CONCAT_AD) = '{self._sql_escape(cleaned)}'"
        features = await self._query_county_url(
            HENNEPIN_ADDRESS_POINTS_URL,
            {
                "where": where,
                "outFields": "PID,CONCAT_AD",
                "returnGeometry": "false",
                "outSR": "4326",
            },
            budget=budget,
        )
        address_feature = self._first_feature_with_pid(features)
        if address_feature is not None:
            pid = str(address_feature.get("attributes", {}).get("PID") or "").strip()
            if pid:
                return await self._query_parcel_by_pid(pid, budget=budget)

        contains_where = f"UPPER(CONCAT_AD) LIKE '%{self._sql_escape(cleaned)}%'"
        features = await self._query_county_url(
            HENNEPIN_ADDRESS_POINTS_URL,
            {
                "where": contains_where,
                "outFields": "PID,CONCAT_AD",
                "returnGeometry": "false",
                "outSR": "4326",
            },
            budget=budget,
        )
        address_feature = self._first_feature_with_pid(features)
        if address_feature is not None:
            pid = str(address_feature.get("attributes", {}).get("PID") or "").strip()
            if pid:
                return await self._query_parcel_by_pid(pid, budget=budget)

        return None

    async def _query_parcels_by_address(
        self,
        cleaned: str,
        *,
        budget: RequestBudget,
    ) -> dict[str, Any] | None:
        street_portion = self._extract_street_part(cleaned)
        if not street_portion:
            return None

        where = f"UPPER(STREET_NM) LIKE '%{self._sql_escape(street_portion)}%'"
        features = await self._query_county(
            {
                "where": where,
                "outFields": self._get_outfields(),
                "returnGeometry": "true",
                "outSR": "4326",
            },
            budget=budget,
        )

        house_no = self._extract_house_number(cleaned)
        if house_no:
            features = [f for f in features
                        if int(f.get("attributes", {}).get("HOUSE_NO") or 0) == house_no]

        return self._first_feature_with_pid(features)

    async def _query_parcel_by_pid(
        self,
        pid: str,
        *,
        budget: RequestBudget,
    ) -> dict[str, Any] | None:
        where = f"PID = '{self._sql_escape(pid)}'"
        features = await self._query_county(
            {
                "where": where,
                "outFields": self._get_outfields(),
                "returnGeometry": "true",
                "outSR": "4326",
            },
            budget=budget,
        )
        return self._first_feature_with_pid(features)

    async def _query_county_url(
        self,
        url: str,
        params: dict[str, str],
        budget: RequestBudget,
    ) -> list[dict[str, Any]]:
        payload = {"f": "json", **params}
        data = await self._get_json(url, payload, budget=budget)
        if "error" in data:
            message = data["error"].get("message", "ArcGIS query error")
            raise RuntimeError(f"Parcel query failed: {message}")
        return data.get("features", [])

    def _extract_street_part(self, address: str) -> str | None:
        street = address.split(",", maxsplit=1)[0].strip() if "," in address else address
        street = re.sub(r"^\d+\S?\s+", "", street).strip()
        return street or None

    def _extract_house_number(self, address: str) -> int | None:
        first_part = address.split(",", maxsplit=1)[0].strip()
        match = re.match(r"^(\d+)", first_part)
        if match:
            return int(match.group(1))
        return None
