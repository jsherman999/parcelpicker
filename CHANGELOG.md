# Changelog

All notable changes to this project will be documented in this file.

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
