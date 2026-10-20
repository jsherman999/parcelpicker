# ParcelPicker

ParcelPicker is a local-first web app for parcel intelligence. It runs on your Mac and exposes a LAN-accessible web interface.

**Live app:** [jsherman999.github.io/parcelpicker](https://jsherman999.github.io/parcelpicker/)

**Credits:** the parcel layer specs behind 58 of the supported counties come from
[ErisData](https://github.com/Eriskii/ErisData) by Eriskii, licensed
[CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). The bundled copy is
adapted and live-verified (see [Credits and licenses](#credits-and-licenses)).

> **New: all-in-browser build.** A no-server static version lives in [`web/`](web/).
> It runs entirely in the browser — calling the county ArcGIS endpoints and a
> geocoder directly (CORS-verified via [`cors-test.html`](cors-test.html)) — with
> IndexedDB caching, client-side exports, and optional LLM assist via your own
> API key. See [`web/README.md`](web/README.md) and the port plan in
> [`docs/in-browser-port-plan.md`](docs/in-browser-port-plan.md). The Python
> backend below remains the reference implementation.

Supports **75 of Minnesota's 87 counties** in the in-browser build (the Python backend covers the original 16), with the full planned phases:

1. Address -> seed parcel lookup (parcel ID, owner, address, geometry).
2. Optional adjacent expansion (`rings=1` or `rings=2`) using parcel-touching geometry.
3. SQLite persistence of runs and parcels.
4. Run exports (`CSV`, `GeoJSON`) and provider safeguards (retry/rate-limit/request budgets).
5. Optional LLM-assisted owner normalization and run summary (OpenAI or OpenRouter, feature-flagged).
6. Map click lookup: click any map location to identify parcel and run ring expansion from that seed.
7. 30-day persistent parcel cache for immediate repeat lookup responses.
8. Property Links panel with Zillow-first external links and Realtor/county fallbacks.

## Counties Supported

The in-browser build supports 75 Minnesota counties: 17 with hand-written providers (below) and 58 driven by bundled ErisData adapter specs (further below). Select one from the dropdown; the map center, address placeholder, and external links update automatically. Clicking the map inside another supported county switches to it, and a click inside an unsupported county says why it isn't supported.

| County | Parcel ID field | ArcGIS Server | Spatial Ref |
|---|---|---|---|
| **Wright** | `PID` | `web.co.wright.mn.us/arcgisserver` | 4326 (WGS84) |
| **Hennepin** | `PID` | `gis.hennepin.us/arcgis` | 26915 (UTM 15N) |
| **St. Louis** | `PRCL_NBR` | `gis.stlouiscountymn.gov/server2` | 102100 (Web Mercator) |
| **Sherburne** | `PIN` | `gis.co.sherburne.mn.us/arcgis` | 4326 (WGS84) |
| **Anoka** | `PIN` | `gisservices.co.anoka.mn.us/anoka_gis` | 4326 (WGS84) |
| **Ramsey** | `ParcelID` | `maps.co.ramsey.mn.us/arcgis` | 4326 (WGS84) |
| **Olmsted** | `PIN` | `public.gis.olmstedcounty.gov/arcgis` | 4326 (WGS84) |
| **Chisago** | `PIN` | `gis.chisagocounty.us/arcgis` | 102100 (Web Mercator) |
| **Morrison** | `PIN` | `services1.arcgis.com (ArcGIS Online)` | 4326 (WGS84) |
| **Scott** | `PID` | `services.arcgis.com (ArcGIS Online)` | 103778 (NAD83 HARN MN South) |
| **Aitkin** | `PRCL_NBR` | `gisweb.co.aitkin.mn.us/arcgis` | 4326 (WGS84) |
| **Koochiching** | `PARCEL_ID` | `services3.arcgis.com (ArcGIS Online)` | 26915 (UTM 15N) |
| **Beltrami** | `PIN` | `arcgis.co.beltrami.mn.us/arcgis` | 4326 (WGS84) |
| **Dakota** | `PIN` | `arcgis.metc.state.mn.us` (MN state) | 26915 (UTM 15N) |
| **Washington** | `PIN` | `arcgis.metc.state.mn.us` (MN state) | 26915 (UTM 15N) |
| **Carver** | `PIN` | `arcgis.metc.state.mn.us` (MN state) | 26915 (UTM 15N) |
| **Blue Earth** | `SDEDATA.TaxParcel.ParcelNo` | `gis.blueearthcountymn.gov/server` | 102100 (Web Mercator) |

Dakota, Washington, and Carver are served by the shared MN state parcel
server (`arcgis.metc.state.mn.us`), one layer per county; each query is
constrained with a `CO_NAME` safety clause so a mis-routed request can never
return another county's parcels. Carver uses the `TAX_NAME` field for the
owner (the layer's `OWNER_NAME` column is entirely null, verified 2026-08-21).

Blue Earth uses the county's `LandRecords/TaxParcelsWGS84` layer, which joins
the parcel fabric to the county's ownership table, so its field names are
table-qualified (`Ownership.OWNNAME`, `Ownership.PHYSADDR`). Owner and
estimated market value are filled for 98.9% and 98.8% of its 33,636 parcels
(whole layer, checked 2026-10-17). The layer rejects `resultRecordCount`, so
the adjacency limit is applied in the browser, and long queries go out as a
form POST (GETs past about 9,000 characters return HTTP 414). Filters on the
joined ownership fields take about 10 seconds, so an address is first looked
up in the county's `LandRecords/AddressPoints` layer (about 0.2 seconds; 98% of
sampled points fall in an owner-filled parcel) and the parcel under that
point is used. The parcel site address (`Ownership.PHYSADDR`) is the second
try, then the geocoder. Some street addresses recur across its towns
(`101 E MAIN ST` is in Mankato, St. Clair and Vernon Center), so the typed
city or ZIP picks the town.

### Spec-driven counties (ErisData)

These 58 counties use one generic provider, `web/js/providers/spec.js`, driven
by `web/mn_parcel_specs.json`. That file is a verified subset of the
[ErisData](https://github.com/Eriskii/ErisData) parcel adapter registry
(CC-BY-4.0, by Eriskii; see *Credits and licenses*). Each entry names an ArcGIS
layer, its parcel ID / owner / address fields, and, for the statewide MnGeo
layer, a filter clause that pins every query to that county. On 2026-10-16 every
endpoint was checked live for CORS from `https://jsherman999.github.io`, for an
owner-filled parcel from a point intersect inside the county's Census boundary,
for adjacency, and for long-query POST support. Each county's example address
was geocoded and looked up through the app. The scripts are in
[`tools/eris_specs/`](tools/eris_specs/).

**Address lookup** names the county field that the address search matches
first (house number + street, as a prefix match). Counties marked
*geocode → point* have no usable site-address field: ErisData's mapping was
street-name-only, house-number-only, or the taxpayer's mailing address. Their
address searches geocode with Nominatim and then take the parcel under the
point. Map clicks never need the geocoder. No county property-search page is
linked for these counties; the Property Links panel offers Zillow, Realtor, and
the layer's Parcel JSON.

| County | Parcel ID | Owner | Address lookup | Server | Notes |
|---|---|---|---|---|---|
| Benton | `TaxPIN` | `TAXPAYER_NAME1` | `PROPERTY_ADDRESS` | `services.arcgis.com` |  |
| Big Stone | `PARCEL_NUMBER` | `TAXPAYER_NAME` | geocode → point | `services7.arcgis.com` |  |
| Carlton | `PARCELID` | `OWNAME` | geocode → point | `gis.co.carlton.mn.us` |  |
| Cass | `county_pin` | `owner_name` | geocode → point | `enterprise.gisdata.mn.gov` | statewide MnGeo layer, `co_name = 'Cass'` |
| Chippewa | `state_pin` | `owner_name` | geocode → point | `enterprise.gisdata.mn.gov` | statewide MnGeo layer, `co_code = '27023'` |
| Clay | `PIN` | `TAX_NAME` | `PropertyAddress` | `gis23.claycountymn.gov` |  |
| Clearwater | `county_pin` | `tax_name` | geocode → point | `enterprise.gisdata.mn.gov` | statewide MnGeo layer, `co_name = 'Clearwater'` |
| Cook | `COUNTY_PIN` | `OWNER_NAME` | geocode → point | `services.arcgis.com` |  |
| Cottonwood | `PIN` | `deedhold` | geocode → point | `services6.arcgis.com` |  |
| Crow Wing | `PIN` | `OWNAME` | geocode → point | `gis.crowwing.us` |  |
| Dodge | `PIN` | `C0NAME1P` | `FULL_ADD` | `publicmaps.co.goodhue.mn.us` |  |
| Douglas | `PIN` | `TXOTXT_NAM` | `TXPADR1` | `dc-web-2.co.douglas.mn.us` |  |
| Faribault | `COUNTY_PIN` | `TAX_NAME` | geocode → point | `services2.arcgis.com` |  |
| Freeborn | `PIN` | `DEEDHOLDER` | geocode → point | `services3.arcgis.com` |  |
| Goodhue | `PIN` | `C0NAME1P` | `FULLSTREET` | `publicmaps.co.goodhue.mn.us` |  |
| Grant | `PARCELID` | `TAXPAYER_NAME` | geocode → point | `gis.co.grant.mn.us` |  |
| Hubbard | `hubbgis_GIS_Parcels_PIN` | `PINAME1` | geocode → point | `gis.co.hubbard.mn.us` |  |
| Isanti | `PARCELID` | `OWNERNME1` | geocode → point | `gis.co.isanti.mn.us` |  |
| Itasca | `PRCL_NBR` | `TAO_NAME` | geocode → point | `maps.co.itasca.mn.us` |  |
| Jackson | `county_pin` | `owner_name` | geocode → point | `enterprise.gisdata.mn.gov` | statewide MnGeo layer, `co_name = 'Jackson'` |
| Kanabec | `PIN` | `OWNER_ORIG` | `SiteAddress` | `wfs.schneidercorp.com` |  |
| Lac qui Parle | `PIN` | `OWNERNAME` | `PHYADD` | `services5.arcgis.com` |  |
| Lake | `gis_pid` | `tax_ownname` | geocode → point | `enterprise.gisdata.mn.gov` |  |
| Lake of the Woods | `county_pin` | `tax_name` | geocode → point | `services.arcgis.com` | **2021 data:** parcel data is a 2021 snapshot, so owners may be out of date |
| Le Sueur | `PARCEL_NUMBER` | `OWNER_NAME_1` | geocode → point | `gis.co.le-sueur.mn.us` |  |
| Lincoln | `PARCEL_NUM` | `TP_NAME1` | geocode → point | `services2.arcgis.com` |  |
| Lyon | `Parcel_ID` | `TXTNAM` | geocode → point | `services.arcgis.com` |  |
| Mahnomen | `Parcel_Num` | `TAXPAYER_NAME` | geocode → point | `services8.arcgis.com` |  |
| Marshall | `PARCELID` | `TAXPAYER_NAME` | `PROPERTY_ADDRESS` | `gis.co.marshall.mn.us` |  |
| Martin | `parcel_id` | `owner` | `address` | `services.arcgis.com` | **partial:** parcel data covers rural parcels only; Fairmont, Truman and Ceylon are missing |
| McLeod | `county_pin` | `tax_name` | geocode → point | `enterprise.gisdata.mn.gov` | statewide MnGeo layer, `co_name = 'McLeod'` |
| Meeker | `PID` | `NAME` | geocode → point | `services2.arcgis.com` |  |
| Mille Lacs | `county_pin` | `tax_name` | geocode → point | `enterprise.gisdata.mn.gov` | statewide MnGeo layer, `co_name = 'Mille Lacs'` |
| Mower | `state_pin` | `owner_name` | geocode → point | `enterprise.gisdata.mn.gov` | statewide MnGeo layer, `co_code = '27099'` |
| Murray | `county_pin` | `owner_name` | geocode → point | `enterprise.gisdata.mn.gov` | statewide MnGeo layer, `co_name = 'Murray'` |
| Nobles | `PIN` | `TaxName` | `PropAddr1` | `services5.arcgis.com` | **partial:** parcel data covers the Worthington area only |
| Norman | `PARCELID` | `TAXPAYER_NAME` | geocode → point | `gis.co.norman.mn.us` |  |
| Otter Tail | `PIN` | `OWNNAME` | geocode → point | `web2.co.ottertail.mn.us` |  |
| Pennington | `PARCELNUM` | `OWNER_NAME_1` | geocode → point | `gismap.co.pennington.mn.us` |  |
| Pine | `parcelid` | `ownername1` | geocode → point | `gis.co.pine.mn.us` |  |
| Pipestone | `PARCEL_NUMBER` | `OWNER_NAME` | geocode → point | `gis.pcmn.us` |  |
| Polk | `Parcel_ID` | `CurOwnerName` | geocode → point | `gis.co.polk.mn.us` |  |
| Pope | `PARCEL_NUMBER` | `TAXPAYER_NAME` | geocode → point | `gis.popecountymn.gov` |  |
| Red Lake | `county_pin` | `tax_name` | geocode → point | `enterprise.gisdata.mn.gov` | statewide MnGeo layer, `co_code = '27125'` |
| Renville | `PARCEL_NUMBER` | `TAXPAYER_NAME` | geocode → point | `gis.renvillecountymn.gov` |  |
| Rice | `COUNTY_PIN` | `OWNER_NAME` | `SiteAddrFull` | `asr-arcgis01.ricecountymn.gov` |  |
| Roseau | `PIN` | `TaxName` | geocode → point | `gis.co.roseau.mn.us` |  |
| Sibley | `PID` | `TAXPAYER_NAME` | geocode → point | `gis.sibleycounty.gov` |  |
| Stearns | `TAXPARCEL` | `OWNER` | `PROPADDR` | `gis.co.stearns.mn.us` |  |
| Steele | `PIN` | `OWNAME` | `QRYADDRESS` | `gis.steele.mn` |  |
| Stevens | `PIN` | `Name` | geocode → point | `services2.arcgis.com` |  |
| Swift | `PIN` | `OWNAME` | geocode → point | `services3.arcgis.com` |  |
| Traverse | `PARCEL_NUM` | `TAXPAYER_N` | geocode → point | `services.arcgis.com` | **2019 data:** parcel data is from tax year 2019, so owners may be out of date |
| Wabasha | `county_pin` | `owner_name` | geocode → point | `enterprise.gisdata.mn.gov` | filter `county_pin IS NOT NULL AND objectid NOT IN (7709, 8246)` |
| Wadena | `PARCEL_NUM` | `TAXPAYER_NAME` | `PHYSICAL_ADDRESS` | `gis.co.wadena.mn.us` |  |
| Wilkin | `PARCELID` | `TAXPAYER_NAME` | geocode → point | `gisweb.co.wilkin.mn.us` |  |
| Winona | `PARCEL_NUM` | `own1` | geocode → point | `services.arcgis.com` |  |
| Yellow Medicine | `PARCEL_NUMBER` | `TAXPAYER_NAME` | geocode → point | `gis.co.ym.mn.gov` |  |

### Not supported

| County | Why |
|---|---|
| Kandiyohi | Parcel data is paywalled (ErisData) |
| Kittson, Redwood, Rock | Only a parcel viewer is published, with no queryable layer (ErisData) |
| Becker, Brown, Houston, Waseca | The public parcel layer has no owner field |
| Watonwan | Owner names are filled for only a few parcels |
| Fillmore | The parcel server is http-only (https times out), which browsers block on an https page |
| Todd | Owner is `'0'` for 94% of parcels |
| Nicollet | The only public layer is a 2021 snapshot of part of North Mankato, with owner last names only |

### Market value and land use

The results table, map popups, and CSV/GeoJSON exports include **Est. market
value** and **Land use / class** wherever the county's layer publishes them.
In Minnesota the "assessed value" is the county's Estimated Market Value. The
value shows the assessment or market year when the layer has one (for example
`MKT_YEAR`, `ASMT_YR`, `AssessmentYear`, `EMVYear`); tax-payable years are not
used. Missing values (`-9999`, `0`, `NULL`, blanks) show "—". Land use is shown
as the county gives it: a description, a Minnesota tax-class string
(`2A AGRICULTURAL`), or a bare local code (`201`, `662`). Sherburne has no total
field, so its value is `EMV_LAND` + `EMV_BLDG`.

Fields were checked on 2026-10-16 against about 300 parcels per layer, sampled
evenly across the layer. Every field kept is at least 50% filled; most are over
90%.

- **Both value and land use (34):** Aitkin, Anoka, Beltrami, Carlton, Carver, Cass, Chisago, Clay, Clearwater, Cook, Crow Wing, Dakota, Hennepin, Hubbard, Isanti, Itasca, Jackson, Le Sueur, Lyon, Morrison, Mower, Olmsted, Pipestone, Pope, Ramsey, Rice, Scott, Sherburne, St. Louis, Stearns, Wabasha, Washington, Winona, Wright.
- **Value only (3):** Blue Earth, Lake, Wilkin.
- **Land use only (13):** Chippewa, Cottonwood, Koochiching, Lake of the Woods, Martin, McLeod, Mille Lacs, Nobles, Otter Tail, Pine, Renville, Sibley, Steele. Koochiching
  publishes only a land-only value (`TAXABLELANDVALUE`, about 30% filled), and
  Lake of the Woods' values are from 2021.
- **Neither (25):** Benton, Big Stone, Dodge, Douglas, Faribault, Freeborn, Goodhue, Grant, Kanabec, Lac qui Parle, Lincoln, Mahnomen, Marshall, Meeker, Murray, Norman, Pennington, Polk, Red Lake, Roseau, Stevens, Swift, Traverse, Wadena, Yellow Medicine.
- **Value year shown (18):** Aitkin, Blue Earth, Chisago, Clay, Clearwater, Cook, Crow Wing, Dakota, Lake, Mower, Ramsey, Rice, Scott, St. Louis, Stearns, Wabasha, Washington, Wright.

The Python backend (`backend/`) does not have these fields yet.

## Data Sources

- County ArcGIS parcel layer/query endpoints (machine lookup)
- Hennepin County address points layer (MapServer/0) for address-to-PID resolution
- U.S. Census geocoder (backend fallback from address to point); the in-browser build uses Nominatim instead
- ErisData parcel adapter specs for the 58 spec-driven counties (see below)
- U.S. Census Bureau TIGERweb county boundaries (`web/county_boundaries.geojson`, all 87 counties)

## Credits and licenses

- **Parcel layer specs:** `web/mn_parcel_specs.json` is adapted from the
  [ErisData](https://github.com/Eriskii/ErisData) `GIS/parcels` adapter registry
  by Eriskii, licensed [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/).
  Changes: subset to the Minnesota counties without a hand-written provider;
  field names case-corrected and http URLs upgraded to https where needed;
  partial or mailing-address address mappings blanked; map center/zoom,
  example addresses and coverage notes added; counties that failed live checks
  dropped. The app's map attribution credits ErisData whenever a spec-driven
  county is selected.
- **County boundaries:** U.S. Census Bureau TIGERweb (public domain), simplified.
- **Parcel data** belongs to each county, served from its own public ArcGIS
  services (or MnGeo's statewide open parcels layer).

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
  "llm": {"enabled": false, "configured_vendor": "openai", "configured_model": "gpt-4o-mini"}
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
- `county` is the county the run belongs to; parcel IDs are only unique within
  a county, so parcels and cached address lookups are keyed by county.
- `input` is what the run started from: `{"kind": "address", "address": ...}`,
  `{"kind": "point", "lat": ..., "lon": ...}` or `{"kind": "parcel", "parcel_id": ...}`;
  `input_label` is a display string for it.
- `source_id` names the county data source (e.g. `wright_county_arcgis`).
- Each parcel's `matched_by` is one of `address`, `address_point`,
  `geocode_point`, `map_point`, `cache_point`, `adjacent`.

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

- The web UI labels every rendered parcel on the map with its owner name (permanent,
  non-interactive label centered on the parcel; long names truncate, seed parcel highlighted).
- Ring expansion uses `Touches` spatial relation against the current ring geometry set.
- The web UI also supports map-click seeded lookups (uses `/api/lookup/point`).
- After a successful map-click lookup, the seed parcel address is auto-populated into the Property Address field.
- Repeat lookups for known parcels are served from local cache when available within 30 days.
- The web UI shows a Property Links panel for the selected seed parcel:
  - Zillow link first, then Realtor and county/public fallback links.
  - External property links open in new tabs (not embedded iframes).
  - County-specific links (property search, ArcGIS JSON) update based on selected county.
- Runs are bounded by request and parcel caps. A run that hits either one after
  finding its seed returns status `capped` with the parcels found so far, and
  `capped_by` says which (`max_parcels` or `request_budget`).
- Multipart parcels come back as GeoJSON `MultiPolygon`s.
- LLM assistance is advisory and never used to invent parcel IDs or owners.
- Owner normalization falls back to deterministic uppercase normalization when LLM is disabled/unavailable.
- All counties use the same `inSR=4326` / `outSR=4326` strategy to normalize spatial reference differences.

## Validation

Basic project validation used during implementation:

```bash
python3 -m compileall backend
```
