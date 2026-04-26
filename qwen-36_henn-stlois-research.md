# Multi-County Parcel Data Research — Hennepin & St. Louis, MN

## Overview

This document details the verified public ArcGIS REST endpoints and field mappings for parcel data in Hennepin County and St. Louis County, Minnesota. Both counties expose ArcGIS Server REST services that support address lookup, point-in-parcel queries, adjacent parcel queries (`Touches`), and geoJSON output — matching the capabilities the existing Wright County provider relies on.

---

## Hennepin County

### Base URL
`https://gis.hennepin.us/arcgis/rest/services`

### Parcel Service
- **URL**: `https://gis.hennepin.us/arcgis/rest/services/HennepinData/LAND_PROPERTY/MapServer/1`
- **Layer name**: County Parcels
- **Geometry type**: `esriGeometryPolygon`
- **Capabilities**: `Map, Query, Data`
- **Supported query formats**: `JSON, geoJSON, PBF`
- **Max record count**: 2000
- **Advanced query support**: Pagination, ORDER BY, DISTINCT, COUNT DISTINCT, statistics, percentile statistics, HAVING clauses, spatial relation queries, time relations
- **Supported spatial relationships**: `esriSpatialRelIntersects`, `esriSpatialRelContains`, `esriSpatialRelCrosses`, `esriSpatialRelEnvelopeIntersects`, `esriSpatialRelIndexIntersects`, `esriSpatialRelOverlaps`, `esriSpatialRelTouches`, `esriSpatialRelWithin`, `esriSpatialRelRelation`

### Other layers in this service
| ID | Name | Geometry |
|---|---|---|
| 0 | Address Points | Point |
| 1 | **County Parcels** | Polygon |
| 4 | PLS Points | Point |

### Field Mapping

| Concept | Field Name | Type | Notes |
|---|---|---|---|
| **Parcel ID** | `PID` | String (13) | Primary property ID |
| | `PID_TEXT` | String (12) | Text representation of PID |
| **Owner Name** | `OWNER_NM` | String (35) | Primary owner name |
| | `TAXPAYER_NM` | String (28) | Taxpayer name |
| | `TAXPAYER_NM_1` | String (28) | Taxpayer name alt |
| | `TAXPAYER_NM_2` | String (28) | Taxpayer name alt |
| | `TAXPAYER_NM_3` | String (28) | Taxpayer name alt |
| **House Number** | `HOUSE_NO` | String | |
| | `FRAC_HOUSE_NO` | String | Fractional house number |
| **Street** | `STREET_NM` | String | |
| **Condo** | `CONDO_NO` | String | |
| **City** | `MUNIC_NM` / `MUNIC_CD` | String | Municipality name & code |
| **ZIP** | `ZIP_CD` | String | |
| **Legal** | `ABBREV_ADDN_NM` | String | |
| | `ADDITION_NO` | String | |
| | `LOT` | String | |
| | `BLOCK` | String | |
| **Market Value** | `MKT_VAL_TOT` | Integer | Total market value |
| **Taxable Value** | `TAXABLE_VAL_TOT` | Integer | Total taxable value |
| **Tax Amount** | `TAX_TOT` | Double | |
| | `NET_TAX_PD` | Double | Net tax paid |
| **Sale Info** | `SALE_DATE` | String (6) | |
| | `SALE_PRICE` | Integer | |
| | `SALE_CODE_NAME` | String (50) | Display field |
| **Year Built** | `BUILD_YR` | String (4) | |
| **Coordinates** | `LAT` / `LON` | Double | Geographic coords |
| **Area** | `PARCEL_AREA` | Double | In meters |
| **Geometry** | `Shape` | Polygon | |

### Other folders in Hennepin GIS
- `BOUNDARIES`, `ENVIRONMENT`, `HEALTH`, `HEAT_WATCH`, `LAND_PROPERTY` (parcel), `LANDSLIDE_DATED`, `LANDSLIDE_UNDATED`, `PLACES`, `TRANSPORTATION`

---

## St. Louis County

### Base URLs
- **Portal**: `https://gis.stlouiscountymn.gov/`
- **REST services**: Multiple server instances (`server1`, `server2`)
- **County Land Explorer**: `https://gis.stlouiscountymn.gov/landexplorer/`
- **ArcGIS Hub**: `https://open-data-slcgis.hub.arcgis.com/`
- **Portal REST**: `https://gis.stlouiscountymn.gov/portal/sharing/rest/`

### Parcel Service
- **URL**: `https://gis.stlouiscountymn.gov/server2/rest/services/GeneralUse/Open_Data/MapServer/7`
- **Layer name**: Parcels
- **Geometry type**: `esriGeometryPolygon`
- **Capabilities**: `Map, Query, Data`
- **Supported query formats**: `JSON, geoJSON, PBF`
- **Max record count**: 2000
- **Advanced query support**: Pagination, ORDER BY, DISTINCT, statistics, spatial queries

### Other layers in Open_Data service
| ID | Name | Geometry |
|---|---|---|
| 1 | County Boundary | Feature Layer |
| 2 | Minor Civil Divisions | Feature Layer |
| 3 | Cadastral Corners | Feature Layer |
| 6 | Parcels State Standard | Feature Layer |
| **7** | **Parcels** | Feature Layer |
| 10 | Lots | Feature Layer |
| 11 | Blocks | Feature Layer |
| 12 | Subdivisions | Feature Layer |
| 13 | Quarter Quarters | Feature Layer |
| 14 | Quarters | Feature Layer |
| 15 | Sections | Feature Layer |
| 16 | Townships | Feature Layer |
| 17 | **Address Points** | Feature Layer |
| 18 | Road Centerlines | Feature Layer |
| 19 | Zoning | Feature Layer |
| 20 | School Districts | Feature Layer |

### Other discovered services
| Service | URL | Notes |
|---|---|---|
| LIP_Base | `...server1/.../LandInformationPortal/LIP_Base/MapServer` | Land Information Portal (404 on some requests) |
| Cadastral | `...server2/.../GeneralUse/Cadastral/MapServer` | Has Tax Parcels layers (ID 23, 24) |
| Cadastral WMS | `...server2/.../GeneralUse/Cadastral/MapServer/WMSServer` | WMS endpoint |
| EGIS_Parcels | `...server2/.../EGIS_AddressLocators/EGIS_Parcels/GeocodeServer` | Geocoder (tested, returns 0 results) |

### Field Mapping

| Concept | Field Name | Type | Notes |
|---|---|---|---|
| **Parcel ID** | `PRCL_NBR` | String (255) | Primary parcel number |
| **Owner Name** | `OWNAME` | String (35) | Owner name |
| | `TXNAME` | String (35) | Taxpayer name |
| **Owner Address** | `OWADR1` | String (35) | Owner address line 1 |
| | `OWADR2` | String (35) | Owner address line 2 |
| | `OWADR3` | String (35) | Owner address line 3 |
| | `OWADR4` | String (35) | Owner address line 4 |
| **Tax Address** | `TXADR1`–`TXADR4` | String (35) | Taxpayer address lines |
| **Physical Address** | `PHYSADDR` | String (55) | Site/property address |
| **Physical City** | `PHYSCITY` | String (25) | |
| **Physical ZIP** | `PHYSZIP` | Double | |
| **Tax District** | `TAX_DIST_NAME` | String (35) | Display field |
| **Legal Description** | `LEGAL` | String (huge) | Full legal description |
| **Acres** | `ACREAGE` | Double | |
| | `DEEDED_ACRES` | Double | |
| **Township/Range/Section** | `TOWNSHIP` | Double | |
| | `RANGE` | SmallInteger | |
| | `SECTION` | SmallInteger | |
| **Values** | `LAND_EST` | Double | Land estimate |
| | `BUILDING` | Double | Building value |
| | `TaxableMarketValue` | Double | |
| | `EstTotalValue` | Double | |
| **Tax Year** | `TAX_YR` | SmallInteger | |
| | `ASMT_YR` | SmallInteger | |
| **Ownership** | `Ownership` | String (30) | |
| **Parcel Type** | `ParcelType` | String (2) | |
| **Homestead** | `HSTD_CHOICE` | SmallInteger | |
| | `HSTD_CODE1` | SmallInteger | |
| **Sale Date** | `LASTSALEDATE` | Double | |
| **Geometry** | `Shape` | Polygon | |
| **TWP/City** | `TWPCITY` | String (3) | |
| **Multiple Property** | `MULTIPROPNBR` | String (15) | |

### Geocoder Status
The built-in `EGIS_Parcels` geocoder at `...server2/.../EGIS_AddressLocators/EGIS_Parcels/GeocodeServer/findAddressCandidates` **returns 0 results** for tested addresses. We must use the Census geocoder fallback (already implemented in the Wright provider) for St. Louis County.

### Verified Test Query Results
```
Query: PHYSADDR LIKE '%4706%'
Results: 14 records found
Example:
  PIN: 010-2780-01500
  Address: 4706 OAKLEY ST, DULUTH MN
  Owner: BAUM JILL
  Has geometry: True

Query: OWNAME LIKE '%SMITH%'
Results: 560 records found
```

---

## Comparison Table

| Aspect | Wright County | Hennepin County | St. Louis County |
|---|---|---|---|
| **Base URL** | `web.co.wright.mn.us` | `gis.hennepin.us` | `gis.stlouiscountymn.gov` |
| **Service Path** | `.../Wright_County_Parcels/MapServer/1` | `.../HennepinData/LAND_PROPERTY/MapServer/1` | `.../server2/.../Open_Data/MapServer/7` |
| **Parcel ID field** | `PARCELID` | `PID` | `PRCL_NBR` |
| **Owner field** | `OWNNAME` | `OWNER_NM` | `OWNAME` |
| **Site address** | `SITEADDRESS` | `HOUSE_NO` + `STREET_NM` | `PHYSADDR` |
| **City field** | embedded in SITEADDRESS | `MUNIC_NM` | `PHYSCITY` |
| **Built-in geocoder** | ✅ Works | ❓ Unknown | ❌ Returns 0 results |
| **Max records** | 1000 | 2000 | 2000 |
| **geoJSON output** | ✅ | ✅ | ✅ |
| **Touches spatial query** | ✅ | ✅ | ✅ |
| **Address Points layer** | Separate service | ID 0 in same service | ID 17 in Open_Data |
| **Server type** | ArcGIS Server REST | ArcGIS Server REST | ArcGIS Server REST |

## Wright County (existing — reference)

### Parcel Service
- **URL**: `https://web.co.wright.mn.us/arcgisserver/rest/services/Wright_County_Parcels/MapServer/1`
- **Query endpoint**: `.../MapServer/1/query`
- **Field mapping**:
  | Concept | Field |
  |---|---|
  | Parcel ID | `PARCELID` |
  | Owner name | `OWNNAME` |
  | Site address | `SITEADDRESS` |

### Lookup Chain (existing implementation)
1. Exact address match → 2. Fuzzy address match → 3. Census geocoder fallback → 4. Point-intersect fallback

### Services
- **Geocoder**: `https://geocoder.citizenspot.com/arcgis/rest/services/Hosted/Wright_County_Address_Points_Combined/GeocodeServer/findAddressCandidates`
- **Parcels**: `https://web.co.wright.mn.us/arcgisserver/rest/services/Wright_County_Parcels/MapServer/1`

---

## Notes

1. All three counties use ArcGIS Server REST services with the same query parameter conventions (`where`, `outFields`, `returnGeometry`, `outSR`, `f`, `geometry`, `geometryType`, `spatialRel`).
2. The `Touches` spatial relationship is supported by all three services — enabling ring expansion to work identically.
3. St. Louis County's built-in geocoder is non-functional; the Census geocoder fallback should be used.
4. All services support geoJSON output format (`f=geoJSON`), which is useful for the existing export functionality.
5. Server-to-server latency may vary; the existing timeout and retry logic should be sufficient.
