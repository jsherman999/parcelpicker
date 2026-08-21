from __future__ import annotations

import re
from typing import Any

from backend.services.base import BaseParcelService, street_prefix


RAMSEY_QUERY_URL = (
    "https://maps.co.ramsey.mn.us/arcgis/rest/services/"
    "OpenData/OpenData/MapServer/12/query"
)


class RamseyParcelService(BaseParcelService):

    endpoint_url = RAMSEY_QUERY_URL
    source_label = "ramsey_county_arcgis"
    parcel_id_field = "ParcelID"
    owner_field = "OwnerName"
    address_field = "SiteAddress"
    extra_out_fields = ["SiteCityName", "SiteZIP5"]
    adjacent_spatial_rel = "esriSpatialRelIntersects"

    def _get_address_where_exact(self, cleaned: str) -> str:
        street = self._street_line(cleaned)
        if not street:
            return "1=0"
        return f"UPPER({self.address_field}) = '{self._sql_escape(street)}'"

    def _get_address_where_contains(self, cleaned: str) -> str:
        prefix = street_prefix(self._strip_state_zip(cleaned))
        if not prefix:
            return "1=0"
        return f"UPPER({self.address_field}) LIKE '{self._sql_escape(prefix)}%'"

    def _strip_state_zip(self, address: str) -> str:
        address = re.sub(r"\s*,\s*", " ", address)
        return re.sub(
            r"\s+MN\s+\d{5}(?:-\d{4})?$",
            "",
            address,
            flags=re.IGNORECASE,
        ).strip()

    def _street_line(self, address: str) -> str | None:
        stripped = self._strip_state_zip(address)
        tokens = stripped.split()
        # SiteAddress is street-only, so drop a trailing city token if present
        # ("2715 UPPER AFTON RD E MAPLEWOOD" -> "2715 UPPER AFTON RD E").
        # A short trailing token is a directional, not a city.
        if (
            len(tokens) > 4
            and not tokens[-1].isdigit()
            and len(tokens[-1]) > 2
        ):
            stripped = " ".join(tokens[:-1])
        return stripped or None


    def _build_address(self, attrs: dict[str, Any]) -> str:
        street = str(attrs.get(self.address_field) or "").strip()
        city = str(attrs.get("SiteCityName") or "").strip()
        zip_val = str(attrs.get("SiteZIP5") or "").strip()

        suffix_parts: list[str] = []
        suffix_parts.append(city or "MN")
        if zip_val:
            suffix_parts.append(zip_val)
        suffix = " ".join(suffix_parts)

        if street and suffix:
            return f"{street}, {suffix}"
        return street or suffix
