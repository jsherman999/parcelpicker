# ParcelPicker

ParcelPicker is a local-first web app for parcel intelligence. It runs on your Mac and exposes a LAN-accessible web interface.

## Supported Counties

ParcelPicker currently supports **three Minnesota counties**:

| County | Slug | Data Source |
|---|---|---|
| Wright County | `wright` | [ArcGIS Server](https://web.co.wright.mn.us/arcgisserver/rest/services/Wright_County_Parcels/MapServer/1) |
| Hennepin County | `hennepin` | [ArcGIS Server](https://gis.hennepin.us/arcgis/rest/services/HennepinData/LAND_PROPERTY/MapServer/1) |
| St. Louis County | `st_louis` | [ArcGIS Server](https://gis.stlouiscountymn.gov/server2/rest/services/GeneralUse/Open_Data/MapServer/7) |

All counties support the full feature set:

1. Address -> seed parcel lookup (parcel ID, owner, address, geometry).
2. Optional adjacent expansion (`rings=1` or `rings=2`) using parcel-touching geometry.
3. SQLite persistence of runs and parcels.
4. Run exports (`CSV`, `GeoJSON`) and provider safeguards (retry/rate-limit/request budgets).
5. Optional LLM-assisted owner normalization and run summary (OpenAI or OpenRouter, feature-flagged).
6. Map click lookup: click any map location to identify parcel and run ring expansion from that seed.
7. 30-day persistent parcel cache for immediate repeat lookup responses.
8. Property Links panel with Zillow-first external links and county-specific fallbacks.

### Adding a New County

New counties are added by implementing the `ParcelProvider` protocol in `backend/services/provider.py`. See the existing providers (`wright.py`, `hennepin.py`, `stlouis.py`) as templates. Register the new provider in `backend/services/factory.py`.

## Data Sources

- County ArcGIS parcel layers (machine lookup with `Touches` spatial queries)
- U.S. Census geocoder (fallback from address to coordinates)

## Project Structure

- `backend/main.py` — FastAPI app and API routes.
- `backend/services/provider.py` — `ParcelProvider` protocol and shared dataclasses.
- `backend/services/factory.py` — Provider registry and factory function.
- `backend/services/wright.py` — Wright County provider.
- `backend/services/hennepin.py` — Hennepin County provider.
- `backend/services/stlouis.py` — St. Louis County provider.
- `backend/services/runner.py` — Lookup orchestration and ring traversal.
- `backend/services/llm.py` — Optional LLM helper client.
- `backend/db.py` — SQLite schema + persistence.
- `backend/static/index.html` — Web UI.
- `backend/static/app.js` — Frontend logic (map, table, lookups).
- `backend/static/styles.css` — Frontend styles.
- `data/app.db` — SQLite database created at runtime.

## Local Setup (macOS)

```bash
cd /Users/jay/parcelpicker
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8091 --reload
```

## Access

- Same machine: [http://127.0.0.1:8091](http://127.0.0.1:8091)
- LAN device: `http://<your-mac-lan-ip>:8091`

## Environment Configuration

Copy `.env.example` to `.env` and set values as needed.

Core settings:

- `HOST` / `PORT`
- `DB_PATH`
- `DEFAULT_COUNTY` (default `wright`)
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

Returns available counties, default county, and LLM availability metadata.

```json
{
  "available_counties": ["hennepin", "st_louis", "wright"],
  "default_county": "wright",
  "llm": { "enabled": false, ... }
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

- `county`: one of `wright`, `hennepin`, `st_louis` (default: `wright`)
- `rings`: `0`, `1`, or `2`
- `use_llm`: only applies when `ENABLE_LLM_ASSIST=true` and keys are configured

Success response contains run metadata plus all parcel rows for the run.
- Includes `from_cache` (`true`/`false`) indicating whether results came from 30-day local cache.

### `POST /api/lookup/point`

Request:

```json
{
  "lat": 45.2199,
  "lon": -93.63298,
  "rings": 1,
  "use_llm": false,
  "county": "wright"
}
```

- Uses point-intersect lookup against the selected county's parcel layer.
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
- Selecting a county in the UI recenters the map and updates context (title, placeholder, property links).
- After a successful map-click lookup, the seed parcel address is auto-populated into the Property Address field.
- Repeat lookups for known parcels are served from local cache when available within 30 days.
- The web UI shows a Property Links panel for the selected seed parcel:
  - Zillow link first, then Realtor and county-specific fallback links.
  - External property links open in new tabs (not embedded iframes).
- Runs are bounded by request and parcel caps; capped runs return status `capped`.
- LLM assistance is advisory and never used to invent parcel IDs or owners.
- Owner normalization falls back to deterministic uppercase normalization when LLM is disabled/unavailable.

## Validation

Basic project validation used during implementation:

```bash
python3 -m compileall backend
```
