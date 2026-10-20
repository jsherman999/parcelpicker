// Browser port of backend/services/base.py BaseParcelService.
// httpx -> fetch; asyncio.Lock throttle -> awaited gap (JS is single-threaded).

import { sleep, fetchWithTimeout } from "../util.js";
import { geocodeAddress } from "../geocode.js";
import { esriToGeoJson, geoJsonToEsri } from "../geometry.js";
import { MATCHED_BY, normalizeText, toParcel } from "../model.js";

// Common US street-type and directional tokens, used to isolate the street
// line (house number + street) from a full "street, city, state zip" input.
const STREET_TYPES = new Set([
  "AVE", "AVENUE", "ST", "STREET", "RD", "ROAD", "LN", "LANE", "DR", "DRIVE",
  "BLVD", "BOULEVARD", "CT", "COURT", "CIR", "CIRCLE", "TRL", "TRAIL", "WAY",
  "PL", "PLACE", "PKWY", "PARKWAY", "HWY", "HIGHWAY", "TER", "TERRACE", "LOOP",
  "PATH", "PT", "POINT", "RUN", "PASS", "CV", "COVE", "XING", "CROSSING",
  "SQ", "SQUARE", "ALY", "ALLEY", "ROW", "BND", "BEND", "CRES", "CRESCENT",
]);

export const DIRECTIONALS = new Set(["N", "S", "E", "W", "NE", "NW", "SE", "SW"]);

// ArcGIS Online-hosted layers return 404 once a GET URL passes ~2,000 chars,
// which adjacency queries with detailed parcel polygons easily exceed.
const MAX_GET_URL_LENGTH = 2000;

// County layers mark "no value" with -9999, 0, "NULL", blanks or runs of
// spaces. These return "" / null for those so the UI can show "—".
export function cleanText(value) {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return /^(?:NULL|-9999(?:\.0+)?|0(?:\.0+)?)?$/i.test(s) ? "" : s;
}

export function cleanAmount(value) {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : parseFloat(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// House number + street name (+ type + directional), cut at the first
// street-type token so a trailing city token is excluded (mirror of
// backend/services/base.py street_prefix).
//   "30281 NATURE RD ROYALTON" -> "30281 NATURE RD"
// Falls back to the first 4 tokens when no street-type token is present.
export function streetPrefix(address) {
  const tokens = String(address || "").split(/\s+/).filter(Boolean);
  if (!tokens.length || !/^\d+$/.test(tokens[0])) return null;
  for (let i = 1; i < tokens.length; i += 1) {
    if (STREET_TYPES.has(tokens[i].toUpperCase())) {
      // A numeric token right after the type means it is part of the street
      // name ("TOWN ROAD 129"), not a boundary.
      if (i + 1 < tokens.length && /^\d+$/.test(tokens[i + 1])) continue;
      let end = i;
      if (i + 1 < tokens.length && DIRECTIONALS.has(tokens[i + 1].toUpperCase())) {
        end = i + 1;
      }
      return tokens.slice(0, end + 1).join(" ");
    }
  }
  return tokens.slice(0, 4).join(" ");
}

export class BaseParcelProvider {
  // Subclasses override these class fields.
  endpointUrl = "";
  // Label of this data source, recorded on runs and parcels as source_id.
  sourceId = "";
  parcelIdField = "";
  ownerField = "";
  addressField = "";
  extraOutFields = [];
  adjacentSpatialRel = "esriSpatialRelTouches";
  // Estimated Market Value (what Minnesota calls the assessed value): one
  // field, or a list of fields that are summed (Sherburne publishes land and
  // building EMV separately). valueYearField is the layer's assessment or
  // market year, when it has one. "" means the county doesn't publish it.
  valueField = "";
  valueYearField = "";
  landUseField = "";
  // Send queries whose URL would exceed MAX_GET_URL_LENGTH as a form POST
  // (still a CORS simple request, no preflight). Large rural parcels put
  // 1,000+ vertices in the adjacency geometry, and servers reject GET URLs
  // that long (e.g. Wright's ArcGIS Online layer answers 404). Every
  // hand-written provider's server accepted a cross-origin POST on
  // 2026-10-18 except Chisago, which opts out until it can be checked.
  postLongQueries = true;

  constructor({
    county = "",
    timeoutMs = 20000,
    retries = 2,
    backoffMs = 800,
    minIntervalMs = 150,
  } = {}) {
    // Registry id ("stlouis"); stamped on every parcel this provider returns.
    this.county = county;
    this._timeoutMs = timeoutMs;
    this._maxRetries = retries;
    this._backoffMs = backoffMs;
    this._minIntervalMs = minIntervalMs;
    this._lastRequestAt = 0;
    this._addressCache = new Map();
    this._parcelCache = new Map();
  }

  // ---- public lookup surface --------------------------------------------

  async lookup(address, budget) {
    const cleaned = normalizeText(address);
    if (!cleaned) throw new Error("Address must not be empty.");

    const cached = this._addressCache.get(cleaned);
    if (cached) return cached;

    let feature = await this._queryByAddress(cleaned, budget);
    if (feature) {
      const record = this._featureToRecord(feature, MATCHED_BY.ADDRESS);
      this._cacheRecord(cleaned, record);
      return record;
    }

    // Census street re-query is dropped: Nominatim's display_name doesn't map
    // cleanly to county address fields, so we go straight to point-intersect,
    // which is geometry-based and robust.
    budget.consume();
    const geocoded = await geocodeAddress(cleaned, { timeoutMs: this._timeoutMs });
    if (!geocoded) return null;

    feature = await this._queryByPoint(geocoded.lon, geocoded.lat, budget);
    if (!feature) return null;

    const record = this._featureToRecord(feature, MATCHED_BY.GEOCODE_POINT);
    this._cacheRecord(cleaned, record);
    return record;
  }

  async lookupByPoint({ lon, lat, budget }) {
    const feature = await this._queryByPoint(lon, lat, budget);
    if (!feature) return null;
    const record = this._featureToRecord(feature, MATCHED_BY.MAP_POINT);
    this._cacheRecord(null, record);
    return record;
  }

  async queryAdjacent(geometry, { budget, excludeIds, limit }) {
    if (!geometry) return [];
    const esri = geoJsonToEsri(geometry);
    if (!esri) return [];

    const features = await this._queryCounty(
      {
        where: "1=1",
        geometry: JSON.stringify(esri),
        geometryType: "esriGeometryPolygon",
        spatialRel: this.adjacentSpatialRel,
        inSR: "4326",
        outFields: this._getOutfields(),
        returnGeometry: "true",
        outSR: "4326",
        resultRecordCount: String(limit),
      },
      budget
    );

    const neighbors = [];
    for (const feature of features) {
      const record = this._featureToRecord(feature, MATCHED_BY.ADJACENT);
      if (!record.parcel_id || excludeIds.has(record.parcel_id)) continue;
      neighbors.push(record);
      this._cacheRecord(null, record);
    }
    return neighbors;
  }

  // ---- query helpers (overridable) --------------------------------------

  async _queryByAddress(cleaned, budget) {
    // Try the full input first, then a street-only variant. County address
    // fields often hold just the street line (e.g. Wright PHYSADDR = "4706
    // MAYER AVE NE"), so a full "street, city, state zip" input won't match
    // until we strip the city/state/zip. This keeps address matching working
    // without depending on the (sometimes inaccurate) geocoder.
    const candidates = [cleaned];
    const street = this._extractStreetLine(cleaned);
    if (street && street !== cleaned) candidates.push(street);

    for (const candidate of candidates) {
      for (const where of [
        this._getAddressWhereExact(candidate),
        this._getAddressWhereContains(candidate),
      ]) {
        const features = await this._queryCounty(
          {
            where,
            outFields: this._getOutfields(),
            returnGeometry: "true",
            outSR: "4326",
          },
          budget
        );
        const feature = this._firstFeatureWithPid(features);
        if (feature) return feature;
      }
    }
    return null;
  }

  async _queryByPoint(lon, lat, budget) {
    const features = await this._queryCounty(
      {
        where: "1=1",
        geometry: `${lon},${lat}`,
        geometryType: "esriGeometryPoint",
        spatialRel: "esriSpatialRelIntersects",
        inSR: "4326",
        outFields: this._getOutfields(),
        returnGeometry: "true",
        outSR: "4326",
      },
      budget
    );
    return this._firstFeatureWithPid(features);
  }

  async _queryCounty(params, budget) {
    const where = this._scopeWhere(params.where || "1=1");
    return this._queryUrl(this.endpointUrl, { ...params, where }, budget);
  }

  // Pins a WHERE clause to this county. Layers that hold several counties
  // (the MN state server, statewide spec layers) override it.
  _scopeWhere(where) {
    return where;
  }

  // This parcel's raw record on the county layer, as pretty JSON.
  parcelJsonUrl(parcelId) {
    const where = this._scopeWhere(`${this.parcelIdField}='${this._sqlEscape(parcelId)}'`);
    const params = new URLSearchParams({
      f: "pjson",
      where,
      outFields: this._getOutfields(),
      returnGeometry: "true",
      outSR: "4326",
    });
    return `${this.endpointUrl}?${params}`;
  }

  async _queryUrl(url, params, budget) {
    const data = await this._getJson(url, { f: "json", ...params }, budget);
    if (data && data.error) {
      const message = data.error.message || "ArcGIS query error";
      throw new Error(`Parcel query failed: ${message}`);
    }
    return (data && data.features) || [];
  }

  async _getJson(url, params, budget) {
    budget.consume();
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await this._throttle();
      try {
        const full = `${url}?${new URLSearchParams(params).toString()}`;
        const res =
          this.postLongQueries && full.length > MAX_GET_URL_LENGTH
            ? await fetchWithTimeout(
                url,
                { method: "POST", body: new URLSearchParams(params) },
                this._timeoutMs
              )
            : await fetchWithTimeout(full, {}, this._timeoutMs);

        if (res.status === 429 || res.status >= 500) {
          const e = new Error(`HTTP ${res.status}`);
          e.retryable = true;
          throw e;
        }
        if (res.status >= 400) {
          const text = (await res.text()).slice(0, 500);
          throw new Error(`Provider returned HTTP ${res.status}: ${text}`);
        }
        return await res.json();
      } catch (err) {
        const retryable = err.retryable || err.name === "AbortError" || err.name === "TypeError";
        if (retryable && attempt < this._maxRetries) {
          await sleep(this._backoffMs * 2 ** attempt);
          attempt += 1;
          continue;
        }
        throw new Error(`Provider request failed: ${err.message}`);
      }
    }
  }

  async _throttle() {
    if (this._minIntervalMs <= 0) return;
    const elapsed = Date.now() - this._lastRequestAt;
    const wait = this._minIntervalMs - elapsed;
    if (wait > 0) await sleep(wait);
    this._lastRequestAt = Date.now();
  }

  // ---- field + WHERE builders (overridable) -----------------------------

  _getOutfields() {
    const fields = [this.parcelIdField, this.ownerField];
    if (this.addressField) fields.push(this.addressField);
    fields.push(...this.extraOutFields, ...this._valueFields());
    if (this.valueYearField) fields.push(this.valueYearField);
    if (this.landUseField) fields.push(this.landUseField);
    return [...new Set(fields)].join(",");
  }

  _valueFields() {
    return [this.valueField].flat().filter(Boolean);
  }

  _marketValue(attrs) {
    const parts = this._valueFields().map((f) => cleanAmount(attrs[f])).filter((n) => n !== null);
    return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
  }

  _marketValueYear(attrs) {
    const year = this.valueYearField ? Math.trunc(cleanAmount(attrs[this.valueYearField]) || 0) : 0;
    return year >= 1990 && year <= 2100 ? String(year) : "";
  }

  _getAddressWhereExact(cleaned) {
    return `UPPER(${this.addressField}) = '${this._sqlEscape(cleaned)}'`;
  }

  _getAddressWhereContains(cleaned) {
    return `UPPER(${this.addressField}) LIKE '%${this._sqlEscape(cleaned)}%'`;
  }

  _buildAddress(attrs) {
    return String(attrs[this.addressField] ?? "").trim();
  }

  // ---- record + geometry conversion -------------------------------------

  // A feature may carry its own matchedBy (set by a provider that found it
  // another way, e.g. through an address point); it wins over the caller's.
  _featureToRecord(feature, matchedBy) {
    const attrs = feature.attributes || {};
    return toParcel({
      county: this.county,
      parcel_id: attrs[this.parcelIdField],
      owner_name: attrs[this.ownerField],
      site_address: this._buildAddress(attrs),
      market_value: this._marketValue(attrs),
      market_value_year: this._marketValueYear(attrs),
      land_use: this.landUseField ? cleanText(attrs[this.landUseField]) : "",
      geometry: esriToGeoJson(feature.geometry),
      source_id: this.sourceId,
      matched_by: feature.matchedBy || matchedBy,
    });
  }

  // ---- string helpers ----------------------------------------------------

  // Extract just the street line from a full address, e.g.
  // "4706 MAYER AVE NE ST MICHAEL, MN 55376" -> "4706 MAYER AVE NE".
  // Heuristic: drop trailing state+zip, require a leading house number, then
  // cut at the first street-type token (+ optional trailing directional).
  _extractStreetLine(cleaned) {
    let s = String(cleaned || "")
      .replace(/,/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    s = s.replace(/\s+MN(\s+\d{5}(?:-\d{4})?)?$/i, "").trim();

    const tokens = s.split(" ").filter(Boolean);
    if (!tokens.length || !/^\d/.test(tokens[0])) return null;

    let cut = -1;
    for (let i = 1; i < tokens.length; i += 1) {
      if (STREET_TYPES.has(tokens[i])) {
        cut = i;
        break;
      }
    }
    if (cut === -1) return null;

    let end = cut;
    if (end + 1 < tokens.length && DIRECTIONALS.has(tokens[end + 1])) {
      end = cut + 1;
    }
    return tokens.slice(0, end + 1).join(" ");
  }

  _sqlEscape(value) {
    return String(value).replace(/'/g, "''");
  }

  _firstFeatureWithPid(features) {
    for (const feature of features) {
      const attrs = feature.attributes || {};
      const pid = String(attrs[this.parcelIdField] ?? "").trim();
      if (pid) return feature;
    }
    return null;
  }

  _cacheRecord(normalizedAddress, record) {
    if (normalizedAddress) this._addressCache.set(normalizedAddress, record);
    if (record.parcel_id) this._parcelCache.set(record.parcel_id, record);
  }
}
