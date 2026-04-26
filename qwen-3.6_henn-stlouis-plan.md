# Multi-Phase Plan: Add Hennepin & St. Louis Counties to ParcelPicker

## Goal

Extend the existing single-county (Wright County) ParcelPicker app to support three Minnesota counties — Wright, Hennepin, and St. Louis — via a provider abstraction that shares all orchestration, caching, UI, and export logic.

---

## Phase 1 — Provider Abstraction (Core Architecture)

**Purpose**: Introduce a protocol/interface so the runner and services can work with any county provider without knowing county-specific details.

### Work
1. **Create `backend/services/provider.py`** — define a `ParcelProvider` protocol/abstract class with methods:
   - `async def lookup(address, budget) -> ParcelRecord | None` — search by address
   - `async def lookup_by_point(lon, lat, budget) -> ParcelRecord | None` — search by map click
   - `async def query_adjacent(geometry, budget, exclude_ids, limit) -> list[ParcelRecord]` — ring expansion
   - `async def geocode_address(address) -> list[dict]` — built-in geocoder (may return empty)
   - `name: str` — property identifying the county
2. **Refactor `WrightParcelService`** to implement the `ParcelProvider` protocol (no behavioral changes, just make it conform).
3. **Create `backend/services/factory.py`** — a provider registry/factory that resolves a county by name and instantiates the correct provider with its config.
4. **Update `backend/main.py`**:
   - Accept a `county` query/body parameter (default: `wright`)
   - Instantiate providers at startup for all three counties
   - Route each request to the correct provider

### Verification
- App still works for Wright County (no regression)
- `POST /api/lookup` accepts `county` parameter

---

## Phase 2 — Hennepin County Provider

**Purpose**: Implement the Hennepin County provider with its specific REST endpoint and field mappings.

### Work
1. **Create `backend/services/hennepin.py`** — `HennepinParcelProvider` implementing `ParcelProvider`:
   - Base URL: `https://gis.hennepin.us/arcgis/rest/services/HennepinData/LAND_PROPERTY/MapServer/1`
   - Field mapping: `PID` → parcel_id, `OWNER_NM` → owner, `HOUSE_NO`+`STREET_NM`+`MUNIC_NM`+`ZIP_CD` → address
   - Address lookup chain: exact → fuzzy → (Census geocoder fallback, to be tested)
   - Point-in-parcel: `esriSpatialRelContains` query
   - Adjacent query: `esriSpatialRelTouches`
2. **Register in factory**: `factory.py` maps `"hennepin"` → `HennepinParcelProvider`
3. **Update env example**: Add `DEFAULT_COUNTY` and per-county settings
4. **Update frontend**: Add county selector dropdown

### Verification
- Address lookup works for Hennepin addresses
- Map click works in Hennepin County
- Ring expansion produces adjacent parcels
- CSV/GeoJSON export works

---

## Phase 3 — St. Louis County Provider

**Purpose**: Implement the St. Louis County provider.

### Work
1. **Create `backend/services/stlouis.py`** — `StLouisParcelProvider` implementing `ParcelProvider`:
   - Base URL: `https://gis.stlouiscountymn.gov/server2/rest/services/GeneralUse/Open_Data/MapServer/7`
   - Field mapping: `PRCL_NBR` → parcel_id, `OWNAME` → owner, `PHYSADDR`+`PHYSCITY` → address
   - **Note**: Built-in geocoder returns 0 results; Census geocoder is the primary address fallback
   - Address lookup chain: exact → fuzzy → Census geocoder → point-intersect
   - Point-in-parcel and adjacent queries same pattern as other providers
2. **Register in factory**: `factory.py` maps `"st_louis"` → `StLouisParcelProvider`
3. **Update frontend county selector** to include St. Louis

### Verification
- Address lookup works for St. Louis County addresses
- Map click works in St. Louis County
- Ring expansion produces adjacent parcels
- CSV/GeoJSON export works

---

## Phase 4 — Frontend: Multi-County UI

**Purpose**: Update the UI so users can select and interact with any county.

### Work
1. **Add county selector** to the control panel — dropdown or segmented control with Wright, Hennepin, St. Louis
2. **Adjust map center/zoom** per county when selected:
   - Wright: `[45.2, -93.95]`, zoom 11
   - Hennepin: `[44.95, -93.47]`, zoom 10
   - St. Louis: `[47.5, -92.3]`, zoom 9
3. **Pass county parameter** in both `/api/lookup` and `/api/lookup/point` POST bodies
4. **Update property links** to include county-specific external links (Zillow, county assessor)
5. **Update page title/subheading** to reflect selected county

### Verification
- Selecting a county recenters the map and updates context
- Lookups use the correct county provider
- UI elements reflect the active county

---

## Phase 5 — Testing & Polish

**Purpose**: End-to-end validation across all three counties.

### Work
1. **Smoke test each county** with known addresses:
   - Wright: `4706 Mayer Ave NE St Michael MN 55376`
   - Hennepin: test address in Minneapolis area
   - St. Louis: `4706 Oakley St, Duluth, MN`
2. **Test ring expansion** (0, 1, 2 rings) for each county
3. **Test map-click lookup** in each county
4. **Test caching behavior** — repeated lookups should hit cache
5. **Test LLM normalization/summary** with each provider
6. **Test CSV/GeoJSON export** for each county
7. **Error handling** — verify graceful degradation when a provider returns empty or fails
8. **Update README** with multi-county documentation

### Verification
- All three counties work end-to-end
- No regressions in existing Wright County functionality
- README updated with new county support

---

## File Changes Summary

| File | Action | Description |
|---|---|---|
| `backend/services/provider.py` | **NEW** | `ParcelProvider` protocol/ABC |
| `backend/services/factory.py` | **NEW** | Provider registry & factory |
| `backend/services/hennepin.py` | **NEW** | Hennepin County provider |
| `backend/services/stlouis.py` | **NEW** | St. Louis County provider |
| `backend/services/wright.py` | **MODIFY** | Conform to `ParcelProvider` |
| `backend/services/runner.py` | **MODIFY** | Accept provider instance |
| `backend/main.py` | **MODIFY** | Multi-provider startup, `county` param |
| `backend/static/index.html` | **MODIFY** | County selector UI |
| `backend/static/app.js` | **MODIFY** | County-aware lookups, map recenter |
| `.env.example` | **MODIFY** | `DEFAULT_COUNTY` env var |
| `README.md` | **MODIFY** | Multi-county documentation |

---

## Risk Notes

1. **St. Louis geocoder**: The county's built-in geocoder is non-functional. The Census fallback must work reliably for St. Louis addresses.
2. **Hennepin geocoder**: Not yet tested; we may need to add a Census fallback there too.
3. **API rate limits**: Each county's ArcGIS server may have different rate limiting. The existing budget/retry logic should be sufficient but may need tuning.
4. **CRS/SRID**: All providers must return geometry in WGS84 (EPSG:4326) for Leaflet compatibility. The existing code sets `outSR=4326`.
