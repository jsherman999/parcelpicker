# ParcelPicker — In-Browser Build

A no-server, static version of ParcelPicker. All lookup orchestration, ring
expansion, and exports run in the browser by calling the county ArcGIS endpoints
and a geocoder directly (CORS-verified — see `../cors-test.html`).

## Status

This is **Phase 1** of the port described in `../docs/in-browser-port-plan.md`:

- ✅ County providers (Wright, Hennepin, St. Louis, Sherburne, Anoka) — ports of
  `backend/services/*.py`
- ✅ Lookup runner: address + map-click seeds, ring expansion, caps
- ✅ Geocoder fallback swapped from Census to Nominatim (bounded to Minnesota)
- ✅ Client-side CSV / GeoJSON export
- ✅ Phase 2: IndexedDB 30-day cache (address aliases + seed-parcel reuse +
  local point-in-polygon seeding) and a Recent Runs history panel
- ✅ Phase 4: LLM owner-normalization/summary via a user-supplied OpenAI or
  OpenRouter key (stored in localStorage, graceful fallback)

The port is feature-complete versus the Python backend.

The Python backend under `../backend/` is left intact as the reference
implementation.

## Run it

It's a static site — serve the `web/` directory with any static server:

```bash
cd web
python3 -m http.server 8000
# open http://localhost:8000/
```

Or deploy the `web/` folder to any static host (GitHub Pages, Netlify, S3).
Re-run `../cors-test.html` from the final deploy origin to confirm the county
servers allow that origin.

## Layout

```
index.html              page shell (Leaflet via CDN)
styles.css              copied from backend/static
county_boundaries.geojson
js/
  app.js                UI + orchestration (was backend/static/app.js)
  config.js             limits + per-request settings
  geocode.js            Nominatim address -> point
  export.js             client-side CSV / GeoJSON
  store.js              IndexedDB cache + history (was db.py)
  llm.js                owner normalize + summary (was services/llm.py)
  runner.js             ring traversal + cache (was services/runner.py)
  providers/
    base.js             was services/base.py
    wright.js hennepin.js stlouis.js sherburne.js anoka.js
    registry.js
```

## Notes / known follow-ups

- **Geocode accuracy:** Nominatim is only the fallback (used when a county's own
  address query misses; map-click never uses it). Bounded to a Minnesota
  viewbox; validate against real addresses and tighten if needed.
- **Persistence:** runs, parcels, and address aliases are cached in IndexedDB
  for 30 days; repeat lookups and clicks inside cached parcels are served
  locally. Clearing site data resets the cache.
- **LLM key:** entered in the LLM Settings panel and kept in `localStorage` on
  this origin only. It is sent only to the chosen provider. Any script on the
  origin can read it, so use a scoped/limited key; "Clear" removes it.
