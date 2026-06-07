from __future__ import annotations

import re
from typing import Any

from backend.services.base import BaseParcelService


ANOKA_QUERY_URL = (
    "https://gisservices.co.anoka.mn.us/anoka_gis/rest/services/"
    "Parcels/FeatureServer/0/query"
)


class AnokaParcelService(BaseParcelService):

    endpoint_url = ANOKA_QUERY_URL
    source_label = "anoka_county_arcgis"
    parcel_id_field = "PIN"
    owner_field = "OWNER"
    address_field = "LOC_ADDR"
    extra_out_fields = ["LOC_CITY", "LOC_ZIP"]

    def _get_address_where_exact(self, cleaned: str) -> str:
        stripped = self._strip_state_zip(cleaned)
        if not stripped:
            return "1=0"
        return f"UPPER({self.address_field}) = '{self._sql_escape(stripped)}'"

    def _get_address_where_contains(self, cleaned: str) -> str:
        prefix = self._street_prefix(cleaned)
        if not prefix:
            return "1=0"
        return f"UPPER({self.address_field}) LIKE '{self._sql_escape(prefix)}%'"

    def _strip_state_zip(self, address: str) -> str:
        return re.sub(
            r"\s+MN\s+\d{5}(?:-\d{4})?$",
            "",
            address,
            flags=re.IGNORECASE,
        ).strip()

    def _street_prefix(self, address: str) -> str | None:
        stripped = self._strip_state_zip(address)
        tokens = stripped.split()
        if not tokens or not tokens[0].isdigit():
            return None
        # House number + up to 3 more tokens usually covers street name + type + directional,
        # which is enough to anchor a prefix match against LOC_ADDR (e.g. "23925 GERMANIUM ST NW").
        return " ".join(tokens[:4])

    def _build_address(self, attrs: dict[str, Any]) -> str:
        street = str(attrs.get(self.address_field) or "").strip()
        city = str(attrs.get("LOC_CITY") or "").strip()
        zip_val = str(attrs.get("LOC_ZIP") or "").strip()

        suffix_parts: list[str] = []
        if city:
            suffix_parts.append(city)
        else:
            suffix_parts.append("MN")
        if zip_val:
            suffix_parts.append(zip_val)
        suffix = " ".join(suffix_parts)

        if street and suffix:
            return f"{street}, {suffix}"
        return street or suffix
