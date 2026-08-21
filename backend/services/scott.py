from __future__ import annotations

import re
from typing import Any

from backend.services.base import BaseParcelService, street_prefix


SCOTT_QUERY_URL = (
    "https://services.arcgis.com/DqIh9WAsIZcPlBEF/arcgis/rest/services/"
    "Parcels/FeatureServer/0/query"
)


class ScottParcelService(BaseParcelService):

    endpoint_url = SCOTT_QUERY_URL
    source_label = "scott_county_arcgis"
    parcel_id_field = "PID"
    owner_field = "TaxPayerName"
    address_field = "PropertyAddress1"
    extra_out_fields = ["PropertyCity", "PropertyZip"]
    adjacent_spatial_rel = "esriSpatialRelIntersects"

    def _get_address_where_exact(self, cleaned: str) -> str:
        street = self._street_line(cleaned)
        if not street:
            return "1=0"
        # PropertyAddress1 is the street portion ("72 CEDAR LAKE CT"); exact
        # match against it after stripping city/state/zip from the input.
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
        # Drop a trailing city token if present; a short token is a directional.
        if (
            len(tokens) > 4
            and not tokens[-1].isdigit()
            and len(tokens[-1]) > 2
        ):
            stripped = " ".join(tokens[:-1])
        return stripped or None


    def _build_address(self, attrs: dict[str, Any]) -> str:
        # Use the structured fields (PropertyAddress1 + city + zip) rather than
        # PropertyAddress, which sometimes already embeds "CITY, MN ZIP".
        street = str(attrs.get(self.address_field) or "").strip()
        city = str(attrs.get("PropertyCity") or "").strip()
        zip_val = str(attrs.get("PropertyZip") or "").strip()

        suffix_parts: list[str] = []
        suffix_parts.append(city or "MN")
        if zip_val:
            suffix_parts.append(zip_val)
        suffix = " ".join(suffix_parts)

        if street and suffix:
            return f"{street}, {suffix}"
        return street or suffix
