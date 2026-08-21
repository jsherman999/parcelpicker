from __future__ import annotations

import re
from typing import Any

from backend.services.base import BaseParcelService, RequestBudget


# All seven metro counties are published on one MN state ArcGIS server, one
# layer each (0 Anoka, 1 Carver, 2 Dakota, 3 Hennepin, 4 Ramsey, 5 Scott,
# 6 Washington). Anoka/Hennepin/Ramsey/Scott use their own county services;
# the ones below share this statewide schema.
MN_STATE_PARCELS_FEATURESERVER = (
    "https://arcgis.metc.state.mn.us/data1/rest/services/parcels/Parcels/FeatureServer"
)


class MnStateSchemaParcelService(BaseParcelService):
    """Shared adapter for metro counties on the MN state parcel server.

    Schema: PIN / OWNER_NAME / ANUMBER (int) / ST_NAME / ST_POS_TYP /
    ST_POS_DIR / CTU_NAME / ZIP. Subclasses pin the layer index, source
    label, and a CO_NAME safety clause so a mis-routed query can never
    return another county's parcels.
    """

    co_name: str = ""
    parcel_id_field = "PIN"
    owner_field = "OWNER_NAME"
    address_field = ""
    extra_out_fields = [
        "ANUMBER",
        "ST_NAME",
        "ST_PRE_TYP",
        "ST_PRE_DIR",
        "ST_POS_TYP",
        "ST_POS_DIR",
        "CTU_NAME",
        "ZIP",
    ]
    adjacent_spatial_rel = "esriSpatialRelIntersects"

    async def _query_county(
        self,
        params: dict[str, str],
        *,
        budget: RequestBudget,
    ) -> list[dict[str, Any]]:
        if self.co_name:
            params = dict(params)
            where = params.get("where") or "1=1"
            params["where"] = (
                f"({where}) AND CO_NAME = '{self._sql_escape(self.co_name)}'"
            )
        return await super()._query_county(params, budget=budget)

    def _get_address_where_exact(self, cleaned: str) -> str:
        house_no = self._extract_house_number(cleaned)
        street_token = self._extract_street_token(cleaned)
        if street_token is None and house_no is None:
            return "1=0"
        clauses = []
        if house_no is not None:
            clauses.append(f"ANUMBER = {house_no}")
        clauses.append(f"UPPER(ST_NAME) LIKE '%{self._sql_escape(street_token)}%'")
        return " AND ".join(clauses)

    def _get_address_where_contains(self, cleaned: str) -> str:
        street_token = self._extract_street_token(cleaned)
        if not street_token:
            return "1=0"
        return f"UPPER(ST_NAME) LIKE '%{self._sql_escape(street_token)}%'"

    def _build_address(self, attrs: dict[str, Any]) -> str:
        number = self._format_int(attrs.get("ANUMBER"))
        street_name = str(attrs.get("ST_NAME") or "").strip()
        pos_type = str(attrs.get("ST_POS_TYP") or "").strip()
        pos_dir = str(attrs.get("ST_POS_DIR") or "").strip()
        city = str(attrs.get("CTU_NAME") or "").strip()
        zip_str = str(attrs.get("ZIP") or "").strip()

        parts: list[str] = []
        if number:
            parts.append(number)
        if street_name:
            parts.append(street_name)
        if pos_type:
            parts.append(pos_type)
        if pos_dir:
            parts.append(pos_dir)
        street_line = " ".join(parts)

        suffix_parts: list[str] = []
        if city:
            suffix_parts.append(city)
        else:
            suffix_parts.append("MN")
        if zip_str:
            suffix_parts.append(zip_str)
        suffix = " ".join(suffix_parts)

        if street_line and suffix:
            return f"{street_line}, {suffix}"
        return street_line or suffix

    @staticmethod
    def _format_int(value: Any) -> str:
        if value is None:
            return ""
        try:
            as_int = int(value)
        except (TypeError, ValueError):
            return str(value).strip()
        return str(as_int) if as_int > 0 else ""

    @staticmethod
    def _extract_house_number(address: str) -> int | None:
        first_part = address.split(",", maxsplit=1)[0].strip()
        match = re.match(r"^(\d+)", first_part)
        if match:
            return int(match.group(1))
        return None

    @staticmethod
    def _extract_street_token(address: str) -> str | None:
        without_house = re.sub(r"^\s*\d+\S?\s+", "", address).strip()
        if not without_house:
            return None
        first = without_house.split()[0].strip()
        return first or None


class DakotaParcelService(MnStateSchemaParcelService):

    endpoint_url = MN_STATE_PARCELS_FEATURESERVER + "/2/query"
    source_label = "dakota_county_arcgis_state"
    co_name = "Dakota"


class WashingtonParcelService(MnStateSchemaParcelService):

    endpoint_url = MN_STATE_PARCELS_FEATURESERVER + "/6/query"
    source_label = "washington_county_arcgis_state"
    co_name = "Washington"


class CarverParcelService(MnStateSchemaParcelService):
    # Verified 2026-08-21: OWNER_NAME is 100% null in the Carver layer, while
    # TAX_NAME (the taxpayer name) is populated for 47,585 of 47,886 parcels.
    owner_field = "TAX_NAME"

    endpoint_url = MN_STATE_PARCELS_FEATURESERVER + "/1/query"
    source_label = "carver_county_arcgis_state"
    co_name = "Carver"
