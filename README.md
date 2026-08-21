# ParcelPicker

ParcelPicker is a local-first web app for parcel intelligence. It runs on your Mac and exposes a LAN-accessible web interface.

**Live app:** [jsherman999.github.io/parcelpicker](https://jsherman999.github.io/parcelpicker/)

> **New: all-in-browser build.** A no-server static version lives in [`web/`](web/).
> It runs entirely in the browser — calling the county ArcGIS endpoints and a
> geocoder directly (CORS-verified via [`cors-test.html`](cors-test.html)) — with
> IndexedDB caching, client-side exports, and optional LLM assist via your own
> API key. See [`web/README.md`](web/README.md) and the port plan in
> [`docs/in-browser-port-plan.md`](docs/in-browser-port-plan.md). The Python
> backend below remains the reference implementation.

Supports **Wright, Hennepin, and St. Louis counties in Minnesota**, with the full planned phases:

1. Address -> seed parcel lookup (parcel ID, owner, address, geometry).
2. Optional adjacent expansion (`rings=1` or `rings=2`) using parcel-touching geometry.
3. SQLite persistence of runs and parcels.
4. Run exports (`CSV`, `GeoJSON`) and provider safeguards (retry/rate-limit/request budgets).
5. Optional LLM-assisted owner normalization and run summary (OpenAI or OpenRouter, feature-flagged).
6. Map click lookup: click any map location to identify parcel and run ring expansion from that seed.
7. 30-day persistent parcel cache for immediate repeat lookup responses.
8. Property Links panel with Zillow-first external links and Realtor/county fallbacks.

## Counties Supported

Sixteen Minnesota counties are supported. Select one from the dropdown in the web UI; the map center, address placeholder, and external property links update automatically.

| County | Parcel ID field | ArcGIS Server | Spatial Ref |
|---|---|---|---|
| **Wright** | `PID` | `web.co.wright.mn.us/arcgisserver` | 4326 (WGS84) |
| **Hennepin** | `PID` | `gis.hennepin.us/arcgis` | 26915 (UTM 15N) |
| **St. Louis** | `PRCL_NBR` | `gis.stlouiscountymn.gov/server2` | 102100 (Web Mercator) |
| **Sherburne** | `PIN` | `gis.co.sherburne.mn.us/arcgis` | 4326 (WGS84) |
| **Anoka** | `PIN` | `gisservices.co.anoka.mn.us/anoka_gis` | 4326 (WGS84) |
| **Ramsey** | `ParcelID` | `maps.co.ramsey.mn.us/arcgis` | 4326 (WGS84) |
| **Olmsted** | `PIN` | `public.gis.olmstedcounty.gov/arcgis` | 4326 (WGS84) * |
| **Chisago** | `PIN` | `gis.chisagocounty.us/arcgis` | 102100 (Web Mercator) |
| **Morrison** | `PIN` | `services1.arcgis.com (ArcGIS Online)` | 4326 (WGS84) |
| **Scott** | `PID` | `services.arcgis.com (ArcGIS Online)` | 103778 (NAD83 HARN MN South) |
| **Aitkin** | `PRCL_NBR` | `gisweb.co.aitkin.mn.us/arcgis` | 4326 (WGS84) |
| **Koochiching** | `PARCEL_ID` | `services3.arcgis.com (ArcGIS Online)` | 26915 (UTM 15N) |
| **Beltrami** | `PIN` | `arcgis.co.beltrami.mn.us/arcgis` | 4326 (WGS84) |
| **Dakota** | `PIN` | `arcgis.metc.state.mn.us` (MN state) | 26915 (UTM 15N) |
| **Washington** | `PIN` | `arcgis.metc.state.mn.us` (MN state) | 26915 (UTM 15N) |
| **Carver** | `PIN` | `arcgis.metc.state.mn.us` (MN state) | 26915 (UTM 15N) |

\* **Olmsted note:** the county's parcel layer is published with a geometry
offset (≈0.7° east of true WGS84). Address lookups are unaffected, but map
display and map-click / geocode point-intersects may be shifted. See
`county_expansion.md` §2.2.

Dakota, Washington, and Carver are served by the shared MN state parcel
server (`arcgis.metc.state.mn.us`), one layer per county; each query is
constrained with a `CO_NAME` safety clause so a mis-routed request can never
return another county's parcels. Carver uses the `TAX_NAME` field for the
owner (the layer's `OWNER_NAME` column is entirely null, verified 2026-08-21).

## Data Sources

- County ArcGIS parcel layer/query endpoints (machine lookup)
- Hennepin County address points layer (MapServer/0) for address-to-PID resolution
- U.S. Census geocoder (fallback from address to point — cross-county)

## Project Structure

- `backend/main.py` — FastAPI app and API routes.
- `backend/services/base.py` — Abstract base class with shared query/retry/throttle/geometry logic.
- `backend/services/wright.py` — Wright County parcel provider adapter.
- `backend/services/hennepin.py` — Hennepin County parcel provider adapter.
- `backend/services/stlouis.py` — St. Louis County parcel provider adapter.
- `backend/services/registry.py` — County service factory and labels.
- `backend/services/runner.py` — Lookup orchestration/ring traversal (county-agnostic).
- `backend/services/llm.py` — Optional LLM helper client.
- `backend/db.py` — SQLite schema + persistence access.
- `backend/static/index.html` — Web UI.
- `backend/static/app.js` — Frontend lookup/map/table logic.
- `backend/static/styles.css` — Frontend styles.
- `data/app.db` — SQLite database created at runtime.

## Local Setup (macOS)

```bash
cd /Users/jay/opencode/parcelpicker
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python -m backend.main
```

## Access

- Same machine: [http://127.0.0.1:8091](http://127.0.0.1:8091)
- LAN device: `http://<your-mac-lan-ip>:8091`

## Launchd (macOS auto-start)

A LaunchAgent plist is included at `~/Library/LaunchAgents/com.jay.parcelpicker.plist`:

```bash
launchctl load ~/Library/LaunchAgents/com.jay.parcelpicker.plist
```

The app starts automatically at boot and restarts on crash. See `README.md` for path configuration.

## Environment Configuration

Copy `.env.example` to `.env` and set values as needed.

Core settings:

- `HOST` / `PORT`
- `DB_PATH`
- `RETENTION_DAYS` (default `30`)
- `MAX_PARCELS`
- `MAX_REQUESTS_PER_RUN`
- `ADJACENT_LIMIT_PER_PARCEL`
- `REQUEST_TIMEOUT_SECONDS`
- `REQUEST_RETRIES`
- `RETRY_BACKOFF_SECONDS`
- `MIN_REQUEST_INTERVAL_SECONDS`

LLM settings (optional):

- `ENABLE_LLM_ASSIST=true|false`
- `LLM_PROVIDER=openai|openrouter`
- `LLM_MODEL=...`
- `OPENAI_API_KEY=...`
- `OPENROUTER_API_KEY=...`
- `MAX_LLM_NORMALIZATIONS`

## API

### `GET /api/health`

Returns:

```json
{"status":"ok"}
```

### `GET /api/providers/status`

Returns available counties and LLM availability metadata.

```json
{
  "counties": [
    {"id": "wright", "label": "Wright County"},
    {"id": "hennepin", "label": "Hennepin County"},
    {"id": "stlouis", "label": "St. Louis County"}
  ],
  "llm": {"enabled": false, "configured_provider": "openai", "configured_model": "gpt-4o-mini"}
}
```

### `POST /api/lookup`

Request:

```json
{
  "address": "11800 48th St NE, St Michael, MN",
  "rings": 2,
  "use_llm": false,
  "county": "wright"
}
```

- `rings`: `0`, `1`, or `2`
- `county`: `wright`, `hennepin`, or `stlouis` (default `wright`)
- `use_llm`: only applies when `ENABLE_LLM_ASSIST=true` and keys are configured

Success response contains run metadata plus all parcel rows for the run.
- Includes `from_cache` (`true`/`false`) indicating whether results came from 30-day local cache.

### `POST /api/lookup/point`

Request:

```json
{
  "lat": 44.98,
  "lon": -93.27,
  "rings": 1,
  "use_llm": false,
  "county": "hennepin"
}
```

- Uses point-intersect lookup against the selected county's parcels.
- If a parcel is found at the clicked location, it becomes the seed for ring expansion.
- Returns the same run payload structure as `POST /api/lookup`.
- Includes `from_cache` (`true`/`false`) for cache visibility.

### `GET /api/runs?limit=20`

List recent runs.

### `GET /api/runs/{run_id}`

Get full run details (including parcels).

### `GET /api/runs/{run_id}/csv`

Download the run as CSV.

### `GET /api/runs/{run_id}/geojson`

Download the run as GeoJSON FeatureCollection.

## Behavior Notes

- Ring expansion uses `Touches` spatial relation against the current ring geometry set.
- The web UI also supports map-click seeded lookups (uses `/api/lookup/point`).
- After a successful map-click lookup, the seed parcel address is auto-populated into the Property Address field.
- Repeat lookups for known parcels are served from local cache when available within 30 days.
- The web UI shows a Property Links panel for the selected seed parcel:
  - Zillow link first, then Realtor and county/public fallback links.
  - External property links open in new tabs (not embedded iframes).
  - County-specific links (property search, ArcGIS JSON) update based on selected county.
- Runs are bounded by request and parcel caps; capped runs return status `capped`.
- LLM assistance is advisory and never used to invent parcel IDs or owners.
- Owner normalization falls back to deterministic uppercase normalization when LLM is disabled/unavailable.
- All counties use the same `inSR=4326` / `outSR=4326` strategy to normalize spatial reference differences.

## Validation

Basic project validation used during implementation:

```bash
python3 -m compileall backend
```
