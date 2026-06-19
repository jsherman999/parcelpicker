// Browser port of backend/services/runner.py ParcelLookupRunner.
//
// Phase 2: in-browser IndexedDB cache + run history. Owner normalization still
// uses the deterministic fallback (LLM is Phase 4). The run object matches the
// shape the old /api/lookup response returned.

import { RequestBudget } from "./util.js";

const UNSET = Symbol("unset");

export class ParcelLookupRunner {
  constructor(service, settings, county, store = null, llm = null) {
    this._service = service;
    this._settings = settings;
    this._provider = service.sourceLabel;
    this._county = county;
    this._store = store;
    this._llm = llm;
  }

  async runLookup({ address, rings, useLlm = false }) {
    await this._cleanup();
    const normalizedInput = this._normalizeAlias(address);

    if (this._store) {
      const cached = await this._getCachedRunForAddress(normalizedInput, rings, address);
      if (cached) return cached;
    }

    return this._runCore({
      inputLabel: address,
      rings,
      useLlm,
      notFoundError: "No parcel match found for the provided address.",
      inputAlias: normalizedInput,
      seedResolver: (budget) => this._service.lookup(address, budget),
    });
  }

  async runLookupFromPoint({ lat, lon, rings, useLlm = false }) {
    await this._cleanup();
    const inputLabel = `POINT(${lat.toFixed(6)}, ${lon.toFixed(6)})`;

    if (this._store) {
      const localSeed = await this._resolveSeedFromLocalCache(lon, lat);
      if (localSeed && localSeed.parcel_id) {
        const cached = await this._safeRecentRun(localSeed.parcel_id, rings);
        if (cached) {
          return this._buildCachedRunResponse(cached, rings, inputLabel, localSeed.parcel_id);
        }
        return this._runCore({
          inputLabel,
          rings,
          useLlm,
          notFoundError: "No parcel found at clicked map location.",
          inputAlias: null,
          seedResolver: (budget) => this._service.lookupByPoint({ lon, lat, budget }),
          preResolvedSeed: localSeed,
        });
      }
    }

    const providerSeed = await this._service.lookupByPoint({
      lon,
      lat,
      budget: new RequestBudget(this._settings.maxRequests),
    });
    if (this._store && providerSeed && providerSeed.parcel_id) {
      const cached = await this._safeRecentRun(providerSeed.parcel_id, rings);
      if (cached) {
        return this._buildCachedRunResponse(cached, rings, inputLabel, providerSeed.parcel_id);
      }
    }

    return this._runCore({
      inputLabel,
      rings,
      useLlm,
      notFoundError: "No parcel found at clicked map location.",
      inputAlias: null,
      seedResolver: (budget) => this._service.lookupByPoint({ lon, lat, budget }),
      preResolvedSeed: providerSeed,
    });
  }

  async _runCore({
    inputLabel,
    rings,
    useLlm = false,
    notFoundError,
    inputAlias,
    seedResolver,
    preResolvedSeed = UNSET,
  }) {
    const createdAt = new Date().toISOString();
    const budget = new RequestBudget(this._settings.maxRequests);
    const llmEnabled = Boolean(useLlm && this._llm && this._llm.isAvailable);

    try {
      const seed = preResolvedSeed === UNSET ? await seedResolver(budget) : preResolvedSeed;
      if (!seed) {
        return this._buildRun({
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

      const normalizeCache = new Map();
      let llmCount = 0;
      const parcels = [];
      for (const [parcel, ring, isSeed] of parcelsWithRing) {
        let normalizedOwner = this._normalizeOwner(parcel.owner_name);
        if (llmEnabled) {
          const ownerKey = parcel.owner_name.trim();
          if (normalizeCache.has(ownerKey)) {
            normalizedOwner = normalizeCache.get(ownerKey);
          } else if (ownerKey && llmCount < this._settings.maxLlmNormalizations) {
            const candidate = await this._llm.normalizeOwnerName(ownerKey);
            normalizedOwner = candidate.trim() || normalizedOwner;
            normalizeCache.set(ownerKey, normalizedOwner);
            llmCount += 1;
          }
        }
        parcels.push({
          parcel_id: parcel.parcel_id,
          owner_name: parcel.owner_name,
          normalized_owner_name: normalizedOwner,
          site_address: parcel.site_address,
          geometry: parcel.geometry,
          source: parcel.source,
          matched_by: parcel.matched_by,
          ring_number: ring,
          is_seed: isSeed,
        });
      }

      const run = this._buildRun({
        inputLabel,
        rings,
        status,
        seedParcelId: seed.parcel_id,
        error: null,
        parcels,
        createdAt,
        llmEnabled,
      });
      run.summary = this._deterministicSummary(run);
      if (llmEnabled) {
        const llmSummary = await this._llm.summarizeLookup({
          inputAddress: inputLabel,
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

  // ---- cache helpers (port of runner.py) --------------------------------

  async _cleanup() {
    if (!this._store) return;
    try {
      await this._store.cleanupExpiredData(this._settings.retentionDays);
    } catch (err) {
      console.warn("cache cleanup failed:", err);
    }
  }

  // Best-effort cache read for a seed parcel; never throws.
  async _safeRecentRun(seedParcelId, rings) {
    if (!this._store) return null;
    try {
      return await this._store.getRecentRunForSeedParcel(
        seedParcelId,
        rings,
        this._settings.retentionDays
      );
    } catch (err) {
      console.warn("cache lookup failed:", err);
      return null;
    }
  }

  async _getCachedRunForAddress(normalizedInput, rings, inputAddress) {
    let parcelId = null;
    try {
      parcelId = await this._store.resolveAddressAlias(
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
    return this._buildCachedRunResponse(cached, rings, inputAddress, parcelId);
  }

  _buildCachedRunResponse(cachedRun, rings, inputLabel, seedParcelId) {
    const trimmed = this._trimRunToRings(cachedRun, rings);
    trimmed.input_address = inputLabel;
    trimmed.seed_parcel_id = trimmed.seed_parcel_id || seedParcelId;
    trimmed.from_cache = true;
    const base = (trimmed.summary || "").trim();
    trimmed.summary = base
      ? `${base} Loaded from 30-day local cache.`
      : "Loaded from 30-day local cache.";
    return trimmed;
  }

  _trimRunToRings(run, rings) {
    const parcels = (run.parcels || []).filter(
      (p) => (parseInt(p.ring_number, 10) || 0) <= rings
    );
    const ownerKeys = new Set();
    for (const p of parcels) {
      const key = (p.normalized_owner_name || p.owner_name || "").trim().toUpperCase();
      if (key) ownerKeys.add(key);
    }
    return {
      ...run,
      parcels,
      rings_requested: rings,
      parcel_count: parcels.length,
      owner_count: ownerKeys.size,
    };
  }

  _computeAliases(seed, inputAlias) {
    const aliases = [];
    if (inputAlias) aliases.push(inputAlias);
    const siteAlias = this._normalizeAlias(seed.site_address);
    if (siteAlias) aliases.push(siteAlias);
    return aliases;
  }

  async _resolveSeedFromLocalCache(lon, lat) {
    let candidates = [];
    try {
      candidates = await this._store.listRecentCachedParcels(this._settings.retentionDays);
    } catch (err) {
      console.warn("local cache scan failed:", err);
      return null;
    }
    for (const item of candidates) {
      if (item.geometry && this._pointInGeometry(lon, lat, item.geometry)) {
        return {
          parcel_id: String(item.parcel_id || "").trim(),
          owner_name: String(item.owner_name || "").trim(),
          site_address: String(item.site_address || "").trim(),
          geometry: item.geometry,
          source: String(item.source || "local_cache"),
          matched_by: "local_cache_intersect",
        };
      }
    }
    return null;
  }

  // ---- point-in-polygon (ray casting), port of runner.py ----------------

  _pointInGeometry(lon, lat, geometry) {
    if (!geometry || geometry.type !== "Polygon") return false;
    const coords = geometry.coordinates;
    if (!Array.isArray(coords) || !coords.length) return false;
    const outer = coords[0];
    if (!Array.isArray(outer) || !this._pointInRing(lon, lat, outer)) return false;
    for (let i = 1; i < coords.length; i += 1) {
      if (Array.isArray(coords[i]) && this._pointInRing(lon, lat, coords[i])) return false;
    }
    return true;
  }

  _pointInRing(lon, lat, ring) {
    const count = ring.length;
    if (count < 3) return false;
    let inside = false;
    let j = count - 1;
    for (let i = 0; i < count; i += 1) {
      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];
      const intersects =
        yi > lat !== yj > lat &&
        lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi;
      if (intersects) inside = !inside;
      j = i;
    }
    return inside;
  }

  // ---- run assembly + normalization -------------------------------------

  _buildRun({ inputLabel, rings, status, seedParcelId, error, parcels, createdAt, llmEnabled = false }) {
    const ownerKeys = new Set();
    for (const parcel of parcels) {
      const key = (parcel.normalized_owner_name || parcel.owner_name || "").trim().toUpperCase();
      if (key) ownerKeys.add(key);
    }
    return {
      id: null,
      input_address: inputLabel,
      rings_requested: rings,
      status,
      provider: this._provider,
      llm_enabled: llmEnabled,
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

  _normalizeAlias(address) {
    return String(address || "").trim().toUpperCase().split(/\s+/).join(" ");
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
