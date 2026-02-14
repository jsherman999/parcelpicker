# Changelog

All notable changes to this project will be documented in this file.

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
