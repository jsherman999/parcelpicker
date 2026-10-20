"""The parcel record shared by providers, the runner, the database and the API.

A parcel is identified by (county, parcel_id): parcel IDs are only unique
within a county. A run parcel is a parcel plus its place in one lookup run
(ring_number, is_seed) and that run's owner normalization.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

# Bumped when parcel records gain fields or change meaning (3: county, value
# and land use, closed matched_by set). Runs saved before that stay in history
# but are not reused as cache hits.
RECORD_VERSION = 3

# How a parcel was matched. The data source is in source_id, not here.
MATCHED_BY = frozenset(
    {
        "address",  # the county layer's site-address fields
        "address_point",  # a county address point, then the parcel under it
        "geocode_point",  # geocoder point, then the parcel under it
        "map_point",  # a map click, then the parcel under it
        "cache_point",  # a map click inside a cached parcel's polygon
        "adjacent",  # touches a parcel of the previous adjacency ring
    }
)

# Columns of the CSV export, also the GeoJSON feature properties.
EXPORT_COLUMNS = (
    "run_id",
    "county",
    "ring_number",
    "is_seed",
    "parcel_id",
    "owner_name",
    "normalized_owner_name",
    "site_address",
    "est_market_value",
    "market_value_year",
    "land_use",
    "matched_by",
    "source_id",
)


@dataclass(slots=True)
class ParcelRecord:
    county: str
    parcel_id: str
    owner_name: str
    site_address: str
    market_value: float | None
    market_value_year: str
    land_use: str
    geometry: dict[str, Any] | None
    source_id: str
    matched_by: str


def normalize_text(value: Any) -> str:
    """Trim, collapse whitespace and uppercase (addresses, owner names)."""
    return " ".join(str(value or "").split()).upper()


def to_parcel(item: Mapping[str, Any], **overrides: Any) -> ParcelRecord:
    """Build a ParcelRecord from a mapping (a database row or API payload)."""
    data = {**item, **overrides}
    market_value = data.get("market_value")
    return ParcelRecord(
        county=str(data.get("county") or ""),
        parcel_id=str(data.get("parcel_id") or "").strip(),
        owner_name=str(data.get("owner_name") or "").strip(),
        site_address=str(data.get("site_address") or "").strip(),
        market_value=float(market_value) if market_value is not None else None,
        market_value_year=str(data.get("market_value_year") or ""),
        land_use=str(data.get("land_use") or ""),
        geometry=data.get("geometry"),
        source_id=str(data.get("source_id") or ""),
        matched_by=str(data.get("matched_by") or ""),
    )


def to_run_parcel(
    parcel: ParcelRecord,
    *,
    ring_number: int,
    is_seed: bool,
    normalized_owner_name: str,
) -> dict[str, Any]:
    """A parcel's place in a run, as the API and exports carry it."""
    return {
        "county": parcel.county,
        "parcel_id": parcel.parcel_id,
        "owner_name": parcel.owner_name,
        "normalized_owner_name": normalized_owner_name,
        "site_address": parcel.site_address,
        "market_value": parcel.market_value,
        "market_value_year": parcel.market_value_year,
        "land_use": parcel.land_use,
        "geometry": parcel.geometry,
        "source_id": parcel.source_id,
        "matched_by": parcel.matched_by,
        "ring_number": int(ring_number),
        "is_seed": bool(is_seed),
    }


def count_owners(parcels: Iterable[Mapping[str, Any]]) -> int:
    """Unique owners among run parcels, by normalized name when present."""
    keys = {
        normalize_text(p.get("normalized_owner_name") or p.get("owner_name"))
        for p in parcels
    }
    keys.discard("")
    return len(keys)


def export_row(run_id: int, parcel: Mapping[str, Any]) -> dict[str, Any]:
    """One run parcel as an export row, keyed and ordered by EXPORT_COLUMNS."""
    return {
        "run_id": run_id,
        "county": parcel.get("county"),
        "ring_number": parcel.get("ring_number"),
        "is_seed": bool(parcel.get("is_seed")),
        "parcel_id": parcel.get("parcel_id"),
        "owner_name": parcel.get("owner_name"),
        "normalized_owner_name": parcel.get("normalized_owner_name"),
        "site_address": parcel.get("site_address"),
        "est_market_value": parcel.get("market_value"),
        "market_value_year": parcel.get("market_value_year") or None,
        "land_use": parcel.get("land_use") or None,
        "matched_by": parcel.get("matched_by"),
        "source_id": parcel.get("source_id"),
    }


# ---- run input -----------------------------------------------------------

def address_input(address: str) -> dict[str, Any]:
    return {"kind": "address", "address": address}


def point_input(*, lat: float, lon: float) -> dict[str, Any]:
    return {"kind": "point", "lat": lat, "lon": lon}


def parcel_input(parcel_id: str) -> dict[str, Any]:
    return {"kind": "parcel", "parcel_id": parcel_id}


def input_label(run_input: Mapping[str, Any]) -> str:
    kind = run_input.get("kind")
    if kind == "point":
        return f"POINT({run_input['lat']:.6f}, {run_input['lon']:.6f})"
    if kind == "parcel":
        return f"PARCEL({run_input['parcel_id']})"
    return str(run_input.get("address") or "")


# ---- migration from the pre-county schema --------------------------------

_SOURCE_COUNTY = re.compile(r"^([a-z]+)_county_arcgis(?:_state)?$")


def county_from_source_id(source_id: str | None) -> str | None:
    """'dakota_county_arcgis_state' -> 'dakota'; None when it isn't one."""
    match = _SOURCE_COUNTY.match(str(source_id or ""))
    return match.group(1) if match else None


def migrate_matched_by(value: str | None) -> str:
    """Map an old open-ended matched_by string onto MATCHED_BY."""
    value = str(value or "")
    if value in MATCHED_BY:
        return value
    if value.endswith("_touches"):
        return "adjacent"
    if value == "e911_point_intersect":
        return "address_point"
    if value in ("geocode_point_intersect", "census_point_intersect"):
        return "geocode_point"
    if value == "map_click_intersect":
        return "map_point"
    if value == "local_cache_intersect":
        return "cache_point"
    if value.endswith("_address") or value.endswith("_address_from_census"):
        return "address"
    return value


def migrate_input(input_address: str | None) -> dict[str, Any]:
    """Old 'POINT(lat, lon)' / 'PARCEL(id)' / address text -> run input."""
    text = str(input_address or "")
    point = re.fullmatch(r"POINT\(\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\)", text)
    if point:
        return point_input(lat=float(point.group(1)), lon=float(point.group(2)))
    parcel = re.fullmatch(r"PARCEL\((.*)\)", text)
    if parcel:
        return parcel_input(parcel.group(1))
    return address_input(text)
