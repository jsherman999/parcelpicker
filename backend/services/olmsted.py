from __future__ import annotations

import re
from typing import Any

from backend.services.base import (
    BaseParcelService,
    DIRECTIONAL_TOKENS,
    ParcelRecord,
)


OLMSTED_QUERY_URL = (
    "https://public.gis.olmstedcounty.gov/arcgis/rest/services/"
    "Parcels_Addressing/MapServer/3/query"
)


class OlmstedParcelService(BaseParcelService):

    endpoint_url = OLMSTED_QUERY_URL
    source_label = "olmsted_county_arcgis"
    parcel_id_field = "PIN"
    owner_field = "OwnerName1"
    # No single street field: the address is component fields, so the base
    # where builders are replaced (see below) and address_field stays empty.
    address_field = ""
    extra_out_fields = [
        "OwnerName2",
        "SiteAddrNo",
        "SiteStName",
        "SiteStType",
        "SitePostDir",
        "SiteCity",
        "SiteZip5",
    ]
    adjacent_spatial_rel = "esriSpatialRelIntersects"

    def _get_address_where_exact(self, cleaned: str) -> str:
        house_no, street_token = self._house_and_street(cleaned)
        if house_no and street_token:
            street_clause = (
                f"SiteStName = '{self._sql_escape(street_token)}'"
                if street_token.isdigit()
                else f"UPPER(SiteStName) LIKE '%{self._sql_escape(street_token)}%'"
            )
            return (
                f"SiteAddrNo = '{self._sql_escape(house_no)}' AND {street_clause}"
            )
        if street_token:
            return f"UPPER(SiteStName) LIKE '%{self._sql_escape(street_token)}%'"
        return "1=0"

    def _get_address_where_contains(self, cleaned: str) -> str:
        _, street_token = self._house_and_street(cleaned)
        if not street_token:
            return "1=0"
        return f"UPPER(SiteStName) LIKE '%{self._sql_escape(street_token)}%'"

    def _house_and_street(self, address: str) -> tuple[str, str | None]:
        address = re.sub(r"\s*,\s*", " ", address)
        stripped = re.sub(
            r"\s+MN\s+\d{5}(?:-\d{4})?$",
            "",
            address,
            flags=re.IGNORECASE,
        ).strip()
        tokens = stripped.split()
        if not tokens or not tokens[0].isdigit():
            return "", None
        house_no = tokens[0]
        street_token: str | None = None
        for tok in tokens[1:]:
            if tok.upper() not in DIRECTIONAL_TOKENS:
                street_token = tok
                break
        if street_token:
            # "19TH" -> "19": street names are stored without ordinal suffixes.
            street_token = re.sub(r"(\d+)(?:ST|ND|RD|TH)$", r"\1", street_token)
        return house_no, street_token

    def _feature_to_record(self, feature: dict[str, Any], *, matched_by: str) -> ParcelRecord:
        record = super()._feature_to_record(feature, matched_by=matched_by)
        attrs = feature.get("attributes", {})
        second_owner = str(attrs.get("OwnerName2") or "").strip()
        if record.owner_name and second_owner:
            record.owner_name = f"{record.owner_name} & {second_owner}"
        return record

    def _build_address(self, attrs: dict[str, Any]) -> str:
        parts = [
            str(attrs.get(field) or "").strip()
            for field in ("SiteAddrNo", "SiteStName", "SiteStType", "SitePostDir")
        ]
        street = " ".join(p for p in parts if p)
        city = str(attrs.get("SiteCity") or "").strip()
        zip_val = str(attrs.get("SiteZip5") or "").strip()

        suffix_parts: list[str] = []
        suffix_parts.append(city or "MN")
        if zip_val:
            suffix_parts.append(zip_val)
        suffix = " ".join(suffix_parts)

        if street and suffix:
            return f"{street}, {suffix}"
        return street or suffix
