from __future__ import annotations

import logging
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from time import perf_counter

from backend.db import ParcelDatabase
from backend.services.llm import LLMService
from backend.services.wright import ParcelRecord, RequestBudget, WrightParcelService


logger = logging.getLogger(__name__)


@dataclass(slots=True)
class LookupSettings:
    max_parcels: int
    max_requests: int
    adjacent_limit_per_parcel: int
    max_llm_normalizations: int


class ParcelLookupRunner:
    def __init__(
        self,
        *,
        db: ParcelDatabase,
        parcel_service: WrightParcelService,
        llm_service: LLMService,
        settings: LookupSettings,
    ) -> None:
        self._db = db
        self._parcel_service = parcel_service
        self._llm_service = llm_service
        self._settings = settings

    async def run_lookup(
        self,
        *,
        input_address: str,
        rings_requested: int,
        use_llm: bool,
    ) -> dict:
        return await self._run_lookup_core(
            input_label=input_address,
            rings_requested=rings_requested,
            use_llm=use_llm,
            not_found_error="No parcel match found for the provided address.",
            seed_resolver=lambda budget: self._parcel_service.lookup(
                input_address,
                budget=budget,
            ),
        )

    async def run_lookup_from_point(
        self,
        *,
        lon: float,
        lat: float,
        rings_requested: int,
        use_llm: bool,
    ) -> dict:
        input_label = f"POINT({lat:.6f}, {lon:.6f})"
        return await self._run_lookup_core(
            input_label=input_label,
            rings_requested=rings_requested,
            use_llm=use_llm,
            not_found_error="No parcel found at clicked map location.",
            seed_resolver=lambda budget: self._parcel_service.lookup_by_point(
                lon=lon,
                lat=lat,
                budget=budget,
            ),
        )

    async def _run_lookup_core(
        self,
        *,
        input_label: str,
        rings_requested: int,
        use_llm: bool,
        not_found_error: str,
        seed_resolver: Callable[[RequestBudget], Awaitable[ParcelRecord | None]],
    ) -> dict:
        llm_enabled = bool(use_llm and self._llm_service.is_available)
        run_id = self._db.create_run(
            input_address=input_label,
            rings_requested=rings_requested,
            provider="wright_county_arcgis",
            llm_enabled=llm_enabled,
        )

        logger.info(
            "lookup_started run_id=%s input=%r rings=%s llm=%s",
            run_id,
            input_label,
            rings_requested,
            llm_enabled,
        )

        budget = RequestBudget(max_requests=self._settings.max_requests)
        started = perf_counter()

        try:
            seed = await seed_resolver(budget)
            if seed is None:
                self._db.complete_run(
                    run_id,
                    status="not_found",
                    seed_parcel_id=None,
                    summary=None,
                    error=not_found_error,
                )
                return self._must_get_run(run_id)
            if not seed.parcel_id:
                raise RuntimeError("Provider returned a parcel match without a parcel ID.")

            parcels_with_ring: list[tuple[ParcelRecord, int, bool]] = [(seed, 0, True)]
            seen_ids: set[str] = {seed.parcel_id} if seed.parcel_id else set()

            frontier = [seed]
            status = "completed"

            for ring in range(1, rings_requested + 1):
                next_frontier: list[ParcelRecord] = []
                for base_parcel in frontier:
                    neighbors = await self._parcel_service.query_adjacent(
                        base_parcel.geometry,
                        budget=budget,
                        exclude_ids=seen_ids,
                        limit=self._settings.adjacent_limit_per_parcel,
                    )
                    for neighbor in neighbors:
                        if not neighbor.parcel_id:
                            continue
                        if neighbor.parcel_id in seen_ids:
                            continue
                        seen_ids.add(neighbor.parcel_id)
                        next_frontier.append(neighbor)
                        if len(seen_ids) >= self._settings.max_parcels:
                            status = "capped"
                            break
                    if status == "capped":
                        break
                if not next_frontier:
                    break

                deduped = {item.parcel_id: item for item in next_frontier}
                unique_next = list(deduped.values())
                for parcel in unique_next:
                    parcels_with_ring.append((parcel, ring, False))
                frontier = unique_next
                if status == "capped":
                    break

            normalize_cache: dict[str, str] = {}
            llm_count = 0
            for parcel, ring, is_seed in parcels_with_ring:
                normalized_owner = self._normalize_owner_fallback(parcel.owner_name)
                if llm_enabled:
                    owner_key = parcel.owner_name.strip()
                    if owner_key in normalize_cache:
                        normalized_owner = normalize_cache[owner_key]
                    elif owner_key and llm_count < self._settings.max_llm_normalizations:
                        candidate = await self._llm_service.normalize_owner_name(owner_key)
                        normalized_owner = candidate.strip() or normalized_owner
                        normalize_cache[owner_key] = normalized_owner
                        llm_count += 1

                self._db.upsert_parcel(
                    parcel_id=parcel.parcel_id,
                    owner_name=parcel.owner_name,
                    normalized_owner_name=normalized_owner,
                    site_address=parcel.site_address,
                    geometry=parcel.geometry,
                    source=parcel.source,
                )
                self._db.add_run_parcel(
                    run_id=run_id,
                    parcel_id=parcel.parcel_id,
                    ring_number=ring,
                    is_seed=is_seed,
                    matched_by=parcel.matched_by,
                )

            run = self._must_get_run(run_id)
            summary = self._deterministic_summary(run)
            if llm_enabled:
                llm_summary = await self._llm_service.summarize_lookup(
                    input_address=input_label,
                    rings_requested=rings_requested,
                    parcel_count=run["parcel_count"],
                    owner_count=run["owner_count"],
                )
                if llm_summary:
                    summary = llm_summary

            self._db.complete_run(
                run_id,
                status=status,
                seed_parcel_id=seed.parcel_id,
                summary=summary,
                error=None,
            )
            completed = self._must_get_run(run_id)
            duration_ms = int((perf_counter() - started) * 1000)
            logger.info(
                "lookup_completed run_id=%s status=%s parcels=%s owners=%s requests=%s duration_ms=%s",
                run_id,
                status,
                completed["parcel_count"],
                completed["owner_count"],
                budget.used_requests,
                duration_ms,
            )
            return completed

        except Exception as exc:
            self._db.complete_run(
                run_id,
                status="failed",
                seed_parcel_id=None,
                summary=None,
                error=str(exc),
            )
            logger.exception("lookup_failed run_id=%s error=%s", run_id, exc)
            return self._must_get_run(run_id)

    def _must_get_run(self, run_id: int) -> dict:
        run = self._db.get_run(run_id)
        if run is None:
            raise RuntimeError(f"Run {run_id} not found after write.")
        return run

    def _normalize_owner_fallback(self, owner: str) -> str:
        cleaned = " ".join(owner.strip().split())
        return cleaned.upper()

    def _deterministic_summary(self, run: dict) -> str:
        ring_count = 0
        for parcel in run.get("parcels", []):
            ring_count = max(ring_count, int(parcel.get("ring_number", 0)))

        return (
            f"Lookup for {run['input_address']} returned {run['parcel_count']} parcels "
            f"across rings 0-{ring_count} with {run['owner_count']} unique owners."
        )


def load_lookup_settings() -> LookupSettings:
    return LookupSettings(
        max_parcels=int(os.getenv("MAX_PARCELS", "150")),
        max_requests=int(os.getenv("MAX_REQUESTS_PER_RUN", "80")),
        adjacent_limit_per_parcel=int(os.getenv("ADJACENT_LIMIT_PER_PARCEL", "50")),
        max_llm_normalizations=int(os.getenv("MAX_LLM_NORMALIZATIONS", "25")),
    )
