// Browser port of backend/db.py ParcelDatabase, backed by IndexedDB.
// SQLite tables -> object stores; datetime cutoffs -> epoch-ms comparisons.

const DB_NAME = "parcelpicker";
const DB_VERSION = 1;
const DAY_MS = 86400000;
const CACHEABLE = new Set(["completed", "capped"]);

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

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;

      const runs = db.createObjectStore("runs", { keyPath: "id", autoIncrement: true });
      runs.createIndex("seed_parcel_id", "seed_parcel_id", { unique: false });
      runs.createIndex("created_at", "created_at", { unique: false });

      const parcels = db.createObjectStore("parcels", { keyPath: "parcel_id" });
      parcels.createIndex("updated_at", "updated_at", { unique: false });

      const runParcels = db.createObjectStore("run_parcels", {
        keyPath: ["run_id", "parcel_id"],
      });
      runParcels.createIndex("run_id", "run_id", { unique: false });

      const aliases = db.createObjectStore("address_aliases", {
        keyPath: "normalized_address",
      });
      aliases.createIndex("parcel_id", "parcel_id", { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function ownerCount(parcels) {
  const keys = new Set();
  for (const p of parcels) {
    const key = (p.normalized_owner_name || p.owner_name || "").trim().toUpperCase();
    if (key) keys.add(key);
  }
  return keys.size;
}

function assembleRun(runRow, parcels) {
  parcels.sort(
    (a, b) =>
      a.ring_number - b.ring_number ||
      (b.is_seed ? 1 : 0) - (a.is_seed ? 1 : 0) ||
      String(a.parcel_id).localeCompare(String(b.parcel_id))
  );
  return {
    id: runRow.id,
    input_address: runRow.input_address,
    rings_requested: runRow.rings_requested,
    status: runRow.status,
    provider: runRow.provider,
    llm_enabled: Boolean(runRow.llm_enabled),
    seed_parcel_id: runRow.seed_parcel_id,
    summary: runRow.summary,
    error: runRow.error,
    created_at: new Date(runRow.created_at).toISOString(),
    completed_at: runRow.completed_at ? new Date(runRow.completed_at).toISOString() : null,
    parcel_count: parcels.length,
    owner_count: ownerCount(parcels),
    parcels,
    from_cache: false,
  };
}

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
        input_address: run.input_address,
        rings_requested: run.rings_requested,
        status: run.status,
        provider: run.provider,
        llm_enabled: run.llm_enabled ? 1 : 0,
        seed_parcel_id: run.seed_parcel_id,
        summary: run.summary,
        error: run.error,
        created_at: now,
        completed_at: now,
      })
    );

    const parcelsStore = tx.objectStore("parcels");
    const runParcelsStore = tx.objectStore("run_parcels");
    for (const p of run.parcels) {
      await req(
        parcelsStore.put({
          parcel_id: p.parcel_id,
          owner_name: p.owner_name,
          normalized_owner_name: p.normalized_owner_name,
          site_address: p.site_address,
          geometry: p.geometry,
          source: p.source,
          updated_at: now,
        })
      );
      await req(
        runParcelsStore.put({
          run_id: runId,
          parcel_id: p.parcel_id,
          ring_number: p.ring_number,
          is_seed: p.is_seed ? 1 : 0,
          matched_by: p.matched_by,
        })
      );
    }

    if (run.seed_parcel_id) {
      const aliasStore = tx.objectStore("address_aliases");
      for (const alias of aliases) {
        if (!alias) continue;
        await req(
          aliasStore.put({
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
      const p = await req(parcelsStore.get(rp.parcel_id));
      if (!p) continue;
      parcels.push({
        parcel_id: rp.parcel_id,
        ring_number: rp.ring_number,
        is_seed: Boolean(rp.is_seed),
        matched_by: rp.matched_by,
        owner_name: p.owner_name,
        normalized_owner_name: p.normalized_owner_name,
        site_address: p.site_address,
        geometry: p.geometry,
        source: p.source,
      });
    }
    return assembleRun(runRow, parcels);
  }

  async listRuns(limit = 20) {
    const runs = await this._getAll("runs");
    runs.sort((a, b) => b.id - a.id);
    return runs.slice(0, limit).map((r) => ({
      id: r.id,
      input_address: r.input_address,
      status: r.status,
      provider: r.provider,
      seed_parcel_id: r.seed_parcel_id,
      rings_requested: r.rings_requested,
      created_at: new Date(r.created_at).toISOString(),
    }));
  }

  async resolveAddressAlias(normalizedAddress, maxAgeDays) {
    const clean = (normalizedAddress || "").trim();
    if (!clean) return null;
    const tx = await this._tx(["address_aliases"], "readonly");
    const row = await req(tx.objectStore("address_aliases").get(clean));
    if (!row) return null;
    const cutoff = Date.now() - Math.max(1, maxAgeDays) * DAY_MS;
    if (row.updated_at < cutoff) return null;
    return String(row.parcel_id || "").trim() || null;
  }

  async getRecentRunForSeedParcel(seedParcelId, minRings, maxAgeDays) {
    const clean = (seedParcelId || "").trim();
    if (!clean) return null;
    const cutoff = Date.now() - Math.max(1, maxAgeDays) * DAY_MS;
    const tx = await this._tx(["runs"], "readonly");
    const rows = await req(tx.objectStore("runs").index("seed_parcel_id").getAll(clean));
    const matches = rows.filter(
      (r) =>
        CACHEABLE.has(r.status) &&
        r.rings_requested >= minRings &&
        r.created_at >= cutoff
    );
    if (!matches.length) return null;
    matches.sort((a, b) => b.id - a.id);
    return this.getRun(matches[0].id);
  }

  async listRecentCachedParcels(maxAgeDays) {
    const cutoff = Date.now() - Math.max(1, maxAgeDays) * DAY_MS;
    const runs = await this._getAll("runs");
    const recentRunIds = new Set(
      runs.filter((r) => CACHEABLE.has(r.status) && r.created_at >= cutoff).map((r) => r.id)
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
      const p = await req(parcelsStore.get(pid));
      if (p && p.geometry) {
        out.push({
          parcel_id: p.parcel_id,
          owner_name: p.owner_name,
          site_address: p.site_address,
          geometry: p.geometry,
          source: p.source,
        });
      }
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
        await req(tx.objectStore("address_aliases").delete(a.normalized_address));
      }
      await txDone(tx);
    }

    // 3. Unreferenced parcels older than the cutoff.
    const rps = await this._getAll("run_parcels");
    const referenced = new Set(rps.map((rp) => rp.parcel_id));
    for (const a of await this._getAll("address_aliases")) referenced.add(a.parcel_id);
    const parcels = await this._getAll("parcels");
    const orphans = parcels.filter(
      (p) => !referenced.has(p.parcel_id) && p.updated_at < cutoff
    );
    if (orphans.length) {
      const tx = await this._tx(["parcels"], "readwrite");
      for (const p of orphans) await req(tx.objectStore("parcels").delete(p.parcel_id));
      await txDone(tx);
    }
  }
}
