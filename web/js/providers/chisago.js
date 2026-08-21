// Port of backend/services/chisago.py
import { BaseParcelProvider, streetPrefix } from "./base.js";

export class ChisagoProvider extends BaseParcelProvider {
  endpointUrl =
    "https://gis.chisagocounty.us/arcgis/rest/services/" +
    "AssessmentInformation/TaxParcels/MapServer/0/query";
  sourceLabel = "chisago_county_arcgis";
  parcelIdField = "PIN";
  ownerField = "Ownname";
  addressField = "PropAddr";
  extraOutFields = ["PropCity", "PropZip"];
  adjacentSpatialRel = "esriSpatialRelIntersects";

  _getAddressWhereExact(cleaned) {
    const street = this._streetLine(cleaned);
    if (!street) return "1=0";
    return `UPPER(${this.addressField}) = '${this._sqlEscape(street)}'`;
  }

  _getAddressWhereContains(cleaned) {
    // PropAddr values carry trailing spaces, so a prefix match is the robust
    // containment test ("16823 RIVER RD " vs input "16823 RIVER RD").
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
    // PropAddr is street-only, so drop a trailing city token if present.
    // A short trailing token is a directional, not a city.
    if (tokens.length > 4 && !/^\d+$/.test(tokens[tokens.length - 1]) && tokens[tokens.length - 1].length > 2) {
      return tokens.slice(0, -1).join(" ");
    }
    return stripped || null;
  }

  _buildAddress(attrs) {
    const street = String(attrs[this.addressField] ?? "").trim();
    const city = String(attrs.PropCity ?? "").trim();
    const zip = String(attrs.PropZip ?? "").trim();

    const suffixParts = [];
    suffixParts.push(city || "MN");
    if (zip) suffixParts.push(zip);
    const suffix = suffixParts.join(" ");

    if (street && suffix) return `${street}, ${suffix}`;
    return street || suffix;
  }
}
