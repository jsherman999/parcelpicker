// Port of backend/services/scott.py
import { BaseParcelProvider, streetPrefix } from "./base.js";

export class ScottProvider extends BaseParcelProvider {
  endpointUrl =
    "https://services.arcgis.com/DqIh9WAsIZcPlBEF/arcgis/rest/services/" +
    "Parcels/FeatureServer/0/query";
  sourceLabel = "scott_county_arcgis";
  parcelIdField = "PID";
  ownerField = "TaxPayerName";
  addressField = "PropertyAddress1";
  extraOutFields = ["PropertyCity", "PropertyZip"];
  adjacentSpatialRel = "esriSpatialRelIntersects";

  _getAddressWhereExact(cleaned) {
    const street = this._streetLine(cleaned);
    if (!street) return "1=0";
    // PropertyAddress1 is the street portion ("72 CEDAR LAKE CT"); exact
    // match against it after stripping city/state/zip from the input.
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
    // Drop a trailing city token if present; a short token is a directional.
    if (tokens.length > 4 && !/^\d+$/.test(tokens[tokens.length - 1]) && tokens[tokens.length - 1].length > 2) {
      return tokens.slice(0, -1).join(" ");
    }
    return stripped || null;
  }

  _buildAddress(attrs) {
    // Use the structured fields (PropertyAddress1 + city + zip) rather than
    // PropertyAddress, which sometimes already embeds "CITY, MN ZIP".
    const street = String(attrs[this.addressField] ?? "").trim();
    const city = String(attrs.PropertyCity ?? "").trim();
    const zip = String(attrs.PropertyZip ?? "").trim();

    const suffixParts = [];
    suffixParts.push(city || "MN");
    if (zip) suffixParts.push(zip);
    const suffix = suffixParts.join(" ");

    if (street && suffix) return `${street}, ${suffix}`;
    return street || suffix;
  }
}
