# ParcelPicker

ParcelPicker is a local-first web app for parcel intelligence. For Phase 1, it supports **Wright County, Minnesota** and performs a single-property lookup:

1. Accept a street address.
2. Find the parcel record.
3. Return parcel ID + owner name.
4. Display parcel geometry on a map.

## Phase 1 Scope

- County: Wright County, MN only.
- Lookup mode: one property at a time.
- Data source: Wright County ArcGIS parcel service.
- Fallback geocoder: U.S. Census geocoder.
- UI: local web interface served by FastAPI.

## Project Structure

- `/Users/jay/parcelpicker/backend/main.py` - FastAPI app and routes.
- `/Users/jay/parcelpicker/backend/services/wright.py` - Wright County data adapter.
- `/Users/jay/parcelpicker/backend/static/index.html` - web UI.
- `/Users/jay/parcelpicker/backend/static/app.js` - client logic + map rendering.
- `/Users/jay/parcelpicker/backend/static/styles.css` - app styles.
- `/Users/jay/parcelpicker/requirements.txt` - Python dependencies.

## Local Setup (macOS)

```bash
cd /Users/jay/parcelpicker
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8090 --reload
```

Open from the same machine:

- [http://127.0.0.1:8090](http://127.0.0.1:8090)

Open from another device on your LAN:

- `http://<your-mac-lan-ip>:8090`

## Configuration

`.env` values:

- `HOST` (default `0.0.0.0`)
- `PORT` (default `8090`)
- `OPENAI_API_KEY` (reserved for future phases)
- `OPENROUTER_API_KEY` (reserved for future phases)
- `LLM_PROVIDER` and `LLM_MODEL` (reserved for future phases)

## API

### `GET /api/health`
Returns:

```json
{"status":"ok"}
```

### `POST /api/lookup`
Request body:

```json
{"address":"11800 48th St NE, St Michael, MN"}
```

Response body:

```json
{
  "address": "11800 48th St NE, St Michael, MN",
  "parcel_id": "217159001010",
  "owner_name": "Example Owner",
  "site_address": "11800 48TH ST NE",
  "geometry": {"type":"Polygon","coordinates":[[[...]]]},
  "source": "wright_county_arcgis",
  "matched_by": "wright_address"
}
```

## Notes

- The county property-search website is useful for manual validation, but this MVP uses the ArcGIS parcel service for machine queries.
- Future phases add adjacency expansion (ring 1/ring 2), persistence, exports, and optional LLM-assisted analysis.
