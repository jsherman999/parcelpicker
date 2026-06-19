// Browser port of backend/services/base.py BaseParcelService.
// httpx -> fetch; asyncio.Lock throttle -> awaited gap (JS is single-threaded).

import { sleep, fetchWithTimeout } from "../util.js";
import { geocodeAddress } from "../geocode.js";

export class BaseParcelProvider {
  // Subclasses override these class fields.
  endpointUrl = "";
  sourceLabel = "";
  parcelIdField = "";
  ownerField = "";
  addressField = "";
  extraOutFields = [];
  adjacentSpatialRel = "esriSpatialRelTouches";

  constructor({
    timeoutMs = 20000,
    retries = 2,
    backoffMs = 800,
    minIntervalMs = 150,
  } = {}) {
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
    const cleaned = this._normalizeAddress(address);
    if (!cleaned) throw new Error("Address must not be empty.");

    const cached = this._addressCache.get(cleaned);
    if (cached) return cached;

    let feature = await this._queryByAddress(cleaned, budget);
    if (feature) {
      const record = this._featureToRecord(feature, `${this.sourceLabel}_address`);
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

    const record = this._featureToRecord(feature, "geocode_point_intersect");
    this._cacheRecord(cleaned, record);
    return record;
  }

  async lookupByPoint({ lon, lat, budget }) {
    const feature = await this._queryByPoint(lon, lat, budget);
    if (!feature) return null;
    const record = this._featureToRecord(feature, "map_click_intersect");
    this._cacheRecord(null, record);
    return record;
  }

  async queryAdjacent(geometry, { budget, excludeIds, limit }) {
    if (!geometry) return [];
    const esri = this._toEsriPolygon(geometry);
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
      const record = this._featureToRecord(feature, `${this.sourceLabel}_touches`);
      if (!record.parcel_id || excludeIds.has(record.parcel_id)) continue;
      neighbors.push(record);
      this._cacheRecord(null, record);
    }
    return neighbors;
  }

  // ---- query helpers (overridable) --------------------------------------

  async _queryByAddress(cleaned, budget) {
    const exactWhere = this._getAddressWhereExact(cleaned);
    let features = await this._queryCounty(
      {
        where: exactWhere,
        outFields: this._getOutfields(),
        returnGeometry: "true",
        outSR: "4326",
      },
      budget
    );
    let feature = this._firstFeatureWithPid(features);
    if (feature) return feature;

    const containsWhere = this._getAddressWhereContains(cleaned);
    features = await this._queryCounty(
      {
        where: containsWhere,
        outFields: this._getOutfields(),
        returnGeometry: "true",
        outSR: "4326",
      },
      budget
    );
    return this._firstFeatureWithPid(features);
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
    return this._queryUrl(this.endpointUrl, params, budget);
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
        const res = await fetchWithTimeout(full, {}, this._timeoutMs);

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
    fields.push(...this.extraOutFields);
    return fields.join(",");
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

  _featureToRecord(feature, matchedBy) {
    const attrs = feature.attributes || {};
    const geometry = this._geometryToGeojson(feature.geometry);
    return {
      parcel_id: String(attrs[this.parcelIdField] ?? "").trim(),
      owner_name: String(attrs[this.ownerField] ?? "").trim(),
      site_address: this._buildAddress(attrs),
      geometry,
      source: this.sourceLabel,
      matched_by: matchedBy,
    };
  }

  _geometryToGeojson(geometry) {
    if (!geometry) return null;
    if ("rings" in geometry) {
      return { type: "Polygon", coordinates: geometry.rings };
    }
    if ("x" in geometry && "y" in geometry) {
      return { type: "Point", coordinates: [geometry.x, geometry.y] };
    }
    return null;
  }

  _toEsriPolygon(geojson) {
    if (!geojson || geojson.type !== "Polygon") return null;
    const rings = geojson.coordinates;
    if (!Array.isArray(rings)) return null;
    return { rings, spatialReference: { wkid: 4326 } };
  }

  // ---- string helpers ----------------------------------------------------

  _normalizeAddress(address) {
    return String(address || "").trim().toUpperCase().split(/\s+/).join(" ");
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
