# ParcelPicker

ParcelPicker is a local-first web app for parcel intelligence. It runs on your Mac and exposes a LAN-accessible web interface.

Current implementation supports **Wright County, Minnesota** with the full planned phases:

1. Address -> seed parcel lookup (parcel ID, owner, address, geometry).
2. Optional adjacent expansion (`rings=1` or `rings=2`) using parcel-touching geometry.
3. SQLite persistence of runs and parcels.
4. Run exports (`CSV`, `GeoJSON`) and provider safeguards (retry/rate-limit/request budgets).
5. Optional LLM-assisted owner normalization and run summary (OpenAI or OpenRouter, feature-flagged).
6. Map click lookup: click any map location to identify parcel and run ring expansion from that seed.
7. 30-day persistent parcel cache for immediate repeat lookup responses.
8. Property Links panel with Zillow-first external links and Realtor/county fallbacks.
9. **Locate Me**: phone geolocation via browser GPS — auto-runs a 2-ring scan from your current position.

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
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8091 --reload
```

## Access

- Same machine: [http://127.0.0.1:8091](http://127.0.0.1:8091)
- LAN device: `http://<your-mac-lan-ip>:8091`

### Remote Access via Tailscale (iPhone / off-network)

[Tailscale](https://tailscale.com/) creates a private WireGuard mesh network so your iPhone can reach the Mac from anywhere — no port-forwarding or public exposure needed.

1. Install Tailscale on both your Mac and iPhone and sign in to the same Tailnet.
2. Find your Mac's Tailscale IP (`100.x.x.x`) in the Tailscale admin console or via `tailscale ip -4`.
3. Open `http://100.x.x.x:8091` in Safari on the iPhone.

**HTTPS for Geolocation (required by iOS Safari):**

The browser Geolocation API requires a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts). Safari on iOS will block `navigator.geolocation` over plain `http://` to a Tailscale IP. To fix this, enable Tailscale HTTPS:

```bash
# On the Mac — enable MagicDNS + HTTPS in the Tailscale admin console first, then:
tailscale cert <your-mac-hostname>.<tailnet-name>.ts.net
```

Then access ParcelPicker at `https://<your-mac-hostname>.<tailnet-name>.ts.net:8091`. The Locate Me button will work with full GPS accuracy.

Alternatively, Tailscale Funnel can expose the app with a public TLS URL if you want to skip local cert setup, but Funnel makes the app reachable from the open internet — use with caution.

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
- Includes `from_cache` (`true`/`false`) indicating whether results came from 30-day local cache.

### `POST /api/lookup/point`

Request:

```json
{
  "lat": 45.2199,
  "lon": -93.63298,
  "rings": 1,
  "use_llm": false
}
```

- Uses point-intersect lookup against Wright parcels.
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
- The **Locate Me** button uses the browser Geolocation API to get the device's GPS position, places a marker on the map, auto-sets rings to 2, and runs a point lookup at that location. This is designed for mobile use via Tailscale — tap the button on your iPhone to scan the parcel you're standing on plus two rings of neighbors.
- After a successful map-click or geo-located lookup, the seed parcel address is auto-populated into the Property Address field.
- Repeat lookups for known parcels are served from local cache when available within 30 days.
- The web UI shows a Property Links panel for the selected seed parcel:
- Zillow link first, then Realtor and county/public fallback links.
- External property links open in new tabs (not embedded iframes).
- Runs are bounded by request and parcel caps; capped runs return status `capped`.
- LLM assistance is advisory and never used to invent parcel IDs or owners.
- Owner normalization falls back to deterministic uppercase normalization when LLM is disabled/unavailable.

## Validation

Basic project validation used during implementation:

```bash
python3 -m compileall backend
```
