from __future__ import annotations

from typing import Any

from backend.services.base import BaseParcelService


STLOUIS_PARCEL_URL = (
    "https://gis.stlouiscountymn.gov/server2/rest/services/"
    "GeneralUse/Cadastral/MapServer/23/query"
)


class StLouisParcelService(BaseParcelService):

    endpoint_url = STLOUIS_PARCEL_URL
    source_label = "stlouis_county_arcgis"
    parcel_id_field = "PRCL_NBR"
    owner_field = "OWNAME"
    address_field = "PHYSADDR"
    extra_out_fields = ["PHYSCITY", "PHYSZIP"]

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
        suffix_parts.append("MN")
        if zip_str:
            suffix_parts.append(zip_str)
        suffix = " ".join(suffix_parts)

        if street and suffix:
            return f"{street}, {suffix}"
        return street or suffix
