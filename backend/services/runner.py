from __future__ import annotations

import logging
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from time import perf_counter
from typing import Any

from backend.db import ParcelDatabase
from backend.services.base import BaseParcelProvider, BudgetExceededError, RequestBudget
from backend.services.geometry import point_in_geometry
from backend.services.llm import LLMService
from backend.services.parcel import (
    ParcelRecord,
    address_input,
    count_owners,
    input_label,
    normalize_text,
    point_input,
)


logger = logging.getLogger(__name__)
_UNSET = object()


@dataclass(slots=True)
class LookupSettings:
    max_parcels: int
    max_requests: int
    adjacent_limit_per_parcel: int
    max_llm_normalizations: int
    retention_days: int


class ParcelLookupRunner:
    def __init__(
        self,
        *,
        db: ParcelDatabase,
        provider: BaseParcelProvider,
        llm_service: LLMService,
        settings: LookupSettings,
    ) -> None:
        self._db = db
        self._provider = provider
        self._county = provider.county
        self._llm_service = llm_service
        self._settings = settings

    async def run_lookup(
        self,
        *,
        address: str,
        rings_requested: int,
        use_llm: bool,
    ) -> dict:
        self._db.cleanup_expired_data(retention_days=self._settings.retention_days)
        run_input = address_input(address)
        normalized_input = normalize_text(address)
        cached = self._get_cached_run_for_address(
            normalized_input=normalized_input,
            rings_requested=rings_requested,
            run_input=run_input,
        )
        if cached is not None:
            return cached

        return await self._run_lookup_core(
            run_input=run_input,
            rings_requested=rings_requested,
            use_llm=use_llm,
            not_found_error="No parcel match found for the provided address.",
            input_alias=normalized_input,
            seed_resolver=lambda budget: self._provider.lookup(address, budget=budget),
        )

    async def run_lookup_from_point(
        self,
        *,
        lon: float,
        lat: float,
        rings_requested: int,
        use_llm: bool,
    ) -> dict:
        self._db.cleanup_expired_data(retention_days=self._settings.retention_days)
        run_input = point_input(lat=lat, lon=lon)

        def resolve(budget: RequestBudget) -> Awaitable[ParcelRecord | None]:
            return self._provider.lookup_by_point(lon=lon, lat=lat, budget=budget)

        seed = self._resolve_seed_from_local_cache(lon=lon, lat=lat)
        if seed is None or not seed.parcel_id:
            seed = await resolve(RequestBudget(max_requests=self._settings.max_requests))

        if seed is not None and seed.parcel_id:
            cached = self._recent_run(seed.parcel_id, rings_requested)
            if cached is not None:
                return self._build_cached_run_response(
                    cached_run=cached,
                    rings_requested=rings_requested,
                    run_input=run_input,
                    seed_parcel_id=seed.parcel_id,
                )

        return await self._run_lookup_core(
            run_input=run_input,
            rings_requested=rings_requested,
            use_llm=use_llm,
            not_found_error="No parcel found at clicked map location.",
            input_alias=None,
            seed_resolver=resolve,
            pre_resolved_seed=seed,
        )

    async def _run_lookup_core(
        self,
        *,
        run_input: dict[str, Any],
        rings_requested: int,
        use_llm: bool,
        not_found_error: str,
        input_alias: str | None,
        seed_resolver: Callable[[RequestBudget], Awaitable[ParcelRecord | None]],
        pre_resolved_seed: ParcelRecord | None | object = _UNSET,
    ) -> dict:
        llm_enabled = bool(use_llm and self._llm_service.is_available)
        label = input_label(run_input)
        run_id = self._db.create_run(
            county=self._county,
            run_input=run_input,
            input_label=label,
            rings_requested=rings_requested,
            source_id=self._provider.source_id,
            llm_enabled=llm_enabled,
        )

        logger.info(
            "lookup_started run_id=%s county=%s input=%r rings=%s llm=%s",
            run_id,
            self._county,
            label,
            rings_requested,
            llm_enabled,
        )

        budget = RequestBudget(max_requests=self._settings.max_requests)
        started = perf_counter()

        try:
            if pre_resolved_seed is _UNSET:
                seed = await seed_resolver(budget)
            else:
                seed = pre_resolved_seed
            if seed is None:
                self._db.complete_run(
                    run_id,
                    status="not_found",
                    seed_parcel_id=None,
                    summary=None,
                    error=not_found_error,
                )
                not_found_run = self._must_get_run(run_id)
                not_found_run["from_cache"] = False
                return not_found_run
            if not seed.parcel_id:
                raise RuntimeError("Provider returned a parcel match without a parcel ID.")

            parcels_with_ring, capped_by = await self._expand_rings(
                seed, rings_requested=rings_requested, budget=budget
            )
            status = "capped" if capped_by else "completed"

            normalize_cache: dict[str, str] = {}
            llm_count = 0
            for parcel, ring, is_seed in parcels_with_ring:
                normalized_owner = normalize_text(parcel.owner_name)
                if llm_enabled:
                    owner_key = parcel.owner_name.strip()
                    if owner_key in normalize_cache:
                        normalized_owner = normalize_cache[owner_key]
                    elif owner_key and llm_count < self._settings.max_llm_normalizations:
                        candidate = await self._llm_service.normalize_owner_name(owner_key)
                        normalized_owner = candidate.strip() or normalized_owner
                        normalize_cache[owner_key] = normalized_owner
                        llm_count += 1

                self._db.upsert_parcel(parcel)
                self._db.add_run_parcel(
                    run_id=run_id,
                    parcel_id=parcel.parcel_id,
                    ring_number=ring,
                    is_seed=is_seed,
                    matched_by=parcel.matched_by,
                    normalized_owner_name=normalized_owner,
                )

            run = self._must_get_run(run_id)
            summary = self._deterministic_summary(run, capped_by=capped_by)
            if llm_enabled:
                llm_summary = await self._llm_service.summarize_lookup(
                    input_label=label,
                    rings_requested=rings_requested,
                    parcel_count=run["parcel_count"],
                    owner_count=run["owner_count"],
                )
                if llm_summary:
                    summary = llm_summary

            self._db.complete_run(
                run_id,
                status=status,
                capped_by=capped_by,
                seed_parcel_id=seed.parcel_id,
                summary=summary,
                error=None,
            )
            completed = self._must_get_run(run_id)
            self._upsert_aliases(seed=seed, input_alias=input_alias)
            completed["from_cache"] = False
            duration_ms = int((perf_counter() - started) * 1000)
            logger.info(
                "lookup_completed run_id=%s status=%s capped_by=%s parcels=%s owners=%s "
                "requests=%s duration_ms=%s",
                run_id,
                status,
                capped_by,
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
            failed_run = self._must_get_run(run_id)
            failed_run["from_cache"] = False
            return failed_run

    async def _expand_rings(
        self,
        seed: ParcelRecord,
        *,
        rings_requested: int,
        budget: RequestBudget,
    ) -> tuple[list[tuple[ParcelRecord, int, bool]], str | None]:
        """Breadth-first adjacency rings around the seed.

        Returns the parcels with their ring numbers and what capped the run,
        if anything: "max_parcels", or "request_budget" when the budget ran
        out mid-expansion (the parcels found so far are kept).
        """
        parcels_with_ring: list[tuple[ParcelRecord, int, bool]] = [(seed, 0, True)]
        seen_ids: set[str] = {seed.parcel_id}
        frontier = [seed]
        capped_by: str | None = None

        for ring in range(1, rings_requested + 1):
            next_frontier: list[ParcelRecord] = []
            try:
                for base_parcel in frontier:
                    neighbors = await self._provider.query_adjacent(
                        base_parcel.geometry,
                        budget=budget,
                        exclude_ids=seen_ids,
                        limit=self._settings.adjacent_limit_per_parcel,
                    )
                    for neighbor in neighbors:
                        if not neighbor.parcel_id or neighbor.parcel_id in seen_ids:
                            continue
                        seen_ids.add(neighbor.parcel_id)
                        next_frontier.append(neighbor)
                        if len(seen_ids) >= self._settings.max_parcels:
                            capped_by = "max_parcels"
                            break
                    if capped_by:
                        break
            except BudgetExceededError:
                capped_by = "request_budget"

            for parcel in next_frontier:
                parcels_with_ring.append((parcel, ring, False))
            if capped_by or not next_frontier:
                break
            frontier = next_frontier

        return parcels_with_ring, capped_by

    def _must_get_run(self, run_id: int) -> dict:
        run = self._db.get_run(run_id)
        if run is None:
            raise RuntimeError(f"Run {run_id} not found after write.")
        return run

    def _deterministic_summary(self, run: dict, *, capped_by: str | None = None) -> str:
        ring_count = max((int(p.get("ring_number", 0)) for p in run.get("parcels", [])), default=0)
        summary = (
            f"Lookup for {run['input_label']} returned {run['parcel_count']} parcels "
            f"across rings 0-{ring_count} with {run['owner_count']} unique owners."
        )
        if capped_by == "max_parcels":
            summary += " Stopped at the parcel limit."
        elif capped_by == "request_budget":
            summary += " Stopped at the request budget."
        return summary

    def _upsert_aliases(self, *, seed: ParcelRecord, input_alias: str | None) -> None:
        if not seed.parcel_id:
            return
        for alias in (input_alias, normalize_text(seed.site_address)):
            if alias:
                self._db.upsert_address_alias(self._county, alias, seed.parcel_id)

    def _recent_run(self, seed_parcel_id: str, rings_requested: int) -> dict | None:
        return self._db.get_recent_run_for_seed_parcel(
            county=self._county,
            seed_parcel_id=seed_parcel_id,
            min_rings=rings_requested,
            max_age_days=self._settings.retention_days,
        )

    def _get_cached_run_for_address(
        self,
        *,
        normalized_input: str,
        rings_requested: int,
        run_input: dict[str, Any],
    ) -> dict | None:
        parcel_id = self._db.resolve_address_alias(
            self._county,
            normalized_input,
            max_age_days=self._settings.retention_days,
        )
        if not parcel_id:
            return None

        cached = self._recent_run(parcel_id, rings_requested)
        if cached is None:
            return None

        return self._build_cached_run_response(
            cached_run=cached,
            rings_requested=rings_requested,
            run_input=run_input,
            seed_parcel_id=parcel_id,
        )

    def _build_cached_run_response(
        self,
        *,
        cached_run: dict,
        rings_requested: int,
        run_input: dict[str, Any],
        seed_parcel_id: str,
    ) -> dict:
        trimmed = self._trim_run_to_rings(cached_run, rings_requested=rings_requested)
        trimmed["input"] = run_input
        trimmed["input_label"] = input_label(run_input)
        trimmed["from_cache"] = True

        base_summary = (trimmed.get("summary") or "").strip()
        if base_summary:
            trimmed["summary"] = f"{base_summary} Loaded from 30-day local cache."
        else:
            trimmed["summary"] = "Loaded from 30-day local cache."

        logger.info(
            "lookup_cache_hit county=%s seed_parcel=%s rings=%s source_run=%s",
            self._county,
            seed_parcel_id,
            rings_requested,
            trimmed.get("id"),
        )
        return trimmed

    def _resolve_seed_from_local_cache(self, *, lon: float, lat: float) -> ParcelRecord | None:
        candidates = self._db.list_recent_cached_parcels(
            county=self._county,
            max_age_days=self._settings.retention_days,
        )
        for parcel in candidates:
            if point_in_geometry(lon, lat, parcel.geometry):
                return replace(parcel, matched_by="cache_point")
        return None

    def _trim_run_to_rings(self, run: dict, *, rings_requested: int) -> dict:
        trimmed = dict(run)
        parcels = [
            parcel
            for parcel in run.get("parcels", [])
            if int(parcel.get("ring_number", 0)) <= rings_requested
        ]
        trimmed["parcels"] = parcels
        trimmed["rings_requested"] = rings_requested
        trimmed["parcel_count"] = len(parcels)
        trimmed["owner_count"] = count_owners(parcels)
        return trimmed


def load_lookup_settings() -> LookupSettings:
    return LookupSettings(
        max_parcels=int(os.getenv("MAX_PARCELS", "150")),
        max_requests=int(os.getenv("MAX_REQUESTS_PER_RUN", "80")),
        adjacent_limit_per_parcel=int(os.getenv("ADJACENT_LIMIT_PER_PARCEL", "50")),
        max_llm_normalizations=int(os.getenv("MAX_LLM_NORMALIZATIONS", "25")),
        retention_days=int(os.getenv("RETENTION_DAYS", "30")),
    )
