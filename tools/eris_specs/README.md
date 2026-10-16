# ErisData spec bundle tools

These scripts build `web/mn_parcel_specs.json` (the spec-driven counties) and
`web/county_boundaries.geojson` (all 87 Minnesota counties). The adapter specs
come from [ErisData](https://github.com/Eriskii/ErisData) by Eriskii, licensed
[CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Everything is Python
standard library; every check runs live against the county servers.

## Rebuild

```bash
W=/tmp/eris && mkdir -p $W && cd $W
git clone --depth 1 --filter=blob:none --sparse https://github.com/Eriskii/ErisData.git
git -C ErisData sparse-checkout set GIS
curl -s "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query?where=STATE%3D%2727%27&outFields=NAME,BASENAME,GEOID&outSR=4326&maxAllowableOffset=0.001&geometryPrecision=5&returnGeometry=true&f=geojson" -o tiger.geojson
T=~/cc_projects/parcelpicker/tools/eris_specs
python3 -I $T/verify.py ErisData tiger.geojson verify.json             # CORS, fields, owner point intersect, adjacency
python3 -I $T/owner_fill.py verify.json                                  # owner fill across the whole layer
python3 -I $T/post_cors.py verify.json ~/cc_projects/parcelpicker/web/js/app.js  # long POST + CORS
python3 -I $T/coverage.py verify.json tiger.geojson coverage.json       # grid + town coverage
python3 -I $T/examples_rural.py verify.json tiger.geojson examples.json # example addresses, pass 1
python3 -I $T/examples_town.py verify.json tiger.geojson examples.json  # example addresses, pass 2 (preferred)
python3 -I $T/value_fields.py targets.json values.json            # value / year / land-use fill
python3 -I $T/gen_bundle.py ErisData verify.json examples.json tiger.geojson ~/cc_projects/parcelpicker/web
python3 -I $T/readme_table.py ~/cc_projects/parcelpicker/web/mn_parcel_specs.json  # README table
```

The example scripts call Nominatim at about 1 request per second, so the two
passes take several minutes.

## Decisions encoded in gen_bundle.py

Review these by hand after a rerun:

- `UNSUPPORTED`: counties with no provider, and why (shown in the app when a
  click lands there).
- `ADDRESS_FULL` / `ADDRESS_BLANKED`: which spec address fields hold a full
  site address. Street-name-only, house-number-only and mailing-address
  mappings are blanked, so those counties geocode instead.
- `COVERAGE`: layers that pass every check but cover only part of the county
  or are stale snapshots, shown as a dropdown badge.
- `VALUE_FIELDS`: estimated market value, value year and land-use fields per
  county, from `value_fields.py` runs (each kept field is at least 50% filled).

The 2026-10-16 build also had two manual example fixes, both since folded
into `examples_town.py`. Stevens' "South Street" had been abbreviated to
"S St", and McLeod's first pick geocoded onto a lot line, so it is in `SKIP`.
