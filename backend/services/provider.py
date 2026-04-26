from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(slots=True)
class RequestBudget:
    max_requests: int
    used_requests: int = 0

    def consume(self) -> None:
        self.used_requests += 1
        if self.used_requests > self.max_requests:
            raise RuntimeError(
                "Request budget exceeded while querying parcel providers. "
                "Increase MAX_REQUESTS_PER_RUN if needed."
            )


@dataclass(slots=True)
class ParcelRecord:
    parcel_id: str
    owner_name: str
    site_address: str
    geometry: dict[str, Any] | None
    source: str
    matched_by: str


@dataclass(slots=True)
class GeocodeResult:
    lon: float
    lat: float
    matched_address: str


class ParcelProvider(Protocol):
    """Protocol all county parcel providers must implement."""

    @property
    def name(self) -> str:
        """Short identifier for this county, e.g. 'wright_county_arcgis'."""
        ...

    async def lookup(
        self,
        address: str,
        *,
        budget: RequestBudget,
    ) -> ParcelRecord | None:
        """Search for a parcel by address string."""
        ...

    async def lookup_by_point(
        self,
        *,
        lon: float,
        lat: float,
        budget: RequestBudget,
    ) -> ParcelRecord | None:
        """Search for a parcel by longitude/latitude."""
        ...

    async def query_adjacent(
        self,
        geometry: dict[str, Any] | None,
        *,
        budget: RequestBudget,
        exclude_ids: set[str],
        limit: int,
    ) -> list[ParcelRecord]:
        """Return parcels that touch the given geometry (ring expansion)."""
        ...

    async def geocode_address(
        self,
        address: str,
        *,
        budget: RequestBudget,
    ) -> GeocodeResult | None:
        """Built-in geocoder for the county. Returns None if unavailable or no match."""
        ...
