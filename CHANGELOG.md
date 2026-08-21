# Changelog

All notable changes to this project will be documented in this file.

## [0.8.1] - 2026-08-21

### Added
- Owner name shown directly on the map: each rendered parcel now carries a
  permanent, non-interactive label centered on its polygon (shoelace centroid,
  largest-polygon for MultiPolygons). Long names truncate with an ellipsis;
  the seed parcel label is highlighted. Owner names are HTML-escaped before
  rendering. Applies to both the in-browser build (`web/`) and the backend
  reference UI (`backend/static/`).

## [0.8.0] - 2026-08-21

### Added
- Eleven more Minnesota counties (16 total): Ramsey, Olmsted, Chisago, Morrison,
  Scott, Aitkin, Koochiching, Beltrami, Dakota, Washington, and Carver.
- `backend/services/{ramsey,olmsted,chisago,morrison,scott,aitkin,koochiching,beltrami}.py`
  and matching `web/js/providers/*.js` ports for each county.
- `backend/services/mn_state.py` / `web/js/providers/mn_state.js` — shared
  statewide-schema adapter for Dakota (layer 2), Washington (layer 6), and
  Carver (layer 1) on the MN state parcel server, each with a `CO_NAME` safety
  clause. Carver uses `TAX_NAME` for owner (its `OWNER_NAME` column is null).
- `street_prefix` helper in the base class for bounding address WHERE clauses
  on street-only fields; new county adapters strip city/state/zip before
  exact matching and use prefix `LIKE` for contains matching.
- County boundary polygons for all 16 counties in `web/county_boundaries.geojson`;
  county entries in `countyConfig` (both UIs), dropdowns, `README.md` table,
  and `cors-test.html` harness.

### Notes
- All new endpoints verified live 2026-08-21 (metadata, attribute, spatial,
  and end-to-end address lookups). See `county_expansion.md`.
- Olmsted parcel geometries are published with a ≈0.7° east offset; address
  lookups are unaffected, map display may be shifted.

## [0.7.0] - 2026-06-19

### Added
- All-in-browser build under `web/`: a no-server static version of the app that
  calls the county ArcGIS endpoints and a geocoder directly from the browser
  (CORS-verified). The Python backend is retained unchanged as reference.
- `web/js/providers/*` — ES-module ports of `services/base.py` and the five
  county adapters (Wright, Hennepin, St. Louis, Sherburne, Anoka).
- `web/js/runner.js` — client-side lookup/ring traversal with the cache paths
  from `services/runner.py`.
- `web/js/store.js` — IndexedDB port of `db.py` (30-day cache, address aliases,
  seed-parcel reuse, local point-in-polygon seeding) plus a Recent Runs panel.
- `web/js/geocode.js` — Nominatim geocoder (bounded to Minnesota) replacing the
  Census fallback, which does not send CORS headers.
- `web/js/export.js` — client-side CSV / GeoJSON downloads (replaces the
  `/api/runs/{id}` export routes).
- `web/js/llm.js` — optional owner normalization / summary using a user-supplied
  OpenAI or OpenRouter key stored in `localStorage`, with deterministic
  fallback.
- `cors-test.html` — browser harness that verifies every external endpoint
  (county servers, geocoders, LLM providers) is reachable cross-origin.
- `docs/in-browser-port-plan.md` — the file-by-file port plan.

### Changed
- Address matching now extracts a street-only variant from full input and tries
  it against the county address field before geocoding, so street-only fields
  (e.g. Wright `PHYSADDR`) match without depending on geocode accuracy.

## [0.6.0] - 2026-04-25

### Added
- Multi-county support: Hennepin County and St. Louis County in addition to Wright County.
- Abstract `BaseParcelService` with shared query/retry/throttle/geometry logic (strategy pattern).
- `HennepinParcelService` with address points layer (MapServer/0) fallback for address-to-PID resolution.
- `StLouisParcelService` with street-only PHYSADDR extraction and double-to-int ZIP handling.
- County service registry (`registry.py`) with factory and human-readable labels.
- County selector dropdown in the web UI (Wright / Hennepin / St. Louis).
- Dynamic map center and zoom per county.
- County-aware external property links (Zillow, Realtor, county property search, ArcGIS JSON).
- `county` parameter on `POST /api/lookup` and `POST /api/lookup/point`.
- `/api/providers/status` now returns available counties list.
- Launchd LaunchAgent plist for auto-start and crash recovery on macOS.

### Changed
- Refactored `wright.py` to thin subclass of `BaseParcelService`.
- `ParcelLookupRunner` now accepts generic `BaseParcelService` instead of `WrightParcelService`.
- `main.py` initializes three service instances and selects runner by county.
- Version bumped to 0.6.0.

### Fixed
- St. Louis PHYSADDR queries now correctly strip city/state/ZIP before searching (field is street-only).
- St. Louis PHYSCITY already includes MN suffix — no duplicate state appending.

## [0.5.6] - 2026-02-15

### Added
- Property Links panel in the web UI for selected seed parcel results.
- Zillow-first external link generation with Realtor and county/public fallback links.

### Changed
- Property links now update for both address-seeded and map-click-seeded runs.
- Clarified documentation that external listing links open in new tabs.

## [0.5.5] - 2026-02-15

### Added
- 30-day persistent local cache behavior for repeat parcel lookups.
- Address-to-parcel alias mapping for fast cache hits on previously analyzed parcels.
- API response field `from_cache` to indicate cached responses.

### Changed
- Repeat address lookups now return immediately from cache when a matching parcel was analyzed in the last 30 days.
- Added database retention cleanup for runs, aliases, and unreferenced parcel rows older than retention window.
- Added `RETENTION_DAYS` environment setting (`.env.example`).

## [0.5.4] - 2026-02-15

### Changed
- Auto-populated the Property Address input after successful map-click lookup, using the detected seed parcel address.
- Restored OpenStreetMap light basemap and original parcel ring colors.
- Updated field-label typography to a smaller terminal-style look.
- Updated `README.md` behavior notes to document map-click auto-populate.

## [0.5.3] - 2026-02-15

### Added
- Map click seeded lookup support in the frontend and API (`POST /api/lookup/point`).
- Click-anywhere map workflow that identifies the parcel at the clicked coordinates and runs ring expansion.

### Changed
- Refactored lookup runner to share one pipeline for address-seeded and point-seeded runs.
- Added point lookup method in Wright service (`lookup_by_point`) for clean map-click integration.

## [0.5.2] - 2026-02-15

### Changed
- Improved address resolution for full user-entered addresses (including city/state/ZIP) by:
- Adding a Census-matched street fallback before point intersect lookup.
- Selecting only parcel features with non-empty parcel IDs from Wright query results.
- Refreshed the frontend with a darker, higher-contrast visual theme and dark basemap tiles.

## [0.5.1] - 2026-02-14

### Changed
- Updated default app port in `.env.example` to `8091` for local/LAN usage consistency.
- Updated `README.md` run/access instructions to use `http://127.0.0.1:8091` and LAN `:8091`.
- Updated `.gitignore` to ignore the runtime `data/` directory created during local execution.

## [0.5.0] - 2026-02-14

### Added
- Phase 2: adjacent parcel expansion for ring 1 and ring 2 using Wright ArcGIS `Touches` queries.
- Phase 3: SQLite persistence for lookup runs and parcel records (`data/app.db`).
- Phase 3: export endpoints for run CSV and GeoJSON.
- Phase 3: in-process parcel/address caching in provider adapter.
- Phase 3: run listing and retrieval endpoints.
- Phase 4: optional LLM-assisted owner normalization and lookup summaries (OpenAI/OpenRouter, feature-flagged).
- Phase 5: provider guardrails (request budgets, throttling, retries/backoff).
- Phase 5: structured logging for lookup lifecycle events.
- UI updates for rings, LLM toggle, run summary, parcel table, and export links.
- Expanded `.env.example` configuration for guardrails, DB, and LLM controls.

### Changed
- `POST /api/lookup` now supports `rings` and `use_llm` and returns full run payload.
- Documentation updated to cover all implemented phases and API surface.

## [0.1.0] - 2026-02-14

### Added
- Initial Phase 1 MVP scaffold for Wright County parcel lookup.
- FastAPI backend with `/api/health` and `/api/lookup`.
- Wright County ArcGIS adapter for parcel ID, owner, and geometry retrieval.
- U.S. Census geocoder fallback when direct address matching fails.
- Browser UI with address input, result panel, and Leaflet map rendering.
- `README.md` with setup, run, and API docs.
- `.env.example`, `.gitignore`, and dependency pinning in `requirements.txt`.
