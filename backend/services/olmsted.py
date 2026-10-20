from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from backend.services.base import (
    BaseParcelProvider,
    DIRECTIONAL_TOKENS,
    RequestBudget,
)
from backend.services.parcel import ParcelRecord


OLMSTED_BASE_URL = (
    "https://public.gis.olmstedcounty.gov/arcgis/rest/services/"
    "Parcels_Addressing/MapServer"
)
OLMSTED_QUERY_URL = f"{OLMSTED_BASE_URL}/3/query"
OLMSTED_E911_URL = f"{OLMSTED_BASE_URL}/0/query"

# Input street-type spellings -> the abbreviation stored in SiteStType/ST_TYPE.
STREET_TYPES = {
    "AVE": "AVE", "AV": "AVE", "AVENUE": "AVE",
    "BLVD": "BLVD", "BOULEVARD": "BLVD",
    "CIR": "CIR", "CIRCLE": "CIR",
    "CT": "CT", "COURT": "CT",
    "DR": "DR", "DRIVE": "DR",
    "HWY": "HWY", "HIGHWAY": "HWY",
    "LN": "LN", "LANE": "LN",
    "PKWY": "PKWY", "PARKWAY": "PKWY",
    "PL": "PL", "PLACE": "PL",
    "RD": "RD", "ROAD": "RD",
    "ST": "ST", "STREET": "ST",
    "TRL": "TRL", "TRAIL": "TRL",
    "WAY": "WAY",
}

# Route prefixes written before a route number ("COUNTY RD 19", "HWY 14"),
# longest spelling first. The layers keep the prefix in SitePreTyp/PRE_TYPE
# and only the number in SiteStName/ST_NAME.
ROUTE_PREFIXES = [
    (spelling.split(), kind)
    for spelling, kind in [
        ("COUNTY ROAD", "COUNTY"), ("COUNTY RD", "COUNTY"), ("CO ROAD", "COUNTY"),
        ("CO RD", "COUNTY"), ("COUNTY HIGHWAY", "COUNTY"), ("COUNTY HWY", "COUNTY"),
        ("CO HWY", "COUNTY"), ("CSAH", "COUNTY"), ("CR", "COUNTY"), ("COUNTY", "COUNTY"),
        ("US HIGHWAY", "HWY"), ("US HWY", "HWY"), ("STATE HIGHWAY", "HWY"),
        ("STATE HWY", "HWY"), ("MN HWY", "HWY"), ("HIGHWAY", "HWY"), ("HWY", "HWY"),
        ("US", "HWY"), ("TH", "HWY"),
        ("INTERSTATE", "I"), ("I", "I"),
    ]
]

# Address component fields of the parcel layer (3) and the E911 address
# point layer (0).
PARCEL_FIELDS = {
    "house_no": "SiteAddrNo", "pre_dir": "SitePreDir", "pre_type": "SitePreTyp",
    "name": "SiteStName", "type": "SiteStType", "post_dir": "SitePostDir",
    "city": "SiteCity", "zip": "SiteZip5",
}
E911_FIELDS = {
    "house_no": "ADDNO", "pre_dir": "PRE_DIR", "pre_type": "PRE_TYPE",
    "name": "ST_NAME", "type": "ST_TYPE", "post_dir": "POST_DIR",
    "city": "CITY", "zip": "ZIP5",
}

ORDINAL_RE = re.compile(r"^(\d+)(?:ST|ND|RD|TH)$")


@dataclass(slots=True)
class ParsedAddress:
    house_no: str
    name: str = ""
    pre_dir: str = ""
    route_kind: str = ""
    type: str = ""
    post_dir: str = ""
    city: str = ""
    zip: str = ""


class OlmstedParcelProvider(BaseParcelProvider):

    endpoint_url = OLMSTED_QUERY_URL
    e911_url = OLMSTED_E911_URL
    source_id = "olmsted_county_arcgis"
    parcel_id_field = "PIN"
    owner_field = "OwnerName1"
    value_field = "EMVTotal"
    land_use_field = "LandUseDes"
    # No single street field: the address is component fields, so the base
    # where builders are replaced (see below) and address_field stays empty.
    address_field = ""
    extra_out_fields = [
        "OwnerName2",
        "SiteAddrNo",
        "SitePreDir",
        "SitePreTyp",
        "SiteStName",
        "SiteStType",
        "SitePostDir",
        "SiteCity",
        "SiteZip5",
    ]
    adjacent_spatial_rel = "esriSpatialRelIntersects"

    async def _query_by_address(
        self,
        cleaned: str,
        *,
        budget: RequestBudget,
    ) -> dict[str, Any] | None:
        """Parcel site address (exact, then loose), then the E911 address point."""
        if self._parse_address(cleaned) is None:
            return None
        wheres = [
            self._get_address_where_exact(cleaned),
            self._get_address_where_contains(cleaned),
        ]
        for where in dict.fromkeys(wheres):
            features = await self._query_county(
                {
                    "where": where,
                    "outFields": self._get_outfields(),
                    "returnGeometry": "true",
                    "outSR": "4326",
                },
                budget=budget,
            )
            feature = self._first_feature_with_pid(features)
            if feature is not None:
                return feature
        return await self._query_by_e911_point(cleaned, budget=budget)

    async def _query_by_e911_point(
        self,
        cleaned: str,
        *,
        budget: RequestBudget,
    ) -> dict[str, Any] | None:
        # Many addresses (e.g. Mayo Clinic's 200 1st St SW) are E911 points on
        # a parcel whose site address is a different one, so look the point up
        # and take the parcel under it.
        where = self._address_where(self._parse_address(cleaned), E911_FIELDS, loose=False)
        data = await self._get_json(
            self.e911_url,
            {
                "f": "json",
                "where": where,
                "outFields": "ADDRESS_ID",
                "returnGeometry": "true",
                "outSR": "4326",
            },
            budget=budget,
        )
        if "error" in data:
            message = data["error"].get("message", "ArcGIS query error")
            raise RuntimeError(f"E911 address query failed: {message}")
        point = next(
            (
                f["geometry"]
                for f in data.get("features", [])
                if "x" in (f.get("geometry") or {})
            ),
            None,
        )
        if point is None:
            return None
        feature = await self._query_by_point(point["x"], point["y"], budget=budget)
        if feature is not None:
            feature["_matched_by"] = "address_point"
        return feature

    def _get_address_where_exact(self, cleaned: str) -> str:
        return self._address_where(self._parse_address(cleaned), PARCEL_FIELDS, loose=False)

    def _get_address_where_contains(self, cleaned: str) -> str:
        return self._address_where(self._parse_address(cleaned), PARCEL_FIELDS, loose=True)

    def _address_where(
        self,
        parsed: ParsedAddress | None,
        fields: dict[str, str],
        *,
        loose: bool,
    ) -> str:
        """The house number, post-directional, city/ZIP and route kind always
        apply when the input has them. Exact also pins the pre-directional,
        street type and full name; loose drops those and matches the name by
        its first word."""
        if parsed is None:
            return "1=0"

        def q(value: str) -> str:
            return f"'{self._sql_escape(value)}'"

        clauses = [f"{fields['house_no']} = {q(parsed.house_no)}"]

        if loose and not parsed.name.isdigit():
            first_word = parsed.name.split()[0]
            clauses.append(f"UPPER({fields['name']}) LIKE {q(f'%{first_word}%')}")
        else:
            clauses.append(f"UPPER({fields['name']}) = {q(parsed.name)}")

        if parsed.route_kind == "COUNTY":
            clauses.append(f"{fields['pre_type']} LIKE 'COUNTY%'")
        elif parsed.route_kind == "HWY":
            clauses.append(f"({fields['pre_type']} = 'HWY' OR {fields['type']} = 'HWY')")
        elif parsed.route_kind == "I":
            clauses.append(f"{fields['pre_type']} = 'I'")
        elif parsed.type:
            # "19th St SE" is a different road from "County Rd 19 SE". COALESCE
            # because the county's firewall rejects "IS NULL" from browsers.
            if loose:
                clauses.append(f"COALESCE({fields['pre_type']}, '') = ''")
            else:
                clauses.append(f"{fields['type']} = {q(parsed.type)}")

        if parsed.pre_dir and not loose:
            clauses.append(f"{fields['pre_dir']} = {q(parsed.pre_dir)}")
        if parsed.post_dir:
            clauses.append(f"{fields['post_dir']} = {q(parsed.post_dir)}")

        # City or ZIP: either may be off (Mayo Clinic's own 55905 vs the
        # street's 55902; a township name instead of the postal city).
        locality = []
        if parsed.city:
            locality.append(f"UPPER({fields['city']}) = {q(parsed.city)}")
        if parsed.zip:
            locality.append(f"{fields['zip']} = {q(parsed.zip)}")
        if locality:
            clauses.append(f"({' OR '.join(locality)})")

        return " AND ".join(clauses)

    def _parse_address(self, address: str) -> ParsedAddress | None:
        """"200 1ST ST SW ROCHESTER MN 55905" -> house_no "200", name "1",
        type "ST", post_dir "SW", city "ROCHESTER", zip "55905".
        "6126 COUNTY RD 19 SE" -> house_no "6126", route_kind "COUNTY",
        name "19", post_dir "SE". None without a house number and street."""
        s = " ".join(re.sub(r"[.,]", " ", str(address or "").upper()).split())
        zip_code = ""
        zip_match = re.search(r"\s(\d{5})(?:-\d{4})?$", s)
        if zip_match:
            zip_code = zip_match.group(1)
            s = s[: zip_match.start()]
        s = re.sub(r"\s(?:MN|MINNESOTA)$", "", s)
        s = re.sub(r"\s(?:(?:APT|UNIT|STE|SUITE)\s+|#\s*)[A-Z0-9-]+\b", "", s, count=1)

        tokens = s.split()
        if len(tokens) < 2 or not tokens[0].isdigit():
            return None
        parsed = ParsedAddress(house_no=tokens[0], zip=zip_code)
        n = len(tokens)
        i = 1

        if tokens[i] in {"N", "S", "E", "W"} and i + 1 < n and tokens[i + 1] not in STREET_TYPES:
            parsed.pre_dir = tokens[i]
            i += 1

        for spelling, kind in ROUTE_PREFIXES:
            end = i + len(spelling)
            route = ORDINAL_RE.sub(r"\1", tokens[end]) if end < n else ""
            if tokens[i:end] == spelling and route.isdigit():
                parsed.route_kind = kind
                parsed.name = route
                i = end + 1
                break

        if not parsed.route_kind:
            if i >= n:
                return None
            j = i + 1
            while j < n and tokens[j] not in STREET_TYPES and tokens[j] not in DIRECTIONAL_TOKENS:
                j += 1
            # Without a street type or directional the street/city boundary is
            # unknown: take one word as the street and leave the rest as the city.
            if j == n:
                j = i + 1
            # "19TH" -> "19": street names are stored without ordinal suffixes.
            parsed.name = " ".join(ORDINAL_RE.sub(r"\1", t) for t in tokens[i:j])
            i = j
        # Also after a route number ("COUNTY 137 RD SE"); the route kind then
        # stands in for the type in the WHERE clause.
        if i < n and tokens[i] in STREET_TYPES:
            parsed.type = STREET_TYPES[tokens[i]]
            i += 1

        if i < n and tokens[i] in DIRECTIONAL_TOKENS:
            parsed.post_dir = tokens[i]
            i += 1
        parsed.city = re.sub(r"^SAINT\b", "ST", " ".join(tokens[i:]))
        return parsed

    def _feature_to_record(self, feature: dict[str, Any], *, matched_by: str) -> ParcelRecord:
        record = super()._feature_to_record(
            feature, matched_by=feature.get("_matched_by") or matched_by
        )
        attrs = feature.get("attributes", {})
        second_owner = str(attrs.get("OwnerName2") or "").strip()
        if record.owner_name and second_owner:
            record.owner_name = f"{record.owner_name} & {second_owner}"
        return record

    def _build_address(self, attrs: dict[str, Any]) -> str:
        parts = [
            str(attrs.get(field) or "").strip()
            for field in (
                "SiteAddrNo",
                "SitePreDir",
                "SitePreTyp",
                "SiteStName",
                "SiteStType",
                "SitePostDir",
            )
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
