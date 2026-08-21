from __future__ import annotations

import re
from typing import Any

from backend.services.base import BaseParcelService, street_prefix, ParcelRecord


BELTRAMI_QUERY_URL = (
    "https://arcgis.co.beltrami.mn.us/arcgis/rest/services/"
    "BeltramiData/BeltramiOpenData/MapServer/2/query"
)


class BeltramiParcelService(BaseParcelService):

    endpoint_url = BELTRAMI_QUERY_URL
    source_label = "beltrami_county_arcgis"
    parcel_id_field = "PIN"
    owner_field = "OWNERNAME1"
    address_field = "PROP_ADD1"
    extra_out_fields = ["OWNERNAME2", "PROP_CITY", "PROP_ZIP"]
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
        # PROP_ADD1 is street-only (with trailing spaces), so drop a trailing
        # city token if present. A short trailing token is a directional.
        if (
            len(tokens) > 4
            and not tokens[-1].isdigit()
            and len(tokens[-1]) > 2
        ):
            stripped = " ".join(tokens[:-1])
        return stripped or None


    def _feature_to_record(self, feature: dict[str, Any], *, matched_by: str) -> ParcelRecord:
        record = super()._feature_to_record(feature, matched_by=matched_by)
        attrs = feature.get("attributes", {})
        second_owner = str(attrs.get("OWNERNAME2") or "").strip()
        if record.owner_name and second_owner:
            record.owner_name = f"{record.owner_name} & {second_owner}"
        return record

    def _build_address(self, attrs: dict[str, Any]) -> str:
        street = str(attrs.get(self.address_field) or "").strip()
        city = str(attrs.get("PROP_CITY") or "").strip()
        zip_val = str(attrs.get("PROP_ZIP") or "").strip()

        suffix_parts: list[str] = []
        suffix_parts.append(city or "MN")
        if zip_val:
            suffix_parts.append(zip_val)
        suffix = " ".join(suffix_parts)

        if street and suffix:
            return f"{street}, {suffix}"
        return street or suffix
