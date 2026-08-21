from __future__ import annotations

import re
from typing import Any

from backend.services.base import BaseParcelService, street_prefix


KOOCHICHING_QUERY_URL = (
    "https://services3.arcgis.com/8mdusDCY0WncdJVw/arcgis/rest/services/"
    "KoochichingCountyParcelDataPublish/FeatureServer/0/query"
)


class KoochichingParcelService(BaseParcelService):

    endpoint_url = KOOCHICHING_QUERY_URL
    source_label = "koochiching_county_arcgis"
    parcel_id_field = "PARCEL_ID"
    owner_field = "OWNNAME"
    address_field = "ADDR_1"
    extra_out_fields = ["CITY", "ZIP_CODE_5"]
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
        # ADDR_1 is street-only, so drop a trailing city token if present.
        # A short trailing token is a directional, not a city.
        if (
            len(tokens) > 4
            and not tokens[-1].isdigit()
            and len(tokens[-1]) > 2
        ):
            stripped = " ".join(tokens[:-1])
        return stripped or None


    def _format_zip(self, value: Any) -> str:
        if value is None:
            return ""
        try:
            as_int = int(value)
        except (TypeError, ValueError):
            return str(value).strip()
        return str(as_int) if as_int else ""

    def _build_address(self, attrs: dict[str, Any]) -> str:
        street = str(attrs.get(self.address_field) or "").strip()
        city = str(attrs.get("CITY") or "").strip()
        zip_str = self._format_zip(attrs.get("ZIP_CODE_5"))

        suffix_parts: list[str] = []
        if not city:
            suffix_parts.append("MN")
        elif city.upper().endswith("MN"):
            # CITY sometimes already carries the state ("INT'L FALLS, MN").
            suffix_parts.append(city)
        else:
            suffix_parts.append(city)
            suffix_parts.append("MN")
        if zip_str:
            suffix_parts.append(zip_str)
        suffix = " ".join(suffix_parts)

        if street and suffix:
            return f"{street}, {suffix}"
        return street or suffix
