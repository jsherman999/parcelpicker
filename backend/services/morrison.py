from __future__ import annotations

import re
from typing import Any

from backend.services.base import BaseParcelService, street_prefix


MORRISON_QUERY_URL = (
    "https://services1.arcgis.com/lQjrBHFnTgKBR9zX/arcgis/rest/services/"
    "Parcels/FeatureServer/0/query"
)

STREET_FIELDS = ("SitusStNo", "SitusStName", "SitusStType", "SitusPostDir")


class MorrisonParcelService(BaseParcelService):

    endpoint_url = MORRISON_QUERY_URL
    source_label = "morrison_county_arcgis"
    parcel_id_field = "PIN"
    owner_field = "Primary_Owner"
    # Single usable street string; the Situs* components are stored with the
    # literal text "NULL" on many records, so the freeform field is the
    # reliable match target ("30281 NATURE RD").
    address_field = "Situs_Freeform_Addr"
    extra_out_fields = [
        *STREET_FIELDS,
        "SitusCity",
        "SitusZip",
        "Mailing_Delivery_Addr",
        "City_Twp",
    ]
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
        # Drop a trailing city token if present; a short token is a directional.
        if (
            len(tokens) > 4
            and not tokens[-1].isdigit()
            and len(tokens[-1]) > 2
        ):
            stripped = " ".join(tokens[:-1])
        return stripped or None

    @staticmethod
    def _clean(value: Any) -> str:
        # Many records store the literal text "NULL" instead of a null.
        text = str(value or "").strip()
        return "" if text.upper() == "NULL" else text

    def _build_address(self, attrs: dict[str, Any]) -> str:
        parts = [self._clean(attrs.get(field)) for field in STREET_FIELDS]
        street = " ".join(p for p in parts if p)

        if not street:
            # Fall back to the mailing/delivery address when the Situs
            # components are empty or "NULL".
            street = self._clean(attrs.get("Mailing_Delivery_Addr"))

        city = self._clean(attrs.get("SitusCity")) or self._clean(attrs.get("City_Twp"))
        zip_val = self._clean(attrs.get("SitusZip"))

        suffix_parts: list[str] = []
        suffix_parts.append(city or "MN")
        if zip_val:
            suffix_parts.append(zip_val)
        suffix = " ".join(suffix_parts)

        if street and suffix:
            return f"{street}, {suffix}"
        return street or suffix
