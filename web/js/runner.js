// Browser port of backend/services/runner.py ParcelLookupRunner.
//
// Phase 1: in-memory only. No IndexedDB cache and no LLM yet (those are
// Phase 2 and Phase 4). Owner normalization uses the deterministic fallback;
// the run object matches the shape the old /api/lookup response returned.

import { RequestBudget } from "./util.js";

let runCounter = 0;
function nextRunId() {
  runCounter += 1;
  return runCounter;
}

export class ParcelLookupRunner {
  constructor(service, settings, county) {
    this._service = service;
    this._settings = settings;
    this._provider = service.sourceLabel;
    this._county = county;
  }

  async runLookup({ address, rings, useLlm = false }) {
    return this._runCore({
      inputLabel: address,
      rings,
      useLlm,
      notFoundError: "No parcel match found for the provided address.",
      seedResolver: (budget) => this._service.lookup(address, budget),
    });
  }

  async runLookupFromPoint({ lat, lon, rings, useLlm = false }) {
    const inputLabel = `POINT(${lat.toFixed(6)}, ${lon.toFixed(6)})`;
    return this._runCore({
      inputLabel,
      rings,
      useLlm,
      notFoundError: "No parcel found at clicked map location.",
      seedResolver: (budget) => this._service.lookupByPoint({ lon, lat, budget }),
    });
  }

  async _runCore({ inputLabel, rings, notFoundError, seedResolver }) {
    const runId = nextRunId();
    const createdAt = new Date().toISOString();
    const budget = new RequestBudget(this._settings.maxRequests);

    try {
      const seed = await seedResolver(budget);
      if (!seed) {
        return this._buildRun({
          runId,
          inputLabel,
          rings,
          status: "not_found",
          seedParcelId: null,
          error: notFoundError,
          parcels: [],
          createdAt,
        });
      }
      if (!seed.parcel_id) {
        throw new Error("Provider returned a parcel match without a parcel ID.");
      }

      const parcelsWithRing = [[seed, 0, true]];
      const seen = new Set([seed.parcel_id]);
      let frontier = [seed];
      let status = "completed";

      for (let ring = 1; ring <= rings; ring += 1) {
        const next = [];
        for (const baseParcel of frontier) {
          const neighbors = await this._service.queryAdjacent(baseParcel.geometry, {
            budget,
            excludeIds: seen,
            limit: this._settings.adjacentLimitPerParcel,
          });
          for (const neighbor of neighbors) {
            if (!neighbor.parcel_id || seen.has(neighbor.parcel_id)) continue;
            seen.add(neighbor.parcel_id);
            next.push(neighbor);
            if (seen.size >= this._settings.maxParcels) {
              status = "capped";
              break;
            }
          }
          if (status === "capped") break;
        }
        if (!next.length) break;

        const deduped = new Map(next.map((item) => [item.parcel_id, item]));
        const uniqueNext = [...deduped.values()];
        for (const parcel of uniqueNext) parcelsWithRing.push([parcel, ring, false]);
        frontier = uniqueNext;
        if (status === "capped") break;
      }

      const parcels = parcelsWithRing.map(([parcel, ring, isSeed]) => ({
        parcel_id: parcel.parcel_id,
        owner_name: parcel.owner_name,
        normalized_owner_name: this._normalizeOwner(parcel.owner_name),
        site_address: parcel.site_address,
        geometry: parcel.geometry,
        source: parcel.source,
        matched_by: parcel.matched_by,
        ring_number: ring,
        is_seed: isSeed,
      }));

      const run = this._buildRun({
        runId,
        inputLabel,
        rings,
        status,
        seedParcelId: seed.parcel_id,
        error: null,
        parcels,
        createdAt,
      });
      run.summary = this._deterministicSummary(run);
      return run;
    } catch (err) {
      return this._buildRun({
        runId,
        inputLabel,
        rings,
        status: "failed",
        seedParcelId: null,
        error: String(err && err.message ? err.message : err),
        parcels: [],
        createdAt,
      });
    }
  }

  _buildRun({ runId, inputLabel, rings, status, seedParcelId, error, parcels, createdAt }) {
    const ownerKeys = new Set();
    for (const parcel of parcels) {
      const key = (parcel.normalized_owner_name || parcel.owner_name || "").trim().toUpperCase();
      if (key) ownerKeys.add(key);
    }
    return {
      id: runId,
      input_address: inputLabel,
      rings_requested: rings,
      status,
      provider: this._provider,
      llm_enabled: false,
      seed_parcel_id: seedParcelId,
      summary: null,
      error,
      created_at: createdAt,
      completed_at: new Date().toISOString(),
      parcel_count: parcels.length,
      owner_count: ownerKeys.size,
      parcels,
      from_cache: false,
    };
  }

  _normalizeOwner(owner) {
    return String(owner || "").trim().split(/\s+/).join(" ").toUpperCase();
  }

  _deterministicSummary(run) {
    let ringCount = 0;
    for (const parcel of run.parcels) {
      ringCount = Math.max(ringCount, parseInt(parcel.ring_number, 10) || 0);
    }
    return (
      `Lookup for ${run.input_address} returned ${run.parcel_count} parcels ` +
      `across rings 0-${ringCount} with ${run.owner_count} unique owners.`
    );
  }
}
