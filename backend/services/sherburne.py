from __future__ import annotations

import re
from typing import Any

from backend.services.base import BaseParcelService


SHERBURNE_QUERY_URL = (
    "https://gis.co.sherburne.mn.us/arcgis/rest/services/"
    "OpenData/Parcels/FeatureServer/0/query"
)


class SherburneParcelService(BaseParcelService):

    endpoint_url = SHERBURNE_QUERY_URL
    source_label = "sherburne_county_arcgis"
    parcel_id_field = "PIN"
    owner_field = "OWNER_NAME"
    address_field = ""
    extra_out_fields = [
        "BLDG_NUM",
        "STREETNAME",
        "STREETTYPE",
        "SUFFIX_DIR",
        "UNIT_INFO",
        "CITY_MAIL",
        "ZIP",
    ]

    def _get_outfields(self) -> str:
        fields = [self.parcel_id_field, self.owner_field]
        fields.extend(self.extra_out_fields)
        return ",".join(fields)

    def _get_address_where_exact(self, cleaned: str) -> str:
        house_no = self._extract_house_number(cleaned)
        street_token = self._extract_street_token(cleaned)
        if street_token is None and house_no is None:
            return "1=0"

        clauses = []
        if house_no is not None:
            clauses.append(f"BLDG_NUM = {house_no}")
        if street_token:
            clauses.append(
                f"UPPER(STREETNAME) LIKE '%{self._sql_escape(street_token)}%'"
            )
        return " AND ".join(clauses)

    def _get_address_where_contains(self, cleaned: str) -> str:
        street_token = self._extract_street_token(cleaned)
        if not street_token:
            return "1=0"
        return f"UPPER(STREETNAME) LIKE '%{self._sql_escape(street_token)}%'"

    def _build_address(self, attrs: dict[str, Any]) -> str:
        bldg = attrs.get("BLDG_NUM")
        street_name = str(attrs.get("STREETNAME") or "").strip()
        street_type = str(attrs.get("STREETTYPE") or "").strip()
        suffix_dir = str(attrs.get("SUFFIX_DIR") or "").strip()
        unit = str(attrs.get("UNIT_INFO") or "").strip()
        city = str(attrs.get("CITY_MAIL") or "").strip()
        zip_str = self._format_zip(attrs.get("ZIP"))

        parts: list[str] = []
        if bldg is not None:
            try:
                bldg_int = int(bldg)
                if bldg_int > 0:
                    parts.append(str(bldg_int))
            except (TypeError, ValueError):
                pass
        if street_name:
            parts.append(street_name)
        if street_type:
            parts.append(street_type)
        if suffix_dir:
            parts.append(suffix_dir)
        if unit:
            parts.append(unit)
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

    def _format_zip(self, value: Any) -> str:
        if value is None:
            return ""
        try:
            return str(int(value))
        except (TypeError, ValueError):
            return str(value).strip()

    def _extract_house_number(self, address: str) -> int | None:
        match = re.match(r"^\s*(\d+)\b", address)
        if not match:
            return None
        try:
            return int(match.group(1))
        except ValueError:
            return None

    def _extract_street_token(self, address: str) -> str | None:
        without_house = re.sub(r"^\s*\d+\S?\s+", "", address).strip()
        if not without_house:
            return None
        first = without_house.split()[0].strip()
        return first or None
