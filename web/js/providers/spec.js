// Generic provider driven by a declarative parcel adapter spec from ErisData
// (https://github.com/Eriskii/ErisData, CC-BY-4.0, by Eriskii). The specs are
// bundled, live-verified, in web/mn_parcel_specs.json; each one names an
// ArcGIS layer, its apn/owner/address fields, and an optional filter clause
// for statewide layers that hold several counties.
import { BaseParcelProvider } from "./base.js";

export class SpecParcelProvider extends BaseParcelProvider {
  adjacentSpatialRel = "esriSpatialRelIntersects";
  // Every bundled endpoint was verified to accept a long form POST with CORS.
  postLongQueries = true;

  constructor(spec, options = {}) {
    super(options);
    this.endpointUrl = `${spec.url}/query`;
    this.sourceLabel = `${spec.id}_county_arcgis`;
    this.parcelIdField = spec.fields.apn;
    this.ownerField = spec.fields.owner;
    // Only full street-address fields are kept in the bundle. Partial
    // (street name or house number only) and mailing-address mappings are
    // blanked there, so those counties skip the address WHERE queries and go
    // straight to geocode -> point intersect.
    this.addressField = spec.fields.address || "";
    this.filter = spec.filter || "";
  }

  async _queryByAddress(cleaned, budget) {
    if (!this.addressField) return null;
    return super._queryByAddress(cleaned, budget);
  }

  // Prefix rather than substring match, so "901 WALNUT ST" can't hit
  // "1901 WALNUT ST". Kept address fields start with the house number and
  // may carry a padded city/ZIP tail, which the prefix tolerates.
  _getAddressWhereContains(cleaned) {
    return `UPPER(${this.addressField}) LIKE '${this._sqlEscape(cleaned)}%'`;
  }

  // County layers pad values with runs of spaces ("901 WALNUT ST      MANTORVILLE")
  // and use stand-ins like "MN 0", "0 0-0" or " 00000" for "no site address".
  _buildAddress(attrs) {
    const raw = String(attrs[this.addressField] ?? "").replace(/\s+/g, " ").trim();
    return /^(?:MN )?[\d\s-]*$/.test(raw) ? "" : raw;
  }

  _featureToRecord(feature, matchedBy) {
    const record = super._featureToRecord(feature, matchedBy);
    record.owner_name = record.owner_name.replace(/\s+/g, " ");
    return record;
  }

  // Statewide layers carry every opt-in county; the filter clause pins each
  // query to this county (same safety idea as mn_state.js CO_NAME).
  async _queryCounty(params, budget) {
    if (this.filter) {
      params = { ...params, where: `(${params.where || "1=1"}) AND (${this.filter})` };
    }
    return super._queryCounty(params, budget);
  }
}
