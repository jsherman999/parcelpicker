from __future__ import annotations

import re
from typing import Any

from backend.services.base import BaseParcelService, street_prefix


AITKIN_QUERY_URL = (
    "https://gisweb.co.aitkin.mn.us/arcgis/rest/services/"
    "ParcelTaxData/FeatureServer/0/query"
)


class AitkinParcelService(BaseParcelService):

    endpoint_url = AITKIN_QUERY_URL
    source_label = "aitkin_county_arcgis"
    parcel_id_field = "PRCL_NBR"
    owner_field = "OWNNAME"
    address_field = "ADDR_1"
    extra_out_fields = ["ADDR_2", "Physical_Address", "Physical_City", "Physical_Zip"]
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
        # ADDR_2 is "CITY MN ZIP" and ADDR_1 is street-only; strip commas and
        # trailing state + zip (and a trailing city token) from full-address input.
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
        street = str(attrs.get(self.address_field) or "").strip()
        line2 = str(attrs.get("ADDR_2") or "").strip()
        line2 = " ".join(line2.split())  # collapse the double spaces in "MCGREGOR MN  55760"

        # ADDR_2 already includes "CITY MN ZIP", so use it verbatim as the suffix.
        if street and line2:
            return f"{street}, {line2}"
        return street or line2
