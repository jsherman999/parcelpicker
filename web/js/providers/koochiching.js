// Port of backend/services/koochiching.py
import { BaseParcelProvider, streetPrefix } from "./base.js";

export class KoochichingProvider extends BaseParcelProvider {
  endpointUrl =
    "https://services3.arcgis.com/8mdusDCY0WncdJVw/arcgis/rest/services/" +
    "KoochichingCountyParcelDataPublish/FeatureServer/0/query";
  sourceLabel = "koochiching_county_arcgis";
  parcelIdField = "PARCEL_ID";
  ownerField = "OWNNAME";
  addressField = "ADDR_1";
  extraOutFields = ["CITY", "ZIP_CODE_5"];
  adjacentSpatialRel = "esriSpatialRelIntersects";

  _getAddressWhereExact(cleaned) {
    const street = this._streetLine(cleaned);
    if (!street) return "1=0";
    return `UPPER(${this.addressField}) = '${this._sqlEscape(street)}'`;
  }

  _getAddressWhereContains(cleaned) {
    const prefix = streetPrefix(this._stripStateZip(cleaned));
    if (!prefix) return "1=0";
    return `UPPER(${this.addressField}) LIKE '${this._sqlEscape(prefix)}%'`;
  }

  _stripStateZip(address) {
    address = address.replace(/\s*,\s*/g, " ");
    return address.replace(/\s+MN\s+\d{5}(?:-\d{4})?$/i, "").trim();
  }

  _streetLine(address) {
    const stripped = this._stripStateZip(address);
    const tokens = stripped.split(/\s+/).filter(Boolean);
    // ADDR_1 is street-only, so drop a trailing city token if present.
    // A short trailing token is a directional, not a city.
    if (tokens.length > 4 && !/^\d+$/.test(tokens[tokens.length - 1]) && tokens[tokens.length - 1].length > 2) {
      return tokens.slice(0, -1).join(" ");
    }
    return stripped || null;
  }

  _formatZip(value) {
    if (value === null || value === undefined || value === "") return "";
    const n = parseInt(value, 10);
    if (Number.isFinite(n)) return n > 0 ? String(n) : "";
    return String(value).trim();
  }

  _buildAddress(attrs) {
    const street = String(attrs[this.addressField] ?? "").trim();
    const city = String(attrs.CITY ?? "").trim();
    const zip = this._formatZip(attrs.ZIP_CODE_5);

    const suffixParts = [];
    if (!city) {
      suffixParts.push("MN");
    } else {
      suffixParts.push(city);
      // CITY sometimes already carries the state ("INT'L FALLS, MN").
      if (!city.toUpperCase().endsWith("MN")) suffixParts.push("MN");
    }
    if (zip) suffixParts.push(zip);
    const suffix = suffixParts.join(" ");

    if (street && suffix) return `${street}, ${suffix}`;
    return street || suffix;
  }
}
