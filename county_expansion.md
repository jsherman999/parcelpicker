# County Expansion Research — Minnesota Parcel Data Sources

**Date:** 2026-08-21
**Purpose:** Public parcel data sources for Minnesota counties that provide the same
parcel-owner information the app already gets from St. Louis and Wright counties
(parcel ID, owner name, site address, parcel geometry, no auth, ArcGIS REST).
Every endpoint below was **live-verified on 2026-08-21** with real queries
(metadata fetch, attribute query, spatial query, WGS84 geometry check).

This document is written for an LLM that will later add these counties to the
app. It contains (1) the exact provider contract the codebase requires,
(2) a per-county spec with verified queries, (3) a machine-readable JSON spec
per county, (4) counties that were checked and **rejected** (so you don't waste
time re-checking them), and (5) counties where no public ArcGIS endpoint was
found.

Already supported (do not re-add): **Wright, Hennepin, St. Louis, Sherburne, Anoka.**

---

## 1. Provider Contract (what an adapter must provide)

A county adapter is a subclass of `BaseParcelService`
(`backend/services/base.py`) / `BaseParcelProvider` (`web/js/providers/base.js`).
The base class implements address lookup (exact → contains → census geocode →
point intersect), point lookup, adjacent-ring expansion, retry, throttling, and
caching. The subclass only supplies:

| Class attribute | Meaning | Required |
|---|---|---|
| `endpoint_url` | Full query URL, must end in `/query` | yes |
| `source_label` | snake_case tag, e.g. `ramsey_county_arcgis` | yes |
| `parcel_id_field` | ArcGIS field holding the parcel ID | yes |
| `owner_field` | ArcGIS field holding the owner name | yes |
| `address_field` | ArcGIS field used in WHERE address match (may be `""` if you override the where builders) | yes (may be empty) |
| `extra_out_fields` | extra fields to request (city, zip, 2nd owner, …) | optional |
| `adjacent_spatial_rel` | `esriSpatialRelTouches` (default) or `esriSpatialRelIntersects` | optional |

Optional method overrides (copy the patterns from `stlouis.py`, `anoka.py`,
`hennepin.py`):

- `_get_address_where_exact(cleaned)` / `_get_address_where_contains(cleaned)` —
  build the WHERE clause from the cleaned (uppercased, whitespace-collapsed)
  input address.
- `_build_address(attrs)` — assemble `site_address` from feature attributes
  (street + city + zip). The base implementation returns `address_field` raw.

**Rules verified against these endpoints:**
- Always send `f=json` (the base class does). All endpoints here accept
  `inSR=4326` for input geometry and `outSR=4326` for output geometry.
- **Do not use `TRIM()` in WHERE clauses** — ArcGIS Online hosted services
  rejected it with `"where parameter is invalid"`. Use `IS NOT NULL` /
  `NOT LIKE ' %'` instead.
- `esriSpatialRelTouches` returned **0 results** on every new county tested.
  Use `esriSpatialRelIntersects` for `adjacent_spatial_rel` (same as Wright).
- Many county datasets pad strings with spaces or store the literal text
  `"NULL"` — always `.strip()` and treat `"NULL"`/`""` as empty.
- Some fields come back numeric where you'd expect text (zip as integer) —
  convert int → str.

### Integration checklist (every file a new county touches)

1. `backend/services/<county>.py` — new adapter (pattern: `backend/services/anoka.py`).
2. `backend/services/registry.py` — add to `COUNTY_CLASSES` + `COUNTY_LABELS`.
3. `web/js/providers/<county>.js` — JS port of the adapter (pattern: `web/js/providers/anoka.js`).
4. `web/js/providers/registry.js` — add to `COUNTY_CLASSES` + `COUNTY_LABELS`.
5. `web/js/app.js` — add a `countyConfig` entry with keys:
   `label`, `center` `[lat, lon]`, `zoom`, `placeholder` (example address),
   `propertySearch` `{label, href}`, `arcgisJsonBase`, `arcgisJsonFields`,
   `arcgisJsonIdField`, `zillowSuffix` (see the existing 5 entries for the shape).
6. `README.md` — add a row to the "Counties Supported" table.
7. `backend/main.py` needs **no changes** — it iterates `COUNTY_CLASSES`.
   `/api/providers/status` picks up new counties automatically.

---

## 2. Verified Counties

### 2.1 Ramsey County

| Detail | Value |
|---|---|
| Endpoint | `https://maps.co.ramsey.mn.us/arcgis/rest/services/OpenData/OpenData/MapServer/12/query` |
| Layer | "Parcels" (layer 12 of the county's OpenData MapServer) |
| Parcel ID | `ParcelID` (string, e.g. `012822140007`) |
| Owner | `OwnerName` (string; co-owners space-separated, e.g. `RYAN C LOWDER   CAROLYN L LOWDER`) |
| Address | `SiteAddress` (single street field, uppercase, some nulls) |
| City / ZIP | `SiteCityName`, `SiteZIP5` |
| Auth | None |
| Spatial | accepts `inSR=4326` / `outSR=4326` (verified); 152 total fields |

Verified query (2026-08-21):

```
GET .../MapServer/12/query?where=1=1&outFields=ParcelID,OwnerName,SiteAddress,SiteCityName,SiteZIP5&returnGeometry=true&outSR=4326&resultRecordCount=2&f=json
→ {'ParcelID': '012822140007', 'OwnerName': 'HEALTHPARTNERS ASSOCIATES',
   'SiteAddress': '2715 UPPER AFTON RD E', 'SiteCityName': 'MAPLEWOOD', 'SiteZIP5': '55119'}
```

Address matching: `SiteAddress` holds the street portion only — the default
base-class where builders work; override `_build_address` to append
`, {SiteCityName} MN {SiteZIP5}`.

Public portal: https://opendata.ramseycountymn.gov/

```json
{
  "county_id": "ramsey",
  "label": "Ramsey County",
  "endpoint_url": "https://maps.co.ramsey.mn.us/arcgis/rest/services/OpenData/OpenData/MapServer/12/query",
  "source_label": "ramsey_county_arcgis",
  "parcel_id_field": "ParcelID",
  "owner_field": "OwnerName",
  "address_field": "SiteAddress",
  "extra_out_fields": ["SiteCityName", "SiteZIP5"],
  "address_mode": "street_plus_city_zip",
  "adjacent_spatial_rel": "esriSpatialRelIntersects",
  "map_center": [45.02, -93.05],
  "map_zoom": 10,
  "zillow_suffix": "Ramsey County MN",
  "property_search_url": "https://opendata.ramseycountymn.gov/",
  "notes": ["OwnerName pads co-owners with multiple spaces — strip/normalize", "SiteAddress is uppercase street-only; some parcels null"]
}
```

### 2.2 Olmsted County

| Detail | Value |
|---|---|
| Endpoint | `https://public.gis.olmstedcounty.gov/arcgis/rest/services/Parcels_Addressing/MapServer/3/query` |
| Layer | "Land Parcels" (layer 3; layer 0 = E911 Addresses) |
| Parcel ID | `PIN` (string, e.g. `040566`) |
| Owner | `OwnerName1` (string, `LAST, FIRST` format; `OwnerName2` for co-owners) |
| Address | components: `SiteAddrNo`, `SiteStName`, `SiteStType`, `SitePostDir`, `SiteCity`, `SiteZip5` |
| Auth | None |
| Spatial | accepts `outSR=4326` (verified); spatial intersect works |

⚠️ **Geometry caveat (must be re-checked at implementation time):** attributes
verify perfectly, but sample parcels for known Rochester locations returned
geometry at lon ≈ -92.34 instead of ≈ -93.0 (≈0.7° east). Spatial queries are
self-consistent (an intersect box around a returned geometry finds its
neighbors), so the adapter will still work end-to-end, but map display and
census-geocode point-intersects may be offset. Investigate at build time
(candidate fixes: use the E911 Addresses layer for geocoding, or find the
county's HARN-referenced parcel service).

Verified queries (2026-08-21):

```
GET .../MapServer/3/query?where=1=1&outFields=PIN,OwnerName1,SiteAddrNo,SiteStName,SiteCity,SiteZip5&returnGeometry=true&outSR=4326&resultRecordCount=2&f=json
→ {'PIN': '000001', 'OwnerName1': 'TOWNSHIP ELMIRA', 'SiteAddrNo': '27', 'SiteStName': 'WINONA', 'SiteCity': 'CHATFIELD', 'SiteZip5': '55923'}

# address lookup
GET .../MapServer/3/query?where=SiteCity='ROCHESTER'&outFields=PIN,OwnerName1,SiteAddrNo,SiteStName&returnGeometry=false&resultRecordCount=2&f=json
→ {'PIN': '040566', 'OwnerName1': 'HOVDA TRUSTEE,RONALD S', 'SiteAddrNo': '6126', 'SiteStName': '19'}
```

Address construction: `{SiteAddrNo} {SiteStName} {SiteStType or ''} {SitePostDir or ''}, {SiteCity} MN {SiteZip5}`.
Address matching against user input needs a custom where (components, not a
single field) — e.g. `UPPER(SiteStName) LIKE '%STREET%' AND SiteAddrNo = '1234'`,
or geocode-via-E911-layer-0 then point-intersect (layer 0 has street fields).

Public portal: https://gweb01.co.olmsted.mn.us/WebApps/OlmstedCountyGISMap/

```json
{
  "county_id": "olmsted",
  "label": "Olmsted County",
  "endpoint_url": "https://public.gis.olmstedcounty.gov/arcgis/rest/services/Parcels_Addressing/MapServer/3/query",
  "source_label": "olmsted_county_arcgis",
  "parcel_id_field": "PIN",
  "owner_field": "OwnerName1",
  "address_field": "",
  "extra_out_fields": ["OwnerName2", "SiteAddrNo", "SiteStName", "SiteStType", "SitePostDir", "SiteCity", "SiteZip5"],
  "address_mode": "components",
  "address_components": ["SiteAddrNo", "SiteStName", "SiteStType", "SitePostDir"],
  "city_field": "SiteCity",
  "zip_field": "SiteZip5",
  "adjacent_spatial_rel": "esriSpatialRelIntersects",
  "map_center": [44.02, -92.95],
  "map_zoom": 10,
  "zillow_suffix": "Olmsted County MN",
  "property_search_url": "https://gweb01.co.olmsted.mn.us/WebApps/OlmstedCountyGISMap/",
  "notes": [
    "CUSTOM _get_address_where_exact/_contains REQUIRED (no single street field)",
    "OwnerName1 format is 'LAST, FIRST' — optional display normalization",
    "GEOMETRY OFFSET WARNING: sample geometries ~0.7 deg east of expected for Rochester addresses; verify at implementation time"
  ]
}
```

### 2.3 Chisago County

| Detail | Value |
|---|---|
| Endpoint | `https://gis.chisagocounty.us/arcgis/rest/services/AssessmentInformation/TaxParcels/MapServer/0/query` |
| Layer | "Tax Parcel" (MapServer, ArcGIS 11.5) |
| Parcel ID | `PIN` (string, e.g. `010000900`) |
| Owner | `Ownname` (string) |
| Address | `PropAddr` (street only, trailing spaces) + `PropCity` + `PropZip` |
| Native SR | 102100 (Web Mercator); verified with `outSR=4326` |
| Auth | None (county-hosted server) |

Verified query (2026-08-21):

```
GET .../MapServer/0/query?where=PropAddr IS NOT NULL AND PropAddr <> ''&outFields=PIN,Ownname,PropAddr,PropCity,PropZip&returnGeometry=true&outSR=4326&resultRecordCount=2&f=json
→ {'PIN': '010000900', 'Ownname': 'GLEM CHAD', 'PropAddr': '16823 RIVER RD ', 'PropCity': 'NORTH BRANCH', 'PropZip': '55056'}
```

Address matching: default where builders work on `PropAddr` (strip user input
of city/zip first, like `stlouis.py`). Override `_build_address` to append
city/zip.

Public portal: https://gis.chisagocountymn.gov/Link/WAB/ (Chisago Parcel Viewer)

```json
{
  "county_id": "chisago",
  "label": "Chisago County",
  "endpoint_url": "https://gis.chisagocounty.us/arcgis/rest/services/AssessmentInformation/TaxParcels/MapServer/0/query",
  "source_label": "chisago_county_arcgis",
  "parcel_id_field": "PIN",
  "owner_field": "Ownname",
  "address_field": "PropAddr",
  "extra_out_fields": ["PropCity", "PropZip"],
  "address_mode": "street_plus_city_zip",
  "adjacent_spatial_rel": "esriSpatialRelIntersects",
  "map_center": [45.6, -93.02],
  "map_zoom": 10,
  "zillow_suffix": "Chisago County MN",
  "property_search_url": "https://gis.chisagocountymn.gov/Link/WAB/",
  "notes": ["PropAddr has trailing spaces — strip", "Road/state parcels have null PropAddr/Ownname — expect empty addresses"]
}
```

### 2.4 Morrison County

| Detail | Value |
|---|---|
| Endpoint | `https://services1.arcgis.com/lQjrBHFnTgKBR9zX/arcgis/rest/services/Parcels/FeatureServer/0/query` |
| Layer | "Parcels" (ArcGIS Online hosted) |
| Parcel ID | `PIN` (string, e.g. `250003001`) |
| Owner | `Primary_Owner` (e.g. `ROHL EUGENE ALAN & JUDY`); also `Owner_First_Name`/`Owner_Last_Name` |
| Address | `SitusStNo` `SitusStName` `SitusStType` `SitusPostDir` + `SitusCity` + `SitusZip` |
| Fallback | `Situs_Freeform_Addr` or `Mailing_Delivery_Addr` |
| Auth | None |

Verified query (2026-08-21):

```
GET .../FeatureServer/0/query?where=Primary_Owner IS NOT NULL AND Primary_Owner <> ''&outFields=PIN,Primary_Owner,Mailing_Delivery_Addr,City_Twp&returnGeometry=true&outSR=4326&resultRecordCount=2&f=json
→ {'PIN': '250003001', 'Primary_Owner': 'ROHL EUGENE ALAN & JUDY', 'Mailing_Delivery_Addr': '35555 SPUR HWY #188', 'City_Twp': 'Rail Prairie Twp'}
```

⚠️ **Data quirk:** on many parcels the `Situs*` fields contain the literal
string `"NULL"` instead of being null. Treat `"NULL"` (case-insensitive) and
`""` as empty, and fall back to `Mailing_Delivery_Addr` when all Situs fields
are empty.

```json
{
  "county_id": "morrison",
  "label": "Morrison County",
  "endpoint_url": "https://services1.arcgis.com/lQjrBHFnTgKBR9zX/arcgis/rest/services/Parcels/FeatureServer/0/query",
  "source_label": "morrison_county_arcgis",
  "parcel_id_field": "PIN",
  "owner_field": "Primary_Owner",
  "address_field": "Situs_Freeform_Addr",
  "extra_out_fields": ["Owner_Last_Name", "Owner_First_Name", "SitusStNo", "SitusStName", "SitusStType", "SitusPostDir", "SitusCity", "SitusZip", "Mailing_Delivery_Addr", "City_Twp"],
  "address_mode": "components_with_literal_null",
  "address_components": ["SitusStNo", "SitusStName", "SitusStType", "SitusPostDir"],
  "city_field": "SitusCity",
  "zip_field": "SitusZip",
  "address_fallback_field": "Mailing_Delivery_Addr",
  "adjacent_spatial_rel": "esriSpatialRelIntersects",
  "map_center": [46.05, -94.65],
  "map_zoom": 10,
  "zillow_suffix": "Morrison County MN",
  "property_search_url": "https://morrisoncountymn.gov/government/assessor/",
  "notes": [
    "Situs* fields contain literal string 'NULL' on many records — normalize to empty",
    "Address lookup: match on Situs_StName + SitusStNo, else fall back to point lookup",
    "City_Twp is municipality-or-township (useful when SitusCity is NULL)"
  ]
}
```

### 2.5 Scott County

| Detail | Value |
|---|---|
| Endpoint | `https://services.arcgis.com/DqIh9WAsIZcPlBEF/arcgis/rest/services/Parcels/FeatureServer/0/query` |
| Layer | "Parcels" (ArcGIS Online hosted; backs the county's open-data hub) |
| Parcel ID | `PID` (string, e.g. `030500070`) |
| Owner | `TaxPayerName` (also `TaxPayerFirst/Middle/Last`) |
| Address | `PropertyAddress` (often a FULL address string: `72 CEDAR LAKE CT New Prague, MN 56071`); structured: `PropertyAddress1`, `PropertyCity`, `PropertyZip` |
| Native SR | 103778 (NAD83 HARN MN South); verified with `outSR=4326` |
| Auth | None |

Verified query (2026-08-21):

```
GET .../FeatureServer/0/query?where=TaxPayerName IS NOT NULL AND TaxPayerName <> ''&outFields=PID,TaxPayerName,PropertyAddress,PropertyCity,PropertyZip&returnGeometry=true&outSR=4326&resultRecordCount=2&f=json
→ {'PID': '030500070', 'TaxPayerName': 'HOCH JOHN J', 'PropertyAddress': '72 CEDAR LAKE CT New Prague, MN 56071', 'PropertyCity': 'New Prague', 'PropertyZip': '56071'}
```

Address matching: `PropertyAddress` mixes case and sometimes includes the
full street+city+zip — use a contains/prefix where on `UPPER(PropertyAddress)`
rather than exact match (or match on `PropertyAddress1` street portion).

Public portal: https://open-data-scottcounty.hub.arcgis.com/datasets/parcels/explore

```json
{
  "county_id": "scott",
  "label": "Scott County",
  "endpoint_url": "https://services.arcgis.com/DqIh9WAsIZcPlBEF/arcgis/rest/services/Parcels/FeatureServer/0/query",
  "source_label": "scott_county_arcgis",
  "parcel_id_field": "PID",
  "owner_field": "TaxPayerName",
  "address_field": "PropertyAddress",
  "extra_out_fields": ["PropertyAddress1", "PropertyCity", "PropertyZip"],
  "address_mode": "full_address_string",
  "adjacent_spatial_rel": "esriSpatialRelIntersects",
  "address_where_strategy": "contains_on_upper_property_address",
  "map_center": [44.6, -93.78],
  "map_zoom": 10,
  "zillow_suffix": "Scott County MN",
  "property_search_url": "https://open-data-scottcounty.hub.arcgis.com/datasets/parcels/explore",
  "notes": ["PropertyAddress may already contain city+state+zip — avoid duplicating in _build_address (prefer PropertyAddress1 + PropertyCity + PropertyZip)", "Some parcels have PropertyAddress = ' ' (spaces)"]
}
```

### 2.6 Aitkin County

| Detail | Value |
|---|---|
| Endpoint | `https://gisweb.co.aitkin.mn.us/arcgis/rest/services/ParcelTaxData/FeatureServer/0/query` |
| Layer | "ParcelTaxData" (county-hosted, ArcGIS 11.5) |
| Parcel ID | `PRCL_NBR` (e.g. `59-0-006401`) |
| Owner | `OWNNAME` (e.g. `MARSYLA, JENA & SCHUBERT, KEVIN`) |
| Address | `ADDR_1` (street or PO box) + `ADDR_2` (line 2, e.g. `MCGREGOR MN  55760`); also `Physical_Address`/`Physical_City`/`Physical_Zip` (sparse) |
| Auth | None |

Verified query (2026-08-21):

```
GET .../FeatureServer/0/query?where=OWNNAME IS NOT NULL AND OWNNAME <> ''&outFields=PRCL_NBR,OWNNAME,ADDR_1,ADDR_2&returnGeometry=true&outSR=4326&resultRecordCount=2&f=json
→ {'PRCL_NBR': '59-0-006401', 'OWNNAME': 'MARSYLA, JENA & SCHUBERT, KEVIN', 'ADDR_1': '230 S MADDY ST', 'ADDR_2': 'MCGREGOR MN  55760'}
```

Address construction: `ADDR_1` is the street; `ADDR_2` already includes
`CITY MN ZIP` — join with `, ` (or use `ADDR_2` alone as the site line).
Address matching: contains-match on `UPPER(ADDR_1)`.

Public portal: https://gisweb.co.aitkin.mn.us/ (county GIS)

```json
{
  "county_id": "aitkin",
  "label": "Aitkin County",
  "endpoint_url": "https://gisweb.co.aitkin.mn.us/arcgis/rest/services/ParcelTaxData/FeatureServer/0/query",
  "source_label": "aitkin_county_arcgis",
  "parcel_id_field": "PRCL_NBR",
  "owner_field": "OWNNAME",
  "address_field": "ADDR_1",
  "extra_out_fields": ["ADDR_2", "Physical_Address", "Physical_City", "Physical_Zip"],
  "address_mode": "two_line",
  "adjacent_spatial_rel": "esriSpatialRelIntersects",
  "address_where_strategy": "contains_on_upper_addr_1",
  "map_center": [46.72, -93.37],
  "map_zoom": 10,
  "zillow_suffix": "Aitkin County MN",
  "property_search_url": "https://gisweb.co.aitkin.mn.us/",
  "notes": ["ADDR_2 is 'CITY MN ZIP' (may contain a PO BOX as ADDR_1)", "Physical_Address/Physical_City/Physical_Zip exist but are sparse — prefer ADDR_1/ADDR_2"]
}
```

### 2.7 Koochiching County

| Detail | Value |
|---|---|
| Endpoint | `https://services3.arcgis.com/8mdusDCY0WncdJVw/arcgis/rest/services/KoochichingCountyParcelDataPublish/FeatureServer/0/query` |
| Layer | "Parcels" (ArcGIS Online hosted) |
| Parcel ID | `PARCEL_ID` (e.g. `77-020-12000`); also `PRCL_NBR` |
| Owner | `OWNNAME` |
| Address | `ADDR_1`, `CITY`, `ZIP_CODE_5` (integer — `0` = none) |
| Native SR | 26915 (NAD83 UTM 15N); verified with `outSR=4326` |
| Auth | None |

Verified query (2026-08-21):

```
GET .../FeatureServer/0/query?where=OWNNAME IS NOT NULL AND OWNNAME <> ''&outFields=PARCEL_ID,OWNNAME,ADDR_1,CITY,ZIP_CODE_5&returnGeometry=true&outSR=4326&resultRecordCount=2&f=json
→ {'PARCEL_ID': '77-020-12000', 'OWNNAME': 'MINNESOTA CON CON TAX EXEMPT', 'ZIP_CODE_5': 0}
```

⚠️ Many rural parcels have empty `ADDR_1`/`CITY` and `ZIP_CODE_5 = 0` (the
county is heavily rural). Point-lookup and ring expansion still work; address
lookup will often fall through to the census geocoder (already built into the
base class).

```json
{
  "county_id": "koochiching",
  "label": "Koochiching County",
  "endpoint_url": "https://services3.arcgis.com/8mdusDCY0WncdJVw/arcgis/rest/services/KoochichingCountyParcelDataPublish/FeatureServer/0/query",
  "source_label": "koochiching_county_arcgis",
  "parcel_id_field": "PARCEL_ID",
  "owner_field": "OWNNAME",
  "address_field": "ADDR_1",
  "extra_out_fields": ["CITY", "ZIP_CODE_5"],
  "address_mode": "street_plus_city_zip",
  "adjacent_spatial_rel": "esriSpatialRelIntersects",
  "map_center": [48.47, -94.47],
  "map_zoom": 10,
  "zillow_suffix": "Koochiching County MN",
  "property_search_url": "https://koochichingcounty.gov/",
  "notes": ["ZIP_CODE_5 is integer; 0 means no zip — convert to str only when nonzero", "Mostly rural: expect frequent empty addresses; lean on point lookup", "OWNADR1..OWNADR3 are the OWNER's mailing address, not the site address"]
}
```

### 2.8 Beltrami County

| Detail | Value |
|---|---|
| Endpoint | `https://arcgis.co.beltrami.mn.us/arcgis/rest/services/BeltramiData/BeltramiOpenData/MapServer/2/query` |
| Layer | "Tax Parcels" (layer 2; county-hosted) |
| Parcel ID | `PIN` (e.g. `010011001`) |
| Owner | `OWNERNAME1` (+ `OWNERNAME2` for co-owners) |
| Address | `PROP_ADD1` (trailing spaces), `PROP_CITY`, `PROP_ZIP`; also split `PROP_ADD1_HOUSE`/`PROP_ADD1_STREET` |
| Auth | None |

Verified query (2026-08-21):

```
GET .../MapServer/2/query?where=OWNERNAME1 IS NOT NULL AND OWNERNAME1 <> ''&outFields=PIN,OWNERNAME1,PROP_ADD1,PROP_CITY,PROP_ZIP&returnGeometry=true&outSR=4326&resultRecordCount=2&f=json
→ {'PIN': '010011001', 'OWNERNAME1': 'LAKES GAS COMPANY INC', 'PROP_ADD1': '8644 LUMBERJACK RD NW ', 'PROP_CITY': 'PUPOSKY', 'PROP_ZIP': '56667'}
```

```json
{
  "county_id": "beltrami",
  "label": "Beltrami County",
  "endpoint_url": "https://arcgis.co.beltrami.mn.us/arcgis/rest/services/BeltramiData/BeltramiOpenData/MapServer/2/query",
  "source_label": "beltrami_county_arcgis",
  "parcel_id_field": "PIN",
  "owner_field": "OWNERNAME1",
  "address_field": "PROP_ADD1",
  "extra_out_fields": ["OWNERNAME2", "PROP_CITY", "PROP_ZIP"],
  "address_mode": "street_plus_city_zip",
  "adjacent_spatial_rel": "esriSpatialRelIntersects",
  "map_center": [47.85, -95.65],
  "map_zoom": 10,
  "zillow_suffix": "Beltrami County MN",
  "property_search_url": "https://beltramicounty.org/assessor/",
  "notes": ["Owner display: join OWNERNAME1 and OWNERNAME2 with ' & ' when both present", "PROP_ADD1 has trailing spaces — strip"]
}
```

### 2.9 Dakota County (via MN state server)

| Detail | Value |
|---|---|
| Endpoint | `https://arcgis.metc.state.mn.us/data1/rest/services/parcels/Parcels/FeatureServer/2/query` |
| Layer | layer 2 of the state "Parcels" FeatureServer = **Dakota County Parcels** |
| Parcel ID | `PIN` (e.g. `037-010090001011`; state-prefixed `STATE_PIN` also present) |
| Owner | `OWNER_NAME` (e.g. `State Of Mn - Dot`) |
| Address | `ANUMBER` (int) + `ST_NAME` + `ST_POS_TYP` + `CTU_NAME` (city/township) + `ZIP` (statewide schema) |
| Native SR | 26915; verified with `outSR=4326` |
| Auth | None |
| Data | 154,315 parcels; 148,577 have a non-null `OWNER_NAME` |

Verified query (2026-08-21):

```
GET .../Parcels/FeatureServer/2/query?where=OWNER_NAME IS NOT NULL&outFields=PIN,CO_NAME,OWNER_NAME,ANUMBER,ST_NAME,ST_POS_TYP,CTU_NAME,ZIP&returnGeometry=true&outSR=4326&resultRecordCount=2&f=json
→ {'PIN': '037-010090001011', 'CO_NAME': 'Dakota', 'OWNER_NAME': 'State Of Mn - Dot', 'CTU_NAME': 'Apple Valley'}
```

The county's own servers (`gis.co.dakota.mn.us`, mn.geoplatform.gov) were
unreachable; the state server is the working public route. All 7 metro
counties live in this one service (layers: 0 Anoka, 1 Carver, 2 Dakota,
3 Hennepin, 4 Ramsey, 5 Scott, 6 Washington) — use the **per-county layer**
shown here, and optionally add `CO_NAME = '<name>'` to the where clause as a
safety net.

```json
{
  "county_id": "dakota",
  "label": "Dakota County",
  "endpoint_url": "https://arcgis.metc.state.mn.us/data1/rest/services/parcels/Parcels/FeatureServer/2/query",
  "source_label": "dakota_county_arcgis_state",
  "parcel_id_field": "PIN",
  "owner_field": "OWNER_NAME",
  "address_field": "",
  "extra_out_fields": ["ANUMBER", "ST_NAME", "ST_PRE_TYP", "ST_PRE_DIR", "ST_POS_TYP", "ST_POS_DIR", "CTU_NAME", "ZIP"],
  "address_mode": "statewide_schema",
  "address_components": ["ANUMBER", "ST_NAME", "ST_POS_TYP", "ST_POS_DIR"],
  "city_field": "CTU_NAME",
  "zip_field": "ZIP",
  "adjacent_spatial_rel": "esriSpatialRelIntersects",
  "where_safety_clause": "CO_NAME = 'Dakota'",
  "map_center": [44.78, -93.28],
  "map_zoom": 10,
  "zillow_suffix": "Dakota County MN",
  "property_search_url": "https://gis.co.dakota.mn.us/dcgis/",
  "notes": ["ANUMBER is integer — string-join with ST_NAME", "ST_PRE_TYP/ST_PRE_DIR are street prefix type/direction (e.g. 'SOUTHWEST'/'STREET')", "Rural parcels have null ANUMBER/ST_NAME — address lookup falls through to point lookup", "Source is the MN state ArcGIS server (arcgis.metc.state.mn.us), not county-hosted"]
}
```

### 2.10 Washington County (via MN state server)

Same service and schema as Dakota — layer **6** = Washington County Parcels.

| Detail | Value |
|---|---|
| Endpoint | `https://arcgis.metc.state.mn.us/data1/rest/services/parcels/Parcels/FeatureServer/6/query` |
| Data | 119,096 parcels; 119,077 with owner |

Verified query (2026-08-21):

```
GET .../Parcels/FeatureServer/6/query?where=OWNER_NAME IS NOT NULL&outFields=PIN,OWNER_NAME,ANUMBER,ST_NAME,ST_POS_TYP,CTU_NAME,ZIP&returnGeometry=true&outSR=4326&resultRecordCount=2&f=json
→ {'PIN': '163-0102621110001', 'OWNER_NAME': 'LAM AMY & CHUEN WONG', 'ANUMBER': 12001, 'ST_NAME': '120Th', 'ST_POS_TYP': 'Street', 'CTU_NAME': 'Denmark Township', 'ZIP': '55033'}
```

```json
{
  "county_id": "washington",
  "label": "Washington County",
  "endpoint_url": "https://arcgis.metc.state.mn.us/data1/rest/services/parcels/Parcels/FeatureServer/6/query",
  "source_label": "washington_county_arcgis_state",
  "parcel_id_field": "PIN",
  "owner_field": "OWNER_NAME",
  "address_field": "",
  "extra_out_fields": ["ANUMBER", "ST_NAME", "ST_PRE_TYP", "ST_PRE_DIR", "ST_POS_TYP", "ST_POS_DIR", "CTU_NAME", "ZIP"],
  "address_mode": "statewide_schema",
  "address_components": ["ANUMBER", "ST_NAME", "ST_POS_TYP", "ST_POS_DIR"],
  "city_field": "CTU_NAME",
  "zip_field": "ZIP",
  "adjacent_spatial_rel": "esriSpatialRelIntersects",
  "where_safety_clause": "CO_NAME = 'Washington'",
  "map_center": [45.33, -93.1],
  "map_zoom": 10,
  "zillow_suffix": "Washington County MN",
  "property_search_url": "https://washingtoncountymn.gov/government/departments-a-z/g/gis",
  "notes": ["identical schema to the Dakota entry — share a StatewideSchemaParcelService base class", "ANUMBER is integer"]
}
```

### 2.11 Carver County (via MN state server) — PARTIALLY VERIFIED

| Detail | Value |
|---|---|
| Endpoint | `https://arcgis.metc.state.mn.us/data1/rest/services/parcels/Parcels/FeatureServer/1/query` |
| Layer | layer 1 of the state "Parcels" FeatureServer = Carver County Parcels |
| Data | 47,886 parcels, but **`OWNER_NAME IS NOT NULL` returned 0 rows** in testing |

Same schema as Dakota/Washington. **Before wiring this county up, re-check
owner population** — query `COUNT` for `TAX_NAME IS NOT NULL` and
`OWNER_NAME <> ' '`; if both are empty the Carver layer only supports
point/geometry lookups without owner names (in which case drop Carver from
this list and use https://gis.carvercountymn.gov/property/ as a manual link
only).

```json
{
  "county_id": "carver",
  "label": "Carver County",
  "endpoint_url": "https://arcgis.metc.state.mn.us/data1/rest/services/parcels/Parcels/FeatureServer/1/query",
  "source_label": "carver_county_arcgis_state",
  "parcel_id_field": "PIN",
  "owner_field": "OWNER_NAME",
  "address_field": "",
  "extra_out_fields": ["ANUMBER", "ST_NAME", "ST_PRE_TYP", "ST_PRE_DIR", "ST_POS_TYP", "ST_POS_DIR", "CTU_NAME", "ZIP", "TAX_NAME"],
  "address_mode": "statewide_schema",
  "address_components": ["ANUMBER", "ST_NAME", "ST_POS_TYP", "ST_POS_DIR"],
  "city_field": "CTU_NAME",
  "zip_field": "ZIP",
  "adjacent_spatial_rel": "esriSpatialRelIntersects",
  "where_safety_clause": "CO_NAME = 'Carver'",
  "map_center": [44.82, -93.85],
  "map_zoom": 10,
  "zillow_suffix": "Carver County MN",
  "property_search_url": "https://gis.carvercountymn.gov/property/",
  "notes": ["PARTIALLY VERIFIED: geometry/address schema confirmed, but owner field sampled empty — verify OWNER_NAME vs TAX_NAME population before enabling"]
}
```

### 2.12 Statewide aggregate (fallback / reference)

`https://arcgis.metc.state.mn.us/data1/rest/services/parcels/Parcels_Aggregate/FeatureServer/0`
— single layer "Metropolitan 7-County Parcels", same statewide schema
(`PIN`, `OWNER_NAME`, `ANUMBER`, `ST_NAME`, `CTU_NAME`, `ZIP`), native SR 26915,
no auth. Useful as a fallback provider or for cross-checking the per-county
layers. Related services: `Parcel_Points_Aggregate` (address points) and
yearly snapshots (`Parcels_2024`, …).

---

## 3. Checked and Rejected (do not re-check)

| County | Source checked | Why rejected |
|---|---|---|
| Houston | `services7.arcgis.com/X4PP9wzxESU6h7Mz/.../HoustonParcels/FeatureServer` (single layer) | Parcel layer has `PARCELID`/`ADDRESS` but **no owner field** |
| Winona | `services.arcgis.com/n4v88Dv33V9Mhi0b/.../Parcels/FeatureServer` (single layer) | 26 fields, **no owner field** (OpenGov tax-parcel variants in the same org also lack usable owner+address combos) |
| Waseca | `gis.wasecacounty.gov/arcgis/rest/services/Public/Cadastral/FeatureServer/0` | Has `PARCEL_ID` + `PropertyAddress` but **no owner field** in the public layer |
| Clay | `services6.arcgis.com/mS1vc6dGT4od9xCB/.../Tax_Parcel_Data/FeatureServer` | Service exists but is **empty** (no layers, no features) |
| Brown | `gis.co.brown.mn.us/server/rest/services/BrownCountyMaster/Parcel_Tax_Vendor` | **404** — service removed/moved |
| Roseau | `services.arcgis.com/8df8p0NlLFEShl0r/.../LOTW_and_ROSEAU_PARCELS_WFL1/FeatureServer` | Only **35 features**, all road parcels with space-padded empty attributes |
| Rice | `services.arcgis.com/ULBqC49IEeIR01GF/.../RiceCountyParcels_Feb2017` + `Tax_Parcel_Points` | Only a **2017 snapshot** and a points layer; nothing current with owner data |
| Carver (own server) | `gis.co.carver.mn.us/arcgis_ea/rest/services` | Root lists **0 services** (server appears decommissioned) |
| Dakota (own servers) | `gis.co.dakota.mn.us`, `mn.geoplatform.gov` | **Unreachable** from the build environment (use the state server, §2.9) |

---

## 4. No Public ArcGIS Parcel Endpoint Found (manual follow-up)

ArcGIS Online search (2026-08-21) found no public, queryable parcel service
with owner data for these counties. They likely use a vendor parcel viewer
(Beacon/Schneider, 311, ParcelQuest, etc.) with no public REST endpoint.
If you revisit one, check the county's assessor page for a "parcel viewer" /
"GIS data" link and test its backing ArcGIS service.

Aitkin ✓ (done) · Anoka ✓ (supported) · Becker · Beltrami ✓ (done) · Big Stone
· Blue Earth · Brown (404) · Cass · Carlton · Carver (§2.11) · Chippewa ·
Chisago ✓ (done) · Clearwater · Clay (empty) · Cook · Cottonwood · Crow Wing ·
Dakota ✓ (done) · Douglas · Faribault · Freeborn · Goodhue · Hennepin ✓
(supported) · Houston (no owner field) · Hubbard · Isanti · Itasca · Jackson ·
Kanabec · Kandiyohi · Kittson (not searched) · Koochiching ✓ (done) · Lake ·
Lac qui Parle · Le Sueur · Martin · McLeod · Meeker · Mille Lacs · Morrison ✓
(done) · Murray · Nicollet · Nobles · Norman · Olmsted ✓ (done) · Otter Tail ·
Pennington · Pipestone · Pine · Polk · Pope · Ramsey ✓ (done) · Red Lake ·
Redwood (not searched) · Rice (stale) · Rock · Roseau (road-parcels only) ·
Scott ✓ (done) · Sherburne ✓ (supported) · Sibley · St. Louis ✓ (supported) ·
Stearns · Swift · Travers e · Wabasha · Wadena · Waseca (no owner field) ·
Watonwan · Washington ✓ (done) · Winona (no owner field) · Wright ✓ (supported)
· Yellow Medicine

Search tip that worked: `https://www.arcgis.com/sharing/rest/search?f=json&num=25&q=<county> county minnesota parcels`
(filtered for `FeatureServer`/`MapServer` URLs), plus a direct web search for
"<county> county MN GIS parcel viewer".

---

## 5. Implementation Notes / Shared Patterns

1. **Shared base for the statewide schema** (Dakota, Washington, Carver):
   three counties share `PIN`/`OWNER_NAME`/`ANUMBER`/`ST_NAME`/`CTU_NAME`/`ZIP`
   on the same server — factor a `StatewideSchemaParcelService` with a
   `layer_index` parameter instead of three near-identical adapters.
2. **`adjacent_spatial_rel = esriSpatialRelIntersects`** for all new counties
   (Touches returned 0 everywhere; Wright already does this).
3. **Address where-clause strategies observed** (reuse existing helpers):
   - single street field, uppercase: `UPPER(f) = ...` / `LIKE '%...%'`
     (Chisago, Koochiching, Aitkin via ADDR_1 contains, Beltrami)
   - full/mixed-case address string: contains on `UPPER(f)` (Scott)
   - components: custom where or geocode-then-point (Olmsted, Morrison,
     Dakota, Washington, Carver)
4. **Owner display**: some counties store `LAST, FIRST` (Olmsted, Aitkin),
   some `FIRST LAST` (Chisago, Beltrami, Dakota). Keep raw in the DB; the
   optional LLM normalization pass (existing feature) can unify display.
5. **Map centers** in the JSON blocks are approximate county centroids —
   verify visually in the Leaflet UI after wiring each county.
6. **Rate limits**: all endpoints are public and unauthenticated. Keep the
   existing throttle/retry behavior; none of the new servers advertise
   stricter limits, but ArcGIS Online-hosted services (Morrison, Scott,
   Koochiching) are shared and slower — prefer `resultRecordCount` caps.
