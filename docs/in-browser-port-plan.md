# ParcelPicker — All-In-Browser Port Plan

Goal: run ParcelPicker as a **static site with no server**. All lookup
orchestration, caching, exports, and (optional) LLM assist move into the
browser. Hosting becomes any static host (GitHub Pages, Netlify, S3) or even
`file://`.

This is feasible because the CORS harness (`cors-test.html`) confirmed that all
five county ArcGIS endpoints — Wright, Hennepin (parcels + address points),
St. Louis, Sherburne, Anoka — allow direct cross-origin browser calls. The only
endpoint that failed was the U.S. Census geocoder (fallback only), which we
replace (see §6).

---

## 1. Target architecture

No build step (stay vanilla ES modules + Leaflet via CDN, matching today).

```
/index.html                 (was backend/static/index.html; script tags adjusted)
/styles.css                 (unchanged)
/app.js                     (UI + orchestration; was static/app.js)
/county_boundaries.geojson  (unchanged, served as a static asset)
/js/
  config.js                 (limits + county config)   <- env vars + countyConfig
  store.js                  (IndexedDB)                 <- db.py
  geocode.js                (address -> lat/lon)        <- _geocode_with_census
  llm.js                    (owner normalize + summary) <- services/llm.py
  runner.js                 (ring traversal + cache)    <- services/runner.py
  providers/
    base.js                 <- services/base.py
    wright.js               <- services/wright.py
    hennepin.js             <- services/hennepin.py
    stlouis.js              <- services/stlouis.py
    sherburne.js            <- services/sherburne.py
    anoka.js                <- services/anoka.py
    registry.js             <- services/registry.py
```

Keep the Python backend in the tree (or move under `/legacy`) until the browser
build reaches parity, so we can diff behavior.

---

## 2. Python -> JavaScript module mapping

| Backend (today) | Browser module | Notes |
|---|---|---|
| `services/base.py` `BaseParcelService` | `js/providers/base.js` | `httpx` -> `fetch`; same query params, geometry conversion, address normalization, throttle, retry, `RequestBudget` |
| `services/{wright,hennepin,stlouis,sherburne,anoka}.py` | `js/providers/*.js` | 1:1 ports of field configs + WHERE builders + `_build_address` overrides |
| `services/registry.py` | `js/providers/registry.js` | factory + county labels |
| `services/runner.py` `ParcelLookupRunner` | `js/runner.js` | ring traversal, cache lookups, point-in-polygon, owner-normalize, summary — mostly pure logic |
| `services/llm.py` | `js/llm.js` | user-supplied key from `localStorage`; graceful fallback |
| `db.py` `ParcelDatabase` | `js/store.js` | SQLite -> IndexedDB |
| `main.py` routes + CSV/GeoJSON | folded into `app.js` + inline export helpers | direct function calls; exports built client-side as Blobs |
| `_geocode_with_census` | `js/geocode.js` | swap geocoder (see §6) |
| `.env` / `load_lookup_settings` | `js/config.js` | constants |

The current `app.js` already renders the map, table, property links, county
borders, and builds direct ArcGIS URLs — that all stays. Only the two
`fetch('/api/...')` calls and the CSV/GeoJSON `<a href>` links change.

---

## 3. Providers (`js/providers/`)

Direct port of the Python classes. Key translations:

- `httpx.AsyncClient.get(url, params)` -> `fetch(url + '?' + new URLSearchParams(params))`.
- Retry on `429` / `>=500` / network error with exponential backoff
  (`RETRY_BACKOFF_SECONDS * 2**attempt`); cap at `REQUEST_RETRIES`.
- Per-request timeout via `AbortController` + `setTimeout`.
- Throttle: module-level `lastRequestAt` + `await sleep(minInterval - elapsed)`.
  JS is single-threaded async, so no lock is needed (the Python `asyncio.Lock`
  becomes a simple awaited gap).
- `RequestBudget` -> plain object `{ max, used, consume() }` that throws when
  exceeded.
- Geometry helpers (`_geometry_to_geojson`, `_to_esri_polygon`,
  `_first_feature_with_pid`, `_sql_escape`, address regexes) port verbatim.

Each county subclass keeps its `endpoint_url`, id/owner/address fields, and the
custom `_build_address` / WHERE-builder logic (Hennepin address-points two-step,
St. Louis street trimming, Sherburne house+street split, Anoka prefix match).

---

## 4. Local store (`js/store.js`) — IndexedDB

Database `parcelpicker`, version 1. Four object stores mirror the SQLite tables:

| Store | keyPath | Indexes | Replaces |
|---|---|---|---|
| `runs` | `id` (autoIncrement) | `seed_parcel_id`, `created_at` | `lookup_runs` |
| `parcels` | `parcel_id` | `updated_at` | `parcels` |
| `run_parcels` | `[run_id, parcel_id]` (composite) | `run_id` | `run_parcels` |
| `address_aliases` | `normalized_address` | `parcel_id` | `parcel_address_aliases` |

Implementation notes:

- Store `geometry` as a real object (IndexedDB stores structured clones — no
  `json.dumps`/`json.loads` needed).
- Timestamps as **epoch ms** (`Date.now()`); `max_age_days` cutoff becomes
  `Date.now() - days*86400000`. Simpler and faster than SQLite datetime strings.
- Method-for-method port of `db.py`: `createRun`, `completeRun`, `upsertParcel`,
  `addRunParcel`, `getRun` (join run_parcels -> parcels, sort in JS),
  `listRuns`, `upsertAddressAlias`, `resolveAddressAlias`,
  `getRecentRunForSeedParcel`, `listRecentCachedParcels`, `cleanupExpiredData`.
- `getRun` reproduces the SQL ORDER BY (ring asc, seed first, parcel_id asc) and
  recomputes `parcel_count` / `owner_count` in JS.
- `cleanupExpiredData` deletes expired runs/run_parcels/aliases, then prunes
  parcels not referenced by any run or alias (same predicate as SQLite).
- All ops wrapped in a tiny `promisify(IDBRequest)` helper; run inside a single
  transaction per logical operation.

Storage budget: geometries are the heavy part; the 30-day retention + cleanup
keeps it bounded, and browsers allow tens of MB+ for IndexedDB. Acceptable.

---

## 5. Runner (`js/runner.js`)

Near-direct port of `ParcelLookupRunner`:

- `runLookup({ address, rings, useLlm, county })` and
  `runLookupFromPoint({ lat, lon, rings, useLlm, county })`.
- Ring BFS, dedup by parcel id, `MAX_PARCELS` cap -> status `capped`,
  `ADJACENT_LIMIT_PER_PARCEL`, `MAX_REQUESTS_PER_RUN` budget — all identical.
- Cache path: `cleanupExpiredData` -> alias/seed-parcel recent-run lookup ->
  `_trim_run_to_rings` -> `from_cache: true`.
- Point path: local-cache point-in-polygon seed (the `_point_in_polygon` /
  `_point_in_ring` ray-cast ports verbatim) before hitting the provider.
- Owner normalization: deterministic uppercase fallback always; LLM (if enabled
  and a key is present) refines, capped at `MAX_LLM_NORMALIZATIONS`, with the
  per-owner cache. Any LLM error -> silently keep the fallback.
- Deterministic summary always computed; LLM summary overrides if it succeeds.

---

## 6. Geocoder swap (`js/geocode.js`)

Census failed CORS, and it is only the cross-county fallback (address -> point ->
point-intersect) used when a county's own address query misses.

**Recommended default: Nominatim (OpenStreetMap).**
- Keyless, sends `Access-Control-Allow-Origin: *`, and we already use OSM tiles.
- `https://nominatim.openstreetmap.org/search?q=<addr>&format=jsonv2&limit=1&countrycodes=us`
- Respect the usage policy: **max 1 request/sec** (our throttle already enforces
  a min interval; set the geocode path to >= 1000 ms) and a descriptive app
  identity. Fine for a personal/local-first tool.

Alternatives if Nominatim volume/policy becomes an issue:
- **Census via JSONP** (`format=jsonp&callback=...` via a script tag) — sidesteps
  CORS but is clunkier.
- **Esri World Geocoder** `findAddressCandidates` — same family as the parcel
  servers (CORS-proven), but now generally requires an ArcGIS API key.

**Verify before building:** add Nominatim to a v2 of `cors-test.html` and confirm
PASS from the deploy origin.

---

## 7. LLM assist in-browser (`js/llm.js`) — user-supplied key

- A small **Settings** panel (gear icon) lets the user paste an API key, pick
  provider (`openai` | `openrouter`) and model. Stored in `localStorage` under
  `pp.llm` — **client-only, never sent anywhere except the provider**.
- `normalizeOwnerName` / `summarizeLookup` port from `services/llm.py`; `httpx`
  POST -> `fetch` with `Authorization: Bearer <key>`.
- Graceful by design (matches today's "advisory" stance): if no key, or the call
  fails for any reason, fall back to deterministic normalization / summary. The
  app never blocks on the LLM.
- **CORS caveat:** OpenRouter supports browser calls; OpenAI generally does too,
  but this must be confirmed from the deploy origin (add to harness v2). If a
  provider blocks CORS, the feature degrades to fallback — core app unaffected.
- **Security note:** a key in `localStorage` is readable by any script on the
  origin. With a static site there is no server to leak it, but XSS or a
  compromised CDN dependency could. Mitigations: keep dependencies minimal
  (only Leaflet), pin it with **Subresource Integrity**, and advise users to use
  a scoped/limited key. Surface a clear "stored locally in your browser" notice.

---

## 8. Frontend wiring (`app.js`)

- `fetch('/api/lookup', ...)` -> `await runner.runLookup({...})`.
- `fetch('/api/lookup/point', ...)` -> `await runner.runLookupFromPoint({...})`.
- `county_boundaries.geojson` fetch stays (relative static path).
- CSV / GeoJSON links: replace `/api/runs/{id}/csv|geojson` hrefs with
  client-side generation — build the string/FeatureCollection from the in-memory
  run and download via `URL.createObjectURL(new Blob([data], { type }))`.
  (The CSV columns and GeoJSON feature props come straight from `main.py`.)
- Optional: a "Recent runs" list backed by `store.listRuns()` (the backend had
  `/api/runs` but the current UI doesn't use it — easy add).
- Rendering, county switching, property links, map-click: unchanged.

---

## 9. What gets deleted / simplified

- FastAPI app, CORS middleware, uvicorn, `requirements.txt`, `.env`, launchd
  plist — all gone.
- SQLite WAL / threading locks — gone (IndexedDB + single-threaded JS).
- No backend process to run, monitor, or auto-start.

---

## 10. Risks & open items

1. **Geocoder CORS** (Nominatim/Esri) — verify via harness v2. *(only affects the
   address fallback path; map-click and direct county address matches don't use
   it.)*
2. **LLM endpoint CORS** (OpenAI/OpenRouter) — verify; graceful fallback either
   way.
3. **Origin-specific CORS** — a county server could allow only specific origins;
   re-run the harness from the final deploy origin before shipping.
4. **Nominatim rate/usage policy** — throttle to <= 1 req/s; consider a tiny
   in-memory/IndexedDB geocode cache.
5. **Key security in `localStorage`** — minimize deps, add SRI, warn the user.
6. **IndexedDB quota** — bounded by 30-day retention + cleanup; monitor.

---

## 11. Phasing

1. **Core lookup parity** — `providers/*`, `runner.js` (no cache, no LLM),
   geocoder swap; address + map-click; render. Diff against the Python output.
2. **Persistence** — `store.js` IndexedDB: 30-day cache, run history, retention.
3. **Exports** — client-side CSV / GeoJSON downloads.
4. **LLM** — settings panel + key in `localStorage` + in-browser normalize/
   summarize with graceful fallback.
5. **Polish & ship** — SRI on Leaflet, optional service worker for offline tile/
   asset caching, GitHub Pages deploy, docs refresh.

---

## 12. Immediate next step

Extend `cors-test.html` -> v2 to also test **Nominatim**, **OpenAI**, and
**OpenRouter** from the deploy origin (the latter two need a throwaway key),
closing the last two unknowns before writing the port.
