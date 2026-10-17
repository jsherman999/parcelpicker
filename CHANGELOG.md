# Changelog

All notable changes to this project will be documented in this file.

## [0.11.0] - 2026-10-17

### Added
- Blue Earth County (Mankato), 75 counties total. A hand-written provider,
  `web/js/providers/blueearth.js`, reads the county's
  `LandRecords/TaxParcelsWGS84` layer, which joins the parcel fabric to the
  ownership table. Its field names are table-qualified
  (`SDEDATA.TaxParcel.ParcelNo`, `Ownership.OWNNAME`) and work as-is in WHERE,
  outFields and the returned attributes. Owner and estimated market value
  (`Ownership.ESTTOTVAL`, assessment year `Ownership.TAXINFOYEAR`) are filled
  for about 99% of the 33,636 parcels; the layer has no land-use field.
- Blue Earth address lookups go through the county's
  `LandRecords/AddressPoints` layer first (about 0.2 s), then point-intersect
  the parcel layer. The parcel site address is the second try: any filter on
  the joined `Ownership.*` fields takes about 10 s on the county server. Both
  match the street by prefix and use the typed city or ZIP to pick between
  towns, since some street addresses recur across them. If neither finds the
  address in the typed town or ZIP, the lookup falls back to the geocoder.

### Fixed
- Olmsted address lookups match on every part of the address the input has:
  pre- and post-direction, a route prefix ("County Rd"), street type, and
  city or ZIP. "200 1st St SW Rochester" previously matched
  "200 1 ST W, STEWARTVILLE". The looser retry still requires the house
  number, direction and town. When no parcel lists the address as its own,
  the lookup tries the county's E911 address points before geocoding.
  Displayed addresses keep the route prefix ("6126 COUNTY RD 19 SE"). Same
  change in `backend/services/olmsted.py`.
- Olmsted's example address is now the real "6126 County Rd 19 SE Rochester
  MN 55904"; the old "6126 19th St SE Rochester MN 55068" doesn't exist and no
  longer matches.

### Changed
- `tools/eris_specs/gen_bundle.py` lists Blue Earth with the hand-written
  counties instead of as unsupported. `web/county_boundaries.geojson` was
  regenerated and no longer carries an unsupported note for it.

### Notes
- The layer rejects `resultRecordCount` ("Pagination is not supported"), so
  the provider drops it and trims adjacency results in the browser.
- GETs past about 9,000 characters return HTTP 414, so the provider sets
  `postLongQueries`. Form POSTs return the CORS header for
  `https://jsherman999.github.io`.
- The Python backend was not updated.

## [0.10.0] - 2026-10-16

### Added
- Estimated market value and land use / property class for every county
  whose layer publishes them (36 with value, 17 of those with the assessment
  or market year; 47 with land use), shown in the results table, the map
  popup, and the CSV/GeoJSON exports (`est_market_value`,
  `market_value_year`, `land_use`), and kept in the IndexedDB cache.
  `BaseParcelProvider` gains `valueField` (a field, or a list of fields that
  are summed; Sherburne sums `EMV_LAND` + `EMV_BLDG`), `valueYearField` and
  `landUseField`. The spec bundle carries `value` / `valueYear` / `landUse`
  per county. Placeholder values (-9999, 0, NULL, blanks, padding) show "—".
- Run records are versioned. Runs cached before this release stay in history
  but are not reused as cache hits, so lookups re-fetch with the new fields.
- Lake of the Woods (2021) and Traverse (tax year 2019) are labeled as stale
  snapshots in the county dropdown.

### Changed
- County-supplied text in the results table and map popup is HTML-escaped.
- Hennepin's and Sherburne's `_getOutfields` overrides were removed; they
  matched the base behavior and would have dropped the new fields.

### Notes
- Dakota keeps the MN state (metc) layer: `EMV_TOTAL` / `USECLASS1` /
  `MKT_YEAR` are filled for 148,567 of 154,315 Dakota parcels. The -9999 rows
  are null-PIN features at the start of the layer.
- The Python backend was not updated with these fields.

## [0.9.0] - 2026-10-16

### Added
- 58 more Minnesota counties in the in-browser build (74 total). They are served
  by one generic provider, `web/js/providers/spec.js`, from
  `web/mn_parcel_specs.json`: a live-verified subset of the ErisData parcel
  adapter registry (https://github.com/Eriskii/ErisData, CC-BY-4.0, Eriskii),
  credited in the README and in the map attribution. Every endpoint was checked
  on 2026-10-16 for CORS from the Pages origin, an owner-filled point intersect
  inside the county, adjacency, and long-query POST.
- `web/county_boundaries.geojson` now covers all 87 counties (Census TIGERweb).
  Map clicks switch to whichever supported county contains the click, and a
  click in an unsupported county says why it isn't supported.
- County dropdown is built alphabetically from `countyConfig`; spec counties'
  map center/zoom and verified example addresses come from the bundle.
- Optional `postLongQueries` on `BaseParcelProvider` (on for spec counties):
  queries whose URL would pass 2,000 characters are sent as a form POST.
  ArcGIS Online returns 404 for long GET URLs, which detailed parcel polygons
  in adjacency queries produce. It stays off for the hand-written providers,
  which keep their original GET-only requests.
- `tools/eris_specs/`: verification and bundle-generation scripts.
- `cors-test.html` also tests every bundled spec endpoint when served from the
  repo root.

### Fixed
- Removed the Olmsted "≈0.7° geometry offset" caveat. Geometry is correct
  WGS84: a point at Mayo Clinic (-92.4663, 44.0222) returns the Mayo Clinic
  parcel. The sample parcel behind the caveat is on County Rd 19 SE in Pleasant
  Grove Township, not 19th St SE in Rochester, and Rochester is at ≈ -92.46, not
  the "expected ≈ -93.0".

### Not supported
- Kandiyohi, Kittson, Redwood, Rock (unavailable in ErisData); Becker, Brown,
  Houston, Waseca, Watonwan (no usable owner field); Blue Earth (spec owner
  field is the parcel number); Fillmore (http-only); Todd (owner is '0');
  Nicollet (partial 2021 snapshot). Nobles and Martin are partial-coverage.

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
