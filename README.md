# ParcelPicker

ParcelPicker is a local-first web app for parcel intelligence. It runs on your Mac and exposes a LAN-accessible web interface.

Current implementation supports **Wright County, Minnesota** with the full planned phases:

1. Address -> seed parcel lookup (parcel ID, owner, address, geometry).
2. Optional adjacent expansion (`rings=1` or `rings=2`) using parcel-touching geometry.
3. SQLite persistence of runs and parcels.
4. Run exports (`CSV`, `GeoJSON`) and provider safeguards (retry/rate-limit/request budgets).
5. Optional LLM-assisted owner normalization and run summary (OpenAI or OpenRouter, feature-flagged).

## Data Sources (MVP)

- Wright County ArcGIS parcel layer/query endpoint (machine lookup)
- U.S. Census geocoder (fallback from address to point)

## Project Structure

- `/Users/jay/parcelpicker/backend/main.py` - FastAPI app and API routes.
- `/Users/jay/parcelpicker/backend/services/wright.py` - Wright County parcel provider adapter.
- `/Users/jay/parcelpicker/backend/services/runner.py` - lookup orchestration/ring traversal.
- `/Users/jay/parcelpicker/backend/services/llm.py` - optional LLM helper client.
- `/Users/jay/parcelpicker/backend/db.py` - SQLite schema + persistence access.
- `/Users/jay/parcelpicker/backend/static/index.html` - web UI.
- `/Users/jay/parcelpicker/backend/static/app.js` - frontend lookup/map/table logic.
- `/Users/jay/parcelpicker/backend/static/styles.css` - frontend styles.
- `/Users/jay/parcelpicker/data/app.db` - SQLite database created at runtime.

## Local Setup (macOS)

```bash
cd /Users/jay/parcelpicker
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8090 --reload
```

## Access

- Same machine: [http://127.0.0.1:8090](http://127.0.0.1:8090)
- LAN device: `http://<your-mac-lan-ip>:8090`

## Environment Configuration

Copy `.env.example` to `.env` and set values as needed.

Core settings:

- `HOST` / `PORT`
- `DB_PATH`
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

Returns provider and LLM availability metadata.

### `POST /api/lookup`

Request:

```json
{
  "address": "11800 48th St NE, St Michael, MN",
  "rings": 2,
  "use_llm": false
}
```

- `rings`: `0`, `1`, or `2`
- `use_llm`: only applies when `ENABLE_LLM_ASSIST=true` and keys are configured

Success response contains run metadata plus all parcel rows for the run.

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
- Runs are bounded by request and parcel caps; capped runs return status `capped`.
- LLM assistance is advisory and never used to invent parcel IDs or owners.
- Owner normalization falls back to deterministic uppercase normalization when LLM is disabled/unavailable.

## Validation

Basic project validation used during implementation:

```bash
python3 -m compileall backend
```
