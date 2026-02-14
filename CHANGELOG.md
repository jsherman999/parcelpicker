# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-02-14

### Added
- Initial Phase 1 MVP scaffold for Wright County parcel lookup.
- FastAPI backend with `/api/health` and `/api/lookup`.
- Wright County ArcGIS adapter for parcel ID, owner, and geometry retrieval.
- U.S. Census geocoder fallback when direct address matching fails.
- Browser UI with address input, result panel, and Leaflet map rendering.
- `README.md` with setup, run, and API docs.
- `.env.example`, `.gitignore`, and dependency pinning in `requirements.txt`.
