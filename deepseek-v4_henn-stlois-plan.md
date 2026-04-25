# Implementation Plan: Add Hennepin & St. Louis Counties

**Status:** Draft
**Based on:** `deepseek-v4_henn-stlois-research.md`

---

## Architecture Summary

Refactor from a single `WrightParcelService` hardwired everywhere to a **strategy
pattern** with a common base class and three county implementations. The runner,
database, and API layer remain county-agnostic — they operate through the base
interface.

```
                    ┌─────────────────────┐
                    │  ParcelLookupRunner  │  ← county-agnostic
                    └──────────┬──────────┘
                               │ uses
                    ┌──────────▼──────────┐
                    │  BaseParcelService   │  ← abstract (query, retry, throttle, geometry)
                    └──┬───────┬──────┬───┘
                       │       │      │
              ┌────────▼┐ ┌────▼──┐ ┌─▼───────────┐
              │ Wright  │ │Hennepin│ │ St. Louis   │
              └─────────┘ └───────┘ └─────────────┘
```

---

## Phase 1: Backend Refactoring

### 1.1 Extract Base Class from `wright.py`

Create `backend/services/base.py` containing:

- `ParcelRecord` dataclass (move from wright.py)
- `RequestBudget` dataclass (move from wright.py)
- `GeocodeResult` dataclass (move from wright.py)
- `BaseParcelService` abstract class with:
  - `__init__` — accepts `client`, `timeout_seconds`, `max_retries`, `retry_backoff_seconds`, `min_interval_seconds`
  - `_throttle()`, `_get_json()` — same as current wright.py
  - `_to_esri_polygon()`, `_geometry_to_geojson()` — same geometry conversion
  - `_normalize_address()`, `_extract_street_address()`, `_sql_escape()`, `_first_feature_with_pid()` — shared utilities
  - `_cache_record()`, `_address_cache`, `_parcel_cache` — shared caching
  - Abstract properties / methods each subclass must define:
    - `endpoint_url` → str
    - `source_label` → str (e.g., `"hennepin_county_arcgis"`)
    - `fields_parcel_id` → str (e.g., `"PID"`)
    - `fields_owner` → str (e.g., `"OWNER_NM"`)
    - `fields_address` → list[str] (e.g., `["PHYSADDR"]`)
    - `build_address(attrs) -> str` — construct full address from attrs dict
  - Concrete methods that use the abstract properties:
    - `lookup(address, budget)` — same flow as current wright.py
    - `lookup_by_point(lon, lat, budget)` — same
    - `query_adjacent(geometry, budget, exclude_ids, limit)` — same
    - `_query_by_address(cleaned, budget)` — uses `fields_address` to build `where` clause
    - `_query_by_point(lon, lat, budget)` — same
    - `_query_county(params, budget)` — replaces `_query_wright`, uses `self.endpoint_url`
    - `_geocode_with_census(address, budget)` — same

### 1.2 Rewrite `wright.py`

Make `WrightParcelService` a thin subclass of `BaseParcelService`:

```python
class WrightParcelService(BaseParcelService):
    endpoint_url = "https://web.co.wright.mn.us/arcgisserver/rest/services/Wright_County_Parcels/MapServer/1/query"
    source_label = "wright_county_arcgis"
    fields_parcel_id = "PID"
    fields_owner = "OWNNAME"
    fields_address = ["PHYSADDR"]
    
    def build_address(self, attrs):
        return str(attrs.get("PHYSADDR") or "").strip()
```

### 1.3 Create `hennepin.py`

```python
class HennepinParcelService(BaseParcelService):
    endpoint_url = "https://gis.hennepin.us/arcgis/rest/services/HennepinData/LAND_PROPERTY/MapServer/1/query"
    address_points_url = "https://gis.hennepin.us/arcgis/rest/services/HennepinData/LAND_PROPERTY/MapServer/0/query"
    source_label = "hennepin_county_arcgis"
    fields_parcel_id = "PID"
    fields_owner = "OWNER_NM"
    fields_address = ["HOUSE_NO", "FRAC_HOUSE_NO", "STREET_NM", "MAILING_MUNIC_NM", "ZIP_CD"]
    
    def build_address(self, attrs):
        house_no = int(attrs.get("HOUSE_NO") or 0)
        frac = str(attrs.get("FRAC_HOUSE_NO") or "").strip()
        street = str(attrs.get("STREET_NM") or "").strip()
        city = str(attrs.get("MAILING_MUNIC_NM") or "").strip()
        zip_code = str(attrs.get("ZIP_CD") or "").strip()
        
        number = str(house_no) + frac if house_no else ""
        parts = [number, street]
        street_line = " ".join(p for p in parts if p).strip()
        return f"{street_line}, {city} MN {zip_code}" if street_line and city else street_line
    
    # Override _query_by_address to also try address points layer
    async def _query_by_address(self, cleaned, budget):
        # First, try the parcel layer directly with LIKE on street components
        ...
        # Fallback: query address points layer for CONCAT_AD match, extract PID, 
        # then query parcel layer by PID
        ...
```

### 1.4 Create `stlouis.py`

```python
class StLouisParcelService(BaseParcelService):
    endpoint_url = "https://gis.stlouiscountymn.gov/server2/rest/services/GeneralUse/Cadastral/MapServer/23/query"
    source_label = "stlouis_county_arcgis"
    fields_parcel_id = "PRCL_NBR"
    fields_owner = "OWNAME"
    fields_address = ["PHYSADDR", "PHYSCITY", "PHYSZIP"]
    
    def build_address(self, attrs):
        street = str(attrs.get("PHYSADDR") or "").strip()
        city = str(attrs.get("PHYSCITY") or "").strip()
        zip_val = attrs.get("PHYSZIP")
        if zip_val is not None:
            zip_str = str(int(zip_val))
        else:
            zip_str = ""
        
        parts = [street]
        if city:
            parts.append(f"{city} MN {zip_str}".strip())
        return ", ".join(p for p in parts if p).strip()
    
    def _feature_to_record(self, feature, matched_by):
        # Override to use different parcel_id field name
        attrs = feature.get("attributes", {})
        geometry = self._geometry_to_geojson(feature.get("geometry"))
        
        parcel_id = str(attrs.get(self.fields_parcel_id) or "").strip()
        owner_name = str(attrs.get(self.fields_owner) or "").strip()
        site_address = self.build_address(attrs)
        
        return ParcelRecord(
            parcel_id=parcel_id,
            owner_name=owner_name,
            site_address=site_address,
            geometry=geometry,
            source=self.source_label,
            matched_by=matched_by,
        )
```

### 1.5 Create Service Registry

Create `backend/services/registry.py`:

```python
from backend.services.wright import WrightParcelService
from backend.services.hennepin import HennepinParcelService
from backend.services.stlouis import StLouisParcelService
from backend.services.base import BaseParcelService

COUNTIES = {
    "wright": WrightParcelService,
    "hennepin": HennepinParcelService,
    "stlouis": StLouisParcelService,
}

def create_service(county: str, **kwargs) -> BaseParcelService:
    cls = COUNTIES.get(county)
    if cls is None:
        raise ValueError(f"Unknown county: {county}. Options: {list(COUNTIES.keys())}")
    return cls(**kwargs)
```

### 1.6 Update `runner.py`

Change `ParcelLookupRunner` to accept `BaseParcelService` instead of `WrightParcelService`.
The `provider` field on runs becomes dynamic (passed in, not hardcoded `"wright_county_arcgis"`).

Add `county` parameter to `run_lookup()` and `run_lookup_from_point()`.

### 1.7 Update `main.py`

- Replace single `parcel_service: WrightParcelService` with a dict/map `parcel_services: dict[str, BaseParcelService]` (one per county for efficiency — all share the same httpx client)
- Or create services on-demand in each request handler
- Add `county` field to `LookupRequest` and `PointLookupRequest` Pydantic models
- `/api/providers/status` returns list of available counties
- Route handlers pass `county` to the runner

---

## Phase 2: Frontend Changes

### 2.1 County Selector

Add a `<select id="county">` dropdown to the UI with options:
- `wright` — Wright County
- `hennepin` — Hennepin County
- `stlouis` — St. Louis County

### 2.2 Dynamic Map Center

| County | Default center | Default zoom |
|---|---|---|
| Wright | `[45.2, -93.95]` | 11 |
| Hennepin | `[44.98, -93.27]` | 12 |
| St. Louis | `[46.79, -92.10]` | 10 |

Move map center/zoom to a config object in app.js, switch on county selection.

### 2.3 Dynamic Property Links

`buildPropertyLinks()` currently hardcodes Wright County links. Update to use
per-county link templates:

| County | Property Search link | ArcGIS JSON link |
|---|---|---|
| Wright | `propertyaccess.co.wright.mn.us/...` | `web.co.wright.mn.us/arcgisserver/...` |
| Hennepin | `https://gis.hennepin.us/property/map/?pid={PID}` | `gis.hennepin.us/arcgis/rest/...` |
| St. Louis | `https://www.stlouiscountymn.gov/departments-a-z/assessor/property-information` | `gis.stlouiscountymn.gov/server2/rest/...` |

Zillow/Realtor queries append `"{County Name} County MN"` instead of always `"Wright County MN"`.

### 2.4 API Calls

Add `county: document.getElementById("county").value` to both `fetch()` request bodies.

### 2.5 UI Text

- Title: `ParcelPicker` (drop county from title, or make dynamic)
- Subheading: Update dynamically based on selected county

---

## Phase 3: Testing

### 3.1 Manual Smoke Tests

For each county, verify:
1. Address lookup with a known address returns the correct parcel
2. Address lookup with a partial/vague address still resolves
3. Map click lookup returns the correct parcel
4. Ring 1 expansion returns adjacent parcels
5. Ring 2 expansion works (may hit request budget)
6. Census geocoder fallback triggers when address not found in ArcGIS
7. Cache hit works (repeat the same query within 30 days)
8. CSV and GeoJSON exports include correct source field
9. Property links open the correct external sites

### 3.2 Test Addresses

**Hennepin:**
- `1945 Drew Ave S, Minneapolis MN 55416`
- `247 Cedar Lake Rd N, Minneapolis MN 55405`

**St. Louis:**
- `121 Hawthorne Rd, Duluth MN 55812`
- `100 N 5th Ave W, Duluth MN 55802`

**Wright (existing, regression):**
- `4706 Mayer Ave NE, St Michael MN 55376`

---

## Phase 4: Configuration

### 4.1 `.env` / Environment

No new env vars needed. Per-county endpoint URLs are hardcoded in each service class
(same pattern as Wright currently uses). Future enhancement could make endpoints
configurable.

### 4.2 `requirements.txt`

No new dependencies. Everything uses `httpx` which is already included.

---

## Files Changed (Summary)

| File | Action | Description |
|---|---|---|
| `backend/services/base.py` | **NEW** | Abstract base class with shared logic |
| `backend/services/wright.py` | **MODIFY** | Refactor to thin subclass of BaseParcelService |
| `backend/services/hennepin.py` | **NEW** | Hennepin County implementation |
| `backend/services/stlouis.py` | **NEW** | St. Louis County implementation |
| `backend/services/registry.py` | **NEW** | County service factory |
| `backend/services/runner.py` | **MODIFY** | Accept BaseParcelService, add county param |
| `backend/main.py` | **MODIFY** | Multi-county service init, new request fields |
| `backend/static/index.html` | **MODIFY** | County selector dropdown, dynamic text |
| `backend/static/app.js` | **MODIFY** | County-aware map, links, API calls |
