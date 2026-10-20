// Browser port of backend/services/runner.py ParcelLookupRunner.
//
// One runner per county. A run resolves a seed parcel (from an address, a map
// point or an already-selected parcel) and expands adjacency rings around it.
// The IndexedDB store caches runs; every cache read is scoped to this county.

import { BudgetExceededError, RequestBudget } from "./util.js";
import { pointInGeometry } from "./geometry.js";
import {
  CAPPED_BY,
  MATCHED_BY,
  RUN_STATUS,
  addressInput,
  normalizeText,
  parcelInput,
  pointInput,
  toParcel,
  toRun,
  toRunParcel,
} from "./model.js";

const UNSET = Symbol("unset");

export class ParcelLookupRunner {
  constructor(provider, settings, store = null, llm = null) {
    this._provider = provider;
    this._settings = settings;
    this._county = provider.county;
    this._store = store;
    this._llm = llm;
  }

  async runLookup({ address, rings, useLlm = false }) {
    await this._cleanup();
    const normalizedInput = normalizeText(address);
    const input = addressInput(address);

    if (this._store) {
      const cached = await this._getCachedRunForAddress(normalizedInput, rings, input);
      if (cached) return cached;
    }

    return this._runCore({
      input,
      rings,
      useLlm,
      notFoundError: "No parcel match found for the provided address.",
      inputAlias: normalizedInput,
      seedResolver: (budget) => this._provider.lookup(address, budget),
    });
  }

  async runLookupFromPoint({ lat, lon, rings, useLlm = false }) {
    await this._cleanup();
    const input = pointInput(lat, lon);
    const notFoundError = "No parcel found at clicked map location.";
    const seedResolver = (budget) => this._provider.lookupByPoint({ lon, lat, budget });

    if (this._store) {
      const localSeed = await this._resolveSeedFromLocalCache(lon, lat);
      if (localSeed && localSeed.parcel_id) {
        const cached = await this._safeRecentRun(localSeed.parcel_id, rings);
        if (cached) return this._buildCachedRunResponse(cached, rings, input, localSeed.parcel_id);
        return this._runCore({ input, rings, useLlm, notFoundError, seedResolver, preResolvedSeed: localSeed });
      }
    }

    const providerSeed = await this._provider.lookupByPoint({
      lon,
      lat,
      budget: new RequestBudget(this._settings.maxRequests),
    });
    if (this._store && providerSeed && providerSeed.parcel_id) {
      const cached = await this._safeRecentRun(providerSeed.parcel_id, rings);
      if (cached) return this._buildCachedRunResponse(cached, rings, input, providerSeed.parcel_id);
    }

    return this._runCore({ input, rings, useLlm, notFoundError, seedResolver, preResolvedSeed: providerSeed });
  }

  // Resolve a single parcel at a point without expanding rings. Returns a
  // run parcel (ring 0, seed) so the UI can accumulate map clicks without
  // triggering any neighbor lookup.
  async lookupSeedByPoint({ lat, lon }) {
    let record = null;
    if (this._store) {
      try {
        record = await this._resolveSeedFromLocalCache(lon, lat);
      } catch (err) {
        console.warn("local cache seed lookup failed:", err);
      }
    }
    if (!record || !record.parcel_id) {
      record = await this._provider.lookupByPoint({
        lon,
        lat,
        budget: new RequestBudget(this._settings.maxRequests),
      });
    }
    if (!record || !record.parcel_id) return null;
    return toRunParcel(record, { ring_number: 0, is_seed: true });
  }

  // Expand rings from an already-resolved seed parcel (explicit user action).
  async runLookupFromSeed({ seedParcel, rings, useLlm = false }) {
    await this._cleanup();
    const input = parcelInput(seedParcel.parcel_id || "");
    if (this._store && seedParcel.parcel_id) {
      const cached = await this._safeRecentRun(seedParcel.parcel_id, rings);
      if (cached) return this._buildCachedRunResponse(cached, rings, input, seedParcel.parcel_id);
    }
    return this._runCore({
      input,
      rings,
      useLlm,
      notFoundError: "No parcel found for this seed.",
      seedResolver: () => Promise.resolve(seedParcel),
      preResolvedSeed: seedParcel,
    });
  }

  async _runCore({ input, rings, useLlm = false, notFoundError, inputAlias = null, seedResolver, preResolvedSeed = UNSET }) {
    const createdAt = new Date().toISOString();
    const budget = new RequestBudget(this._settings.maxRequests);
    const llmEnabled = Boolean(useLlm && this._llm && this._llm.isAvailable);
    const base = { input, rings_requested: rings, created_at: createdAt };

    try {
      const seed = preResolvedSeed === UNSET ? await seedResolver(budget) : preResolvedSeed;
      if (!seed) {
        return this._buildRun({ ...base, status: RUN_STATUS.NOT_FOUND, error: notFoundError });
      }
      if (!seed.parcel_id) {
        throw new Error("Provider returned a parcel match without a parcel ID.");
      }

      const { found, cappedBy } = await this._expandRings(seed, rings, budget);
      const parcels = await this._normalizeOwners(found, llmEnabled);

      const run = this._buildRun(
        {
          ...base,
          status: cappedBy ? RUN_STATUS.CAPPED : RUN_STATUS.COMPLETED,
          capped_by: cappedBy,
          seed_parcel_id: seed.parcel_id,
          llm_enabled: llmEnabled,
        },
        parcels
      );
      run.summary = this._deterministicSummary(run);
      if (llmEnabled) {
        const llmSummary = await this._llm.summarizeLookup({
          inputLabel: run.input_label,
          ringsRequested: rings,
          parcelCount: run.parcel_count,
          ownerCount: run.owner_count,
        });
        if (llmSummary) run.summary = llmSummary;
      }

      // Persistence is best-effort: a cache-write failure must not turn a
      // successful lookup into a failed run.
      if (this._store) {
        try {
          const aliases = this._computeAliases(seed, inputAlias);
          run.id = await this._store.saveRun(run, aliases);
        } catch (err) {
          console.warn("cache save failed:", err);
        }
      }
      return run;
    } catch (err) {
      return this._buildRun({
        ...base,
        status: RUN_STATUS.FAILED,
        error: String(err && err.message ? err.message : err),
      });
    }
  }

  // Breadth-first adjacency expansion. Returns [{parcel, ring, isSeed}] and,
  // when a limit stopped it early, which one. Running out of request budget
  // keeps what was found, like reaching maxParcels.
  async _expandRings(seed, rings, budget) {
    const found = [{ parcel: seed, ring: 0, isSeed: true }];
    const seen = new Set([seed.parcel_id]);
    let frontier = [seed];
    let cappedBy = null;

    for (let ring = 1; ring <= rings && !cappedBy; ring += 1) {
      const next = [];
      for (const baseParcel of frontier) {
        let neighbors;
        try {
          neighbors = await this._provider.queryAdjacent(baseParcel.geometry, {
            budget,
            excludeIds: seen,
            limit: this._settings.adjacentLimitPerParcel,
          });
        } catch (err) {
          if (!(err instanceof BudgetExceededError)) throw err;
          cappedBy = CAPPED_BY.REQUEST_BUDGET;
          break;
        }
        for (const neighbor of neighbors) {
          if (!neighbor.parcel_id || seen.has(neighbor.parcel_id)) continue;
          seen.add(neighbor.parcel_id);
          next.push(neighbor);
          if (seen.size >= this._settings.maxParcels) {
            cappedBy = CAPPED_BY.MAX_PARCELS;
            break;
          }
        }
        if (cappedBy) break;
      }
      for (const parcel of next) found.push({ parcel, ring, isSeed: false });
      if (!next.length) break;
      frontier = next;
    }
    return { found, cappedBy };
  }

  // Run parcels with normalized owners: the deterministic normalization, or
  // the LLM's (up to maxLlmNormalizations distinct owners) when enabled.
  async _normalizeOwners(found, llmEnabled) {
    const llmCache = new Map();
    const parcels = [];
    for (const { parcel, ring, isSeed } of found) {
      let normalizedOwner = normalizeText(parcel.owner_name);
      const ownerKey = String(parcel.owner_name || "").trim();
      if (llmEnabled && ownerKey) {
        if (llmCache.has(ownerKey)) {
          normalizedOwner = llmCache.get(ownerKey);
        } else if (llmCache.size < this._settings.maxLlmNormalizations) {
          const candidate = await this._llm.normalizeOwnerName(ownerKey);
          normalizedOwner = candidate.trim() || normalizedOwner;
          llmCache.set(ownerKey, normalizedOwner);
        }
      }
      parcels.push(
        toRunParcel(parcel, { ring_number: ring, is_seed: isSeed, normalized_owner_name: normalizedOwner })
      );
    }
    return parcels;
  }

  // ---- cache helpers (port of runner.py) --------------------------------

  async _cleanup() {
    if (!this._store) return;
    try {
      await this._store.cleanupExpiredData(this._settings.retentionDays);
    } catch (err) {
      console.warn("cache cleanup failed:", err);
    }
  }

  // Best-effort cache read for a seed parcel in this county; never throws.
  async _safeRecentRun(seedParcelId, rings) {
    if (!this._store) return null;
    try {
      return await this._store.getRecentRunForSeedParcel(
        this._county,
        seedParcelId,
        rings,
        this._settings.retentionDays
      );
    } catch (err) {
      console.warn("cache lookup failed:", err);
      return null;
    }
  }

  async _getCachedRunForAddress(normalizedInput, rings, input) {
    let parcelId = null;
    try {
      parcelId = await this._store.resolveAddressAlias(
        this._county,
        normalizedInput,
        this._settings.retentionDays
      );
    } catch (err) {
      console.warn("alias lookup failed:", err);
      return null;
    }
    if (!parcelId) return null;
    const cached = await this._safeRecentRun(parcelId, rings);
    if (!cached) return null;
    return this._buildCachedRunResponse(cached, rings, input, parcelId);
  }

  // A cached run trimmed to the requested rings, relabeled with this input.
  _buildCachedRunResponse(cachedRun, rings, input, seedParcelId) {
    const parcels = cachedRun.parcels.filter((p) => (parseInt(p.ring_number, 10) || 0) <= rings);
    const base = (cachedRun.summary || "").trim();
    return toRun(
      {
        ...cachedRun,
        input,
        input_label: undefined,
        rings_requested: rings,
        seed_parcel_id: cachedRun.seed_parcel_id || seedParcelId,
        summary: base ? `${base} Loaded from 30-day local cache.` : "Loaded from 30-day local cache.",
        from_cache: true,
      },
      parcels
    );
  }

  _computeAliases(seed, inputAlias) {
    const aliases = [];
    if (inputAlias) aliases.push(inputAlias);
    const siteAlias = normalizeText(seed.site_address);
    if (siteAlias) aliases.push(siteAlias);
    return aliases;
  }

  async _resolveSeedFromLocalCache(lon, lat) {
    let candidates = [];
    try {
      candidates = await this._store.listRecentCachedParcels(this._county, this._settings.retentionDays);
    } catch (err) {
      console.warn("local cache scan failed:", err);
      return null;
    }
    const hit = candidates.find((item) => item.geometry && pointInGeometry(lon, lat, item.geometry));
    return hit ? toParcel(hit, { matched_by: MATCHED_BY.CACHE_POINT }) : null;
  }

  // ---- run assembly ------------------------------------------------------

  _buildRun(fields, parcels = []) {
    return toRun(
      {
        county: this._county,
        source_id: this._provider.sourceId,
        completed_at: new Date().toISOString(),
        ...fields,
      },
      parcels
    );
  }

  _deterministicSummary(run) {
    let ringCount = 0;
    for (const parcel of run.parcels) {
      ringCount = Math.max(ringCount, parseInt(parcel.ring_number, 10) || 0);
    }
    const capped =
      run.capped_by === CAPPED_BY.REQUEST_BUDGET
        ? " Stopped early: request budget used up."
        : run.capped_by === CAPPED_BY.MAX_PARCELS
          ? " Stopped early: parcel limit reached."
          : "";
    return (
      `Lookup for ${run.input_label} returned ${run.parcel_count} parcels ` +
      `across rings 0-${ringCount} with ${run.owner_count} unique owners.${capped}`
    );
  }
}
