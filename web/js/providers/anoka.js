// Port of backend/services/anoka.py
import { BaseParcelProvider } from "./base.js";

export class AnokaProvider extends BaseParcelProvider {
  endpointUrl =
    "https://gisservices.co.anoka.mn.us/anoka_gis/rest/services/" +
    "Parcels/FeatureServer/0/query";
  sourceLabel = "anoka_county_arcgis";
  parcelIdField = "PIN";
  ownerField = "OWNER";
  addressField = "LOC_ADDR";
  extraOutFields = ["LOC_CITY", "LOC_ZIP"];

  _getAddressWhereExact(cleaned) {
    const stripped = this._stripStateZip(cleaned);
    if (!stripped) return "1=0";
    return `UPPER(${this.addressField}) = '${this._sqlEscape(stripped)}'`;
  }

  _getAddressWhereContains(cleaned) {
    const prefix = this._streetPrefix(cleaned);
    if (!prefix) return "1=0";
    return `UPPER(${this.addressField}) LIKE '${this._sqlEscape(prefix)}%'`;
  }

  _stripStateZip(address) {
    return address.replace(/\s+MN\s+\d{5}(?:-\d{4})?$/i, "").trim();
  }

  _streetPrefix(address) {
    const stripped = this._stripStateZip(address);
    const tokens = stripped.split(/\s+/).filter(Boolean);
    if (!tokens.length || !/^\d+$/.test(tokens[0])) return null;
    // House number + up to 3 more tokens anchors a prefix match against LOC_ADDR.
    return tokens.slice(0, 4).join(" ");
  }

  _buildAddress(attrs) {
    const street = String(attrs[this.addressField] ?? "").trim();
    const city = String(attrs.LOC_CITY ?? "").trim();
    const zip = String(attrs.LOC_ZIP ?? "").trim();

    const suffixParts = [];
    suffixParts.push(city || "MN");
    if (zip) suffixParts.push(zip);
    const suffix = suffixParts.join(" ");

    if (street && suffix) return `${street}, ${suffix}`;
    return street || suffix;
  }
}
