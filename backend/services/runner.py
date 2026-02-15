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
        self._db.cleanup_expired_data(retention_days=self._settings.retention_days)
        normalized_input = self._normalize_address_for_alias(input_address)
        cached = self._get_cached_run_for_address(
            normalized_input=normalized_input,
            rings_requested=rings_requested,
            input_address=input_address,
        )
        if cached is not None:
            return cached

        return await self._run_lookup_core(
            input_label=input_address,
            rings_requested=rings_requested,
            use_llm=use_llm,
            not_found_error="No parcel match found for the provided address.",
            input_alias=normalized_input,
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
        self._db.cleanup_expired_data(retention_days=self._settings.retention_days)
        input_label = f"POINT({lat:.6f}, {lon:.6f})"

        local_seed = self._resolve_seed_from_local_cache(lon=lon, lat=lat)
        if local_seed is not None and local_seed.parcel_id:
            cached = self._db.get_recent_run_for_seed_parcel(
                seed_parcel_id=local_seed.parcel_id,
                min_rings=rings_requested,
                max_age_days=self._settings.retention_days,
            )
            if cached is not None:
                return self._build_cached_run_response(
                    cached_run=cached,
                    rings_requested=rings_requested,
                    input_label=input_label,
                    seed_parcel_id=local_seed.parcel_id,
                )

            return await self._run_lookup_core(
                input_label=input_label,
                rings_requested=rings_requested,
                use_llm=use_llm,
                not_found_error="No parcel found at clicked map location.",
                input_alias=None,
                seed_resolver=lambda budget: self._parcel_service.lookup_by_point(
                    lon=lon,
                    lat=lat,
                    budget=budget,
                ),
                pre_resolved_seed=local_seed,
            )

        provider_seed = await self._parcel_service.lookup_by_point(
            lon=lon,
            lat=lat,
            budget=RequestBudget(max_requests=self._settings.max_requests),
        )
        if provider_seed is not None and provider_seed.parcel_id:
            cached = self._db.get_recent_run_for_seed_parcel(
                seed_parcel_id=provider_seed.parcel_id,
                min_rings=rings_requested,
                max_age_days=self._settings.retention_days,
            )
            if cached is not None:
                return self._build_cached_run_response(
                    cached_run=cached,
                    rings_requested=rings_requested,
                    input_label=input_label,
                    seed_parcel_id=provider_seed.parcel_id,
                )

        return await self._run_lookup_core(
            input_label=input_label,
            rings_requested=rings_requested,
            use_llm=use_llm,
            not_found_error="No parcel found at clicked map location.",
            input_alias=None,
            seed_resolver=lambda budget: self._parcel_service.lookup_by_point(
                lon=lon,
                lat=lat,
                budget=budget,
            ),
            pre_resolved_seed=provider_seed,
        )

    async def _run_lookup_core(
        self,
        *,
        input_label: str,
        rings_requested: int,
        use_llm: bool,
        not_found_error: str,
        input_alias: str | None,
        seed_resolver: Callable[[RequestBudget], Awaitable[ParcelRecord | None]],
        pre_resolved_seed: ParcelRecord | None | object = _UNSET,
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
            self._upsert_aliases(seed=seed, input_alias=input_alias)
            completed["from_cache"] = False
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
            failed_run = self._must_get_run(run_id)
            failed_run["from_cache"] = False
            return failed_run

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

    def _normalize_address_for_alias(self, address: str) -> str:
        return " ".join(address.strip().upper().split())

    def _upsert_aliases(self, *, seed: ParcelRecord, input_alias: str | None) -> None:
        if not seed.parcel_id:
            return

        if input_alias:
            self._db.upsert_address_alias(input_alias, seed.parcel_id)

        site_alias = self._normalize_address_for_alias(seed.site_address)
        if site_alias:
            self._db.upsert_address_alias(site_alias, seed.parcel_id)

    def _get_cached_run_for_address(
        self,
        *,
        normalized_input: str,
        rings_requested: int,
        input_address: str,
    ) -> dict | None:
        parcel_id = self._db.resolve_address_alias(
            normalized_input,
            max_age_days=self._settings.retention_days,
        )
        if not parcel_id:
            return None

        cached = self._db.get_recent_run_for_seed_parcel(
            seed_parcel_id=parcel_id,
            min_rings=rings_requested,
            max_age_days=self._settings.retention_days,
        )
        if cached is None:
            return None

        return self._build_cached_run_response(
            cached_run=cached,
            rings_requested=rings_requested,
            input_label=input_address,
            seed_parcel_id=parcel_id,
        )

    def _build_cached_run_response(
        self,
        *,
        cached_run: dict,
        rings_requested: int,
        input_label: str,
        seed_parcel_id: str,
    ) -> dict:
        trimmed = self._trim_run_to_rings(cached_run, rings_requested=rings_requested)
        trimmed["input_address"] = input_label
        trimmed["from_cache"] = True

        base_summary = (trimmed.get("summary") or "").strip()
        if base_summary:
            trimmed["summary"] = f"{base_summary} Loaded from 30-day local cache."
        else:
            trimmed["summary"] = "Loaded from 30-day local cache."

        logger.info(
            "lookup_cache_hit seed_parcel=%s rings=%s source_run=%s",
            seed_parcel_id,
            rings_requested,
            trimmed.get("id"),
        )
        return trimmed

    def _resolve_seed_from_local_cache(self, *, lon: float, lat: float) -> ParcelRecord | None:
        candidates = self._db.list_recent_cached_parcels(max_age_days=self._settings.retention_days)
        for item in candidates:
            geometry = item.get("geometry")
            if not geometry:
                continue
            if self._point_in_geometry(lon=lon, lat=lat, geometry=geometry):
                return ParcelRecord(
                    parcel_id=str(item.get("parcel_id") or "").strip(),
                    owner_name=str(item.get("owner_name") or "").strip(),
                    site_address=str(item.get("site_address") or "").strip(),
                    geometry=geometry,
                    source=str(item.get("source") or "local_cache"),
                    matched_by="local_cache_intersect",
                )
        return None

    def _point_in_geometry(self, *, lon: float, lat: float, geometry: dict) -> bool:
        if geometry.get("type") != "Polygon":
            return False
        coords = geometry.get("coordinates")
        if not isinstance(coords, list) or not coords:
            return False
        return self._point_in_polygon(lon=lon, lat=lat, polygon_coords=coords)

    def _point_in_polygon(
        self,
        *,
        lon: float,
        lat: float,
        polygon_coords: list,
    ) -> bool:
        outer = polygon_coords[0] if polygon_coords else None
        if not isinstance(outer, list) or not self._point_in_ring(lon=lon, lat=lat, ring=outer):
            return False

        for hole in polygon_coords[1:]:
            if isinstance(hole, list) and self._point_in_ring(lon=lon, lat=lat, ring=hole):
                return False
        return True

    def _point_in_ring(self, *, lon: float, lat: float, ring: list) -> bool:
        inside = False
        count = len(ring)
        if count < 3:
            return False

        j = count - 1
        for i in range(count):
            xi, yi = ring[i][0], ring[i][1]
            xj, yj = ring[j][0], ring[j][1]
            intersects = ((yi > lat) != (yj > lat)) and (
                lon < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi
            )
            if intersects:
                inside = not inside
            j = i
        return inside

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
        trimmed["owner_count"] = len(
            {
                (parcel.get("normalized_owner_name") or parcel.get("owner_name") or "").strip().upper()
                for parcel in parcels
                if (parcel.get("normalized_owner_name") or parcel.get("owner_name"))
            }
        )
        return trimmed


def load_lookup_settings() -> LookupSettings:
    return LookupSettings(
        max_parcels=int(os.getenv("MAX_PARCELS", "150")),
        max_requests=int(os.getenv("MAX_REQUESTS_PER_RUN", "80")),
        adjacent_limit_per_parcel=int(os.getenv("ADJACENT_LIMIT_PER_PARCEL", "50")),
        max_llm_normalizations=int(os.getenv("MAX_LLM_NORMALIZATIONS", "25")),
        retention_days=int(os.getenv("RETENTION_DAYS", "30")),
    )
