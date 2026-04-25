# Hennepin & St. Louis County Parcel Data Research

**Date:** 2026-04-25
**Context:** ParcelPicker currently only supports Wright County, MN. This document
covers research into expanding to Hennepin and St. Louis counties.

---

## 1. Current Architecture (Wright County)

The app queries **Wright County's public ArcGIS REST API** for parcel data:

| Detail | Value |
|---|---|
| **Endpoint** | `https://web.co.wright.mn.us/arcgisserver/rest/services/Wright_County_Parcels/MapServer/1/query` |
| **Spatial Ref** | `4326` (WGS84) |
| **Parcel ID field** | `PID` (string) |
| **Owner field** | `OWNNAME` (string) |
| **Address field** | `PHYSADDR` (string — single full-address field) |
| **Auth** | None |

**Query modes:**
1. **Address match** — `WHERE UPPER(PHYSADDR) = '<cleaned>'`, fallback to `LIKE '%...%'`
2. **Point intersect** — `geometry={lon},{lat}` + `esriSpatialRelIntersects`
3. **Touches (adjacent parcels)** — `geometry=<esri_polygon>` + `esriSpatialRelTouches`
4. **Census geocoder fallback** — `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress` converts address → lat/lon, then point intersect

---

## 2. Hennepin County

### 2.1 Endpoint Details

| Detail | Value |
|---|---|
| **ArcGIS Server root** | `https://gis.hennepin.us/arcgis/rest/services` |
| **Parcel layer (tax parcels)** | `/HennepinData/LAND_PROPERTY/MapServer/1` |
| **Address points layer** | `/HennepinData/LAND_PROPERTY/MapServer/0` |
| **Spatial Ref** | `26915` (NAD83 UTM Zone 15N) |
| **MaxRecordCount** | 2000 |
| **ArcGIS version** | 10.91 |
| **Auth required** | No (token available but not required for queries) |
| **Supported formats** | JSON, geoJSON, PBF |

### 2.2 Parcel Layer Fields (Layer 1 — "County Parcels")

Key fields for ParcelPicker:

| Concept | Field Name | Type | Length | Notes |
|---|---|---|---|---|
| Parcel ID | `PID` | string | 13 | Same name as Wright — **easy** |
| Owner name | `OWNER_NM` | string | 35 | Trailing-padded with spaces; trim it |
| House number | `HOUSE_NO` | integer | — | Address component |
| Fractional | `FRAC_HOUSE_NO` | string | 3 | Address component (e.g., "1/2") |
| Street name | `STREET_NM` | string | 20 | Address component |
| City | `MAILING_MUNIC_NM` | string | 16 | Address component |
| ZIP | `ZIP_CD` | string | 5 | Address component |

**Critical difference:** Hennepin does NOT have a single `PHYSADDR` field. The parcel
layer stores address as individual components. Must construct the full address:

```
"{HOUSE_NO}{FRAC_HOUSE_NO} {STREET_NM}, {MAILING_MUNIC_NM} MN {ZIP_CD}"
```

### 2.3 Address Points Layer (Layer 0 — "Address Points")

This layer has `CONCAT_AD` (pre-built concatenated address, 100 chars), `PID`, `MUNI_NAME`, `ZIP`.
Useful as an alternative route: query address points to find a matching `PID`, then
query the parcel layer by that PID.

| Field | Type | Notes |
|---|---|---|
| `PID` | string (13) | Links to parcel layer |
| `CONCAT_AD` | string (100) | Pre-built full address string |
| `MUNI_NAME` | string (30) | Municipality/city name |
| `ZIP` | string (5) | ZIP code |
| `LATITUDE` | float | Latitude in WGS84 |
| `LONGITUDE` | float | Longitude in WGS84 |

### 2.4 Spatial Reference Handling

Native SR is 26915. Queries support `inSR` and `outSR` parameters. Verified:
- **Input**: Pass `inSR=4326` for lat/lon geometries
- **Output**: Pass `outSR=4326` to receive GeoJSON in WGS84

### 2.5 Verified Query Examples

```
# Parcel by PID (returns features)
GET .../MapServer/1/query?where=PID+IS+NOT+NULL&outFields=PID,OWNER_NM,HOUSE_NO,STREET_NM,MAILING_MUNIC_NM,ZIP_CD&returnGeometry=false&outSR=4326&resultRecordCount=3

# Address point with CONCAT_AD
GET .../MapServer/0/query?where=PID+IS+NOT+NULL&outFields=PID,CONCAT_AD,MUNI_NAME,ZIP&returnGeometry=false&resultRecordCount=3

# Spatial intersect with inSR/outSR
GET .../MapServer/1/query?where=1%3D1&geometry=-93.30,44.98&geometryType=esriGeometryPoint&spatialRel=esriSpatialRelIntersects&inSR=4326&outFields=PID,OWNER_NM,HOUSE_NO,STREET_NM&returnGeometry=false&outSR=4326&resultRecordCount=3
# Returns: PID=2102924340037, OWNER_NM="J M FOLINE & J G FOLINE", HOUSE_NO=247, STREET_NM="CEDAR LAKE RD N"
```

---

## 3. St. Louis County

### 3.1 Endpoint Details

| Detail | Value |
|---|---|
| **ArcGIS Server root** | `https://gis.stlouiscountymn.gov/server2/rest/services` |
| **Parcel layer (detailed)** | `/GeneralUse/Cadastral/MapServer/23` *(Tax Parcels - Neighborhood)* |
| **Parcel layer (overview)** | `/GeneralUse/Cadastral/MapServer/24` *(Tax Parcels - Community)* |
| **Address points layer** | `/GeneralUse/AddressPoints/MapServer/0` |
| **Spatial Ref** | `102100` (Web Mercator / EPSG:3857) |
| **MaxRecordCount** | 2000 |
| **ArcGIS version** | 11.3 |
| **Auth required** | No |
| **Supported formats** | JSON, geoJSON, PBF |

### 3.2 Parcel Layer Fields (Layer 23 — "Tax Parcels - Neighborhood")

Both layer 23 and layer 24 share identical schemas. Use layer 23 (more detailed,
visible at scales 0–9029).

Key fields for ParcelPicker:

| Concept | Field Name | Type | Length | Notes |
|---|---|---|---|---|
| Parcel ID | `PRCL_NBR` | string | 255 | Different name than Wright's `PID` |
| Owner name | `OWNAME` | string | 35 | |
| Street address | `PHYSADDR` | string | 55 | Street portion only (e.g., "121 Hawthorne Rd") |
| City | `PHYSCITY` | string | 25 | City name |
| ZIP | `PHYSZIP` | double | — | ZIP code (numeric) |

**Address construction:** `PHYSADDR` alone is the street address. Append
`PHYSCITY` and `PHYSZIP` to get the full address:

```
"{PHYSADDR}, {PHYSCITY} MN {int(PHYSZIP)}"
```

Note: `PHYSZIP` is stored as a double. Convert to integer then string to avoid
decimal formatting (e.g., `55802.0` → `55802`).

### 3.3 Address Points Layer (Layer 0)

| Field | Type | Notes |
|---|---|---|
| `ANUMBER` | integer | Address number |
| `ST_NAME` | string (60) | Street name |
| `ZIP` | string (5) | ZIP code |
| `CTU_NAME` | string (100) | City/township/unorganized territory name |
| `PropertyID` | string (14) | Links to parcel PRCL_NBR |
| `LATITUDE` | float | WGS84 latitude |
| `LONGITUDE` | float | WGS84 longitude |

### 3.4 Spatial Reference Handling

Native SR is 102100 (Web Mercator). Queries support `inSR` and `outSR`. Verified:
- **Input**: Pass `inSR=4326` for lat/lon geometries
- **Output**: Pass `outSR=4326` to receive GeoJSON in WGS84

### 3.5 Verified Query Examples

```
# Parcel by PRCL_NBR
GET .../MapServer/23/query?where=PRCL_NBR+IS+NOT+NULL&outFields=PRCL_NBR,OWNAME,PHYSADDR,PHYSCITY,PHYSZIP&returnGeometry=false&outSR=4326&resultRecordCount=3
# Returns: PRCL_NBR=010-0010-00010, OWNAME="ST OF MN C278 L35", PHYSADDR=null (some parcels have no street address)

# Spatial intersect
GET .../MapServer/23/query?where=1%3D1&geometry=-92.50,46.79&geometryType=esriGeometryPoint&spatialRel=esriSpatialRelIntersects&inSR=4326&outFields=PRCL_NBR,OWNAME,PHYSADDR&returnGeometry=false&outSR=4326&resultRecordCount=3
```

### 3.6 Server Path Difference

St. Louis uses a non-standard ArcGIS path: `/server2/rest/services` instead of the
common `/arcgis/rest/services` (Hennepin) or `/arcgisserver/rest/services` (Wright).

---

## 4. Cross-County Comparison Table

| | Wright | Hennepin | St. Louis |
|---|---|---|---|
| **Server root** | `web.co.wright.mn.us/arcgisserver/rest/services` | `gis.hennepin.us/arcgis/rest/services` | `gis.stlouiscountymn.gov/server2/rest/services` |
| **Parcel path** | `Wright_County_Parcels/…/1` | `HennepinData/LAND_PROPERTY/…/1` | `GeneralUse/Cadastral/…/23` |
| **Native SR** | 4326 (WGS84) | 26915 (NAD83 UTM 15N) | 102100 (Web Mercator) |
| **Parcel ID** | `PID` | `PID` | `PRCL_NBR` |
| **Owner** | `OWNNAME` | `OWNER_NM` | `OWNAME` |
| **Address** | `PHYSADDR` (single) | `HOUSE_NO` + `STREET_NM` + `MAILING_MUNIC_NM` + `ZIP_CD` (split) | `PHYSADDR` + `PHYSCITY` + `PHYSZIP` (split) |
| **ArcGIS version** | ~10.x | 10.91 | 11.3 |
| **Auth** | None | None | None |
| **Max records** | 2000 | 2000 | 2000 |
| **GeoJSON support** | — | Yes | Yes |

---

## 5. Key Differences That Impact Code

1. **Three different spatial references** — All queries must specify `inSR=4326` for
   input geometries and `outSR=4326` for output. The `_to_esri_polygon` method already
   uses `spatialReference: {wkid: 4326}`, so this works as-is as long as both
   counties accept `inSR=4326` (verified: they do).

2. **Field name differences** — Parcel ID is `PID` / `PID` / `PRCL_NBR`. Owner is
   `OWNNAME` / `OWNER_NM` / `OWNAME`. Address field layout varies.

3. **Address construction differences** — Wright has a single `PHYSADDR` field.
   Hennepin splits address into 4+ components. St. Louis splits into 3 components.

4. **Server path differences** — Each county uses a different URL pattern. The base
   URL config must be per-county, not a single global.

5. **Hennepin owner names are space-padded** — e.g., `"J M FOLINE & J G FOLINE            "`.
   Must `.strip()` after extraction.

6. **St. Louis `PHYSZIP` is double type** — Must convert to int then string to avoid
   trailing `.0`.

7. **St. Louis parcels can have null PHYSADDR** — Some rural/undeveloped parcels have
   no street address. Must handle gracefully (return empty string).

---

## 6. Frontend Impact

The current UI hardcodes:
- Page title: `ParcelPicker - Wright County`
- Subheading: `Wright County, MN address -> owner -> adjacent parcel rings`
- Property links: `Wright Property Search`, `Wright Parcel JSON`
- Map center: `[45.2, -93.95]` (Wright County area)
- Zillow/Realtor queries append `" Wright County MN"`

A county selector will be needed so the UI can show the right links, search queries,
and map center for each county.

---

## 7. Architectural Recommendation

Refactor from a single `WrightParcelService` to a **Strategy pattern**:

```
BaseParcelService      ← abstract base with query/retry/throttle/geometry logic
  ├── WrightParcelService   ← endpoint, field mapping, address construction
  ├── HennepinParcelService ← endpoint, field mapping, address construction
  └── StLouisParcelService  ← endpoint, field mapping, address construction
```

A factory / registry selects the right service at request time based on user input
(a `county` parameter in the API request or a UI selector).

The `ParcelLookupRunner` receives an abstract `BaseParcelService` interface and operates
the same regardless of county. The `source` field on `ParcelRecord` changes per county.

---

## 8. Verification Checklist

- [x] Hennepin County MapServer/1 (County Parcels) responds with features
- [x] Hennepin County MapServer/0 (Address Points) responds with features
- [x] Hennepin spatial query (`inSR=4326`, `outSR=4326`) returns correct results
- [x] St. Louis County MapServer/23 (Tax Parcels - Neighborhood) responds with features
- [x] St. Louis spatial query (`inSR=4326`, `outSR=4326`) returns correct results
- [x] Both services support `esriSpatialRelIntersects` and `esriSpatialRelTouches`
- [x] Neither service requires authentication for queries
