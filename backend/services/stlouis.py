from __future__ import annotations

import re
from typing import Any

from backend.services.base import BaseParcelProvider
from backend.services.parcel import normalize_text


STLOUIS_PARCEL_URL = (
    "https://gis.stlouiscountymn.gov/server2/rest/services/"
    "GeneralUse/Cadastral/MapServer/23/query"
)


class StLouisParcelProvider(BaseParcelProvider):

    endpoint_url = STLOUIS_PARCEL_URL
    source_id = "stlouis_county_arcgis"
    parcel_id_field = "PRCL_NBR"
    owner_field = "OWNAME"
    value_field = "EstTotalValue"
    value_year_field = "ASMT_YR"
    land_use_field = "TPCLS1"
    address_field = "PHYSADDR"
    extra_out_fields = ["PHYSCITY", "PHYSZIP"]

    def _get_address_where_exact(self, cleaned: str) -> str:
        street = self._extract_street_portion(cleaned)
        return f"UPPER({self.address_field}) = '{self._sql_escape(street)}'"

    def _get_address_where_contains(self, cleaned: str) -> str:
        street = self._extract_street_portion(cleaned)
        return f"UPPER({self.address_field}) LIKE '%{self._sql_escape(street)}%'"

    def _extract_street_portion(self, address: str) -> str:
        result = re.sub(
            r"\s+MN\s+\d{5}(?:-\d{4})?$",
            "",
            address,
            flags=re.IGNORECASE,
        )
        result = re.sub(r"\s+\S+$", "", result.strip())
        return normalize_text(result)

    def _build_address(self, attrs: dict[str, Any]) -> str:
        street = str(attrs.get("PHYSADDR") or "").strip()
        city = str(attrs.get("PHYSCITY") or "").strip()
        zip_val = attrs.get("PHYSZIP")

        zip_str = ""
        if zip_val is not None:
            try:
                zip_str = str(int(zip_val))
            except (ValueError, TypeError):
                zip_str = ""

        suffix_parts = []
        if city:
            suffix_parts.append(city)
        else:
            suffix_parts.append("MN")
        if zip_str:
            suffix_parts.append(zip_str)
        suffix = " ".join(suffix_parts)

        if street and suffix:
            return f"{street}, {suffix}"
        return street or suffix
