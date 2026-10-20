// Browser port of backend/db.py ParcelDatabase, backed by IndexedDB.
// SQLite tables -> object stores; datetime cutoffs -> epoch-ms comparisons.
//
// Parcel IDs are unique only within a county, so parcels and address aliases
// are keyed by [county, ...] and every cache lookup is scoped to a county.

import { MATCHED_BY, RUN_STATUS, CAPPED_BY, inputLabel, toParcel, toRun, toRunParcel } from "./model.js";

const DB_NAME = "parcelpicker";
// 2: county-scoped keys, run input as a tagged union, source_id, matched_by
// as a closed set. Version 1 databases are migrated in place.
const DB_VERSION = 2;
const DAY_MS = 86400000;
const CACHEABLE = new Set([RUN_STATUS.COMPLETED, RUN_STATUS.CAPPED]);
// Bumped when parcel records change (2: market value + land use; 3: county
// identity). Runs saved by older versions stay in history but are not reused
// as cache hits, so their parcels get re-fetched.
const RECORD_VERSION = 3;

function reusable(run, cutoff) {
  return CACHEABLE.has(run.status) && run.created_at >= cutoff && (run.record_version || 1) >= RECORD_VERSION;
}

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function createParcelStores(db) {
  const parcels = db.createObjectStore("parcels", { keyPath: ["county", "parcel_id"] });
  parcels.createIndex("updated_at", "updated_at", { unique: false });

  const runParcels = db.createObjectStore("run_parcels", { keyPath: ["run_id", "parcel_id"] });
  runParcels.createIndex("run_id", "run_id", { unique: false });

  db.createObjectStore("address_aliases", { keyPath: ["county", "normalized_address"] });
}

function createStores(db) {
  const runs = db.createObjectStore("runs", { keyPath: "id", autoIncrement: true });
  runs.createIndex("county_seed", ["county", "seed_parcel_id"], { unique: false });
  runs.createIndex("created_at", "created_at", { unique: false });
  createParcelStores(db);
}

// ---- version 1 -> 2 migration --------------------------------------------

// "wright_county_arcgis" / "dakota_county_arcgis_state" -> "wright" / "dakota".
function countyFromSourceId(sourceId) {
  const m = String(sourceId || "").match(/^(.+?)_county_arcgis(?:_state)?$/);
  return m ? m[1] : null;
}

// Version 1 runs kept the input as text: an address, "POINT(lat, lon)" or
// "PARCEL(id)".
function inputFromV1(text) {
  const s = String(text || "");
  const point = s.match(/^POINT\((-?[\d.]+),\s*(-?[\d.]+)\)$/);
  if (point) return { kind: "point", lat: Number(point[1]), lon: Number(point[2]) };
  const parcel = s.match(/^PARCEL\((.*)\)$/);
  if (parcel) return { kind: "parcel", parcel_id: parcel[1] };
  return { kind: "address", address: s };
}

function matchedByFromV1(value) {
  const s = String(value || "");
  if (s.endsWith("_touches")) return MATCHED_BY.ADJACENT;
  if (s.endsWith("_address")) return MATCHED_BY.ADDRESS;
  return (
    {
      geocode_point_intersect: MATCHED_BY.GEOCODE_POINT,
      map_click_intersect: MATCHED_BY.MAP_POINT,
      local_cache_intersect: MATCHED_BY.CACHE_POINT,
      e911_point_intersect: MATCHED_BY.ADDRESS_POINT,
    }[s] || s
  );
}

// Runs and parcels are carried over with their county taken from the source
// label; anything without one is dropped. Address aliases are only a cache
// and are dropped. Migrated runs keep their old record_version, so they stay
// in history but are never reused as cache hits.
function migrateV1(db, tx) {
  const old = {};
  const names = ["runs", "parcels", "run_parcels"];
  let pending = names.length;
  for (const name of names) {
    const request = tx.objectStore(name).getAll();
    request.onsuccess = () => {
      old[name] = request.result;
      pending -= 1;
      if (pending === 0) rebuild();
    };
  }

  function rebuild() {
    const runCounty = new Map();
    const runs = tx.objectStore("runs");
    runs.deleteIndex("seed_parcel_id");
    runs.createIndex("county_seed", ["county", "seed_parcel_id"], { unique: false });
    for (const r of old.runs) {
      const county = countyFromSourceId(r.provider);
      if (!county) {
        runs.delete(r.id);
        continue;
      }
      runCounty.set(r.id, county);
      const input = inputFromV1(r.input_address);
      const { input_address, provider, ...rest } = r;
      runs.put({
        ...rest,
        county,
        input,
        input_label: inputLabel(input),
        source_id: provider,
        capped_by: r.status === RUN_STATUS.CAPPED ? CAPPED_BY.MAX_PARCELS : null,
      });
    }

    db.deleteObjectStore("parcels");
    db.deleteObjectStore("run_parcels");
    db.deleteObjectStore("address_aliases");
    createParcelStores(db);

    const parcels = tx.objectStore("parcels");
    const ownerByParcel = new Map();
    for (const p of old.parcels) {
      const county = countyFromSourceId(p.source);
      if (!county) continue;
      ownerByParcel.set(`${county}\u0000${p.parcel_id}`, p.normalized_owner_name);
      parcels.put({
        ...storedParcel(toParcel({ ...p, county, source_id: p.source })),
        updated_at: p.updated_at,
      });
    }

    const runParcels = tx.objectStore("run_parcels");
    for (const rp of old.run_parcels) {
      const county = runCounty.get(rp.run_id);
      if (!county) continue;
      runParcels.put({
        ...rp,
        matched_by: matchedByFromV1(rp.matched_by),
        normalized_owner_name: ownerByParcel.get(`${county}\u0000${rp.parcel_id}`) || "",
      });
    }
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (event.oldVersion < 1) createStores(db);
      else if (event.oldVersion < 2) migrateV1(db, request.transaction);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---- record shapes ---------------------------------------------------------

// A parcel as the parcels store keeps it. How it was matched belongs to a
// run, so matched_by lives in run_parcels.
function storedParcel(parcel) {
  const { matched_by, ...rest } = parcel;
  return rest;
}

// Unique string key for a county-scoped parcel.
const parcelKey = (county, parcelId) => `${county}\u0000${parcelId}`;

export class ParcelStore {
  constructor(db) {
    this._db = db;
    this._attach(db);
  }

  static async open() {
    return new ParcelStore(await openDb());
  }

  // Close gracefully if another tab triggers a version change, so we don't
  // block; the next _tx() call will transparently reopen.
  _attach(db) {
    db.onversionchange = () => db.close();
  }

  // Some browsers (notably iOS Safari, after bfcache restores or version
  // changes) put the connection into a "closing" state, so db.transaction()
  // throws "The database connection is closing." Reopen once and retry.
  async _tx(stores, mode) {
    try {
      return this._db.transaction(stores, mode);
    } catch (err) {
      this._db = await openDb();
      this._attach(this._db);
      return this._db.transaction(stores, mode);
    }
  }

  async _getAll(store) {
    const tx = await this._tx([store], "readonly");
    return req(tx.objectStore(store).getAll());
  }

  // Persist a completed/capped run plus its parcels and address aliases.
  async saveRun(run, aliases = []) {
    const now = Date.now();
    const tx = await this._tx(["runs", "parcels", "run_parcels", "address_aliases"], "readwrite");
    const runId = await req(
      tx.objectStore("runs").add({
        county: run.county,
        input: run.input,
        input_label: run.input_label,
        rings_requested: run.rings_requested,
        status: run.status,
        capped_by: run.capped_by,
        source_id: run.source_id,
        llm_enabled: run.llm_enabled ? 1 : 0,
        seed_parcel_id: run.seed_parcel_id,
        summary: run.summary,
        error: run.error,
        record_version: RECORD_VERSION,
        created_at: now,
        completed_at: now,
      })
    );

    const parcelsStore = tx.objectStore("parcels");
    const runParcelsStore = tx.objectStore("run_parcels");
    for (const p of run.parcels) {
      await req(parcelsStore.put({ ...storedParcel(toParcel(p, { county: run.county })), updated_at: now }));
      await req(
        runParcelsStore.put({
          run_id: runId,
          parcel_id: p.parcel_id,
          ring_number: p.ring_number,
          is_seed: p.is_seed ? 1 : 0,
          matched_by: p.matched_by,
          normalized_owner_name: p.normalized_owner_name,
        })
      );
    }

    if (run.seed_parcel_id) {
      const aliasStore = tx.objectStore("address_aliases");
      for (const alias of aliases) {
        if (!alias) continue;
        await req(
          aliasStore.put({
            county: run.county,
            normalized_address: alias,
            parcel_id: run.seed_parcel_id,
            updated_at: now,
          })
        );
      }
    }

    await txDone(tx);
    return runId;
  }

  async getRun(runId) {
    const tx = await this._tx(["runs", "run_parcels", "parcels"], "readonly");
    const runRow = await req(tx.objectStore("runs").get(runId));
    if (!runRow) return null;

    const rps = await req(tx.objectStore("run_parcels").index("run_id").getAll(runId));
    const parcelsStore = tx.objectStore("parcels");
    const parcels = [];
    for (const rp of rps) {
      const p = await req(parcelsStore.get([runRow.county, rp.parcel_id]));
      if (!p) continue;
      parcels.push(
        toRunParcel(
          { ...p, matched_by: rp.matched_by },
          {
            ring_number: rp.ring_number,
            is_seed: Boolean(rp.is_seed),
            normalized_owner_name: rp.normalized_owner_name || undefined,
          }
        )
      );
    }
    return toRun(
      {
        ...runRow,
        created_at: new Date(runRow.created_at).toISOString(),
        completed_at: runRow.completed_at ? new Date(runRow.completed_at).toISOString() : null,
      },
      parcels
    );
  }

  async listRuns(limit = 20) {
    const runs = await this._getAll("runs");
    runs.sort((a, b) => b.id - a.id);
    return runs.slice(0, limit).map((r) => ({
      id: r.id,
      county: r.county,
      input: r.input,
      input_label: r.input_label,
      status: r.status,
      source_id: r.source_id,
      seed_parcel_id: r.seed_parcel_id,
      rings_requested: r.rings_requested,
      created_at: new Date(r.created_at).toISOString(),
    }));
  }

  async resolveAddressAlias(county, normalizedAddress, maxAgeDays) {
    const clean = (normalizedAddress || "").trim();
    if (!county || !clean) return null;
    const tx = await this._tx(["address_aliases"], "readonly");
    const row = await req(tx.objectStore("address_aliases").get([county, clean]));
    if (!row) return null;
    const cutoff = Date.now() - Math.max(1, maxAgeDays) * DAY_MS;
    if (row.updated_at < cutoff) return null;
    return String(row.parcel_id || "").trim() || null;
  }

  async getRecentRunForSeedParcel(county, seedParcelId, minRings, maxAgeDays) {
    const clean = (seedParcelId || "").trim();
    if (!county || !clean) return null;
    const cutoff = Date.now() - Math.max(1, maxAgeDays) * DAY_MS;
    const tx = await this._tx(["runs"], "readonly");
    const rows = await req(tx.objectStore("runs").index("county_seed").getAll([county, clean]));
    const matches = rows.filter((r) => reusable(r, cutoff) && r.rings_requested >= minRings);
    if (!matches.length) return null;
    matches.sort((a, b) => b.id - a.id);
    return this.getRun(matches[0].id);
  }

  // Parcels of this county's reusable recent runs, for resolving map clicks
  // without a network request.
  async listRecentCachedParcels(county, maxAgeDays) {
    const cutoff = Date.now() - Math.max(1, maxAgeDays) * DAY_MS;
    const runs = await this._getAll("runs");
    const recentRunIds = new Set(
      runs.filter((r) => r.county === county && reusable(r, cutoff)).map((r) => r.id)
    );
    if (!recentRunIds.size) return [];

    const rps = await this._getAll("run_parcels");
    const parcelIds = new Set();
    for (const rp of rps) {
      if (recentRunIds.has(rp.run_id)) parcelIds.add(rp.parcel_id);
    }

    const tx = await this._tx(["parcels"], "readonly");
    const parcelsStore = tx.objectStore("parcels");
    const out = [];
    for (const pid of parcelIds) {
      const p = await req(parcelsStore.get([county, pid]));
      if (p && p.geometry) out.push(toParcel(p));
    }
    return out;
  }

  async cleanupExpiredData(retentionDays) {
    const cutoff = Date.now() - Math.max(1, retentionDays) * DAY_MS;

    // 1. Expired runs and their run_parcels.
    const runs = await this._getAll("runs");
    const expiredRunIds = runs.filter((r) => r.created_at < cutoff).map((r) => r.id);
    if (expiredRunIds.length) {
      const tx = await this._tx(["runs", "run_parcels"], "readwrite");
      const rpIndex = tx.objectStore("run_parcels").index("run_id");
      for (const id of expiredRunIds) {
        await req(tx.objectStore("runs").delete(id));
        const rps = await req(rpIndex.getAll(id));
        for (const rp of rps) {
          await req(tx.objectStore("run_parcels").delete([rp.run_id, rp.parcel_id]));
        }
      }
      await txDone(tx);
    }

    // 2. Expired aliases.
    const aliases = await this._getAll("address_aliases");
    const expiredAliases = aliases.filter((a) => a.updated_at < cutoff);
    if (expiredAliases.length) {
      const tx = await this._tx(["address_aliases"], "readwrite");
      for (const a of expiredAliases) {
        await req(tx.objectStore("address_aliases").delete([a.county, a.normalized_address]));
      }
      await txDone(tx);
    }

    // 3. Unreferenced parcels older than the cutoff.
    const countyByRun = new Map((await this._getAll("runs")).map((r) => [r.id, r.county]));
    const referenced = new Set();
    for (const rp of await this._getAll("run_parcels")) {
      referenced.add(parcelKey(countyByRun.get(rp.run_id), rp.parcel_id));
    }
    for (const a of await this._getAll("address_aliases")) {
      referenced.add(parcelKey(a.county, a.parcel_id));
    }
    const parcels = await this._getAll("parcels");
    const orphans = parcels.filter(
      (p) => !referenced.has(parcelKey(p.county, p.parcel_id)) && p.updated_at < cutoff
    );
    if (orphans.length) {
      const tx = await this._tx(["parcels"], "readwrite");
      for (const p of orphans) await req(tx.objectStore("parcels").delete([p.county, p.parcel_id]));
      await txDone(tx);
    }
  }
}
