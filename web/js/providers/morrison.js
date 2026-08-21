// Port of backend/services/morrison.py
import { BaseParcelProvider, streetPrefix } from "./base.js";

const STREET_FIELDS = ["SitusStNo", "SitusStName", "SitusStType", "SitusPostDir"];

export class MorrisonProvider extends BaseParcelProvider {
  endpointUrl =
    "https://services1.arcgis.com/lQjrBHFnTgKBR9zX/arcgis/rest/services/" +
    "Parcels/FeatureServer/0/query";
  sourceLabel = "morrison_county_arcgis";
  parcelIdField = "PIN";
  ownerField = "Primary_Owner";
  // Single usable street string; the Situs* components are stored with the
  // literal text "NULL" on many records, so the freeform field is the
  // reliable match target ("30281 NATURE RD").
  addressField = "Situs_Freeform_Addr";
  extraOutFields = [
    ...STREET_FIELDS,
    "SitusCity",
    "SitusZip",
    "Mailing_Delivery_Addr",
    "City_Twp",
  ];
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
    // Drop a trailing city token if present; a short token is a directional.
    if (tokens.length > 4 && !/^\d+$/.test(tokens[tokens.length - 1]) && tokens[tokens.length - 1].length > 2) {
      return tokens.slice(0, -1).join(" ");
    }
    return stripped || null;
  }

  _clean(value) {
    // Many records store the literal text "NULL" instead of a null.
    const text = String(value ?? "").trim();
    return text.toUpperCase() === "NULL" ? "" : text;
  }

  _buildAddress(attrs) {
    const parts = STREET_FIELDS.map((f) => this._clean(attrs[f]));
    let street = parts.filter(Boolean).join(" ");

    if (!street) {
      // Fall back to the mailing/delivery address when the Situs components
      // are empty or "NULL".
      street = this._clean(attrs.Mailing_Delivery_Addr);
    }

    const city = this._clean(attrs.SitusCity) || this._clean(attrs.City_Twp);
    const zip = this._clean(attrs.SitusZip);

    const suffixParts = [];
    suffixParts.push(city || "MN");
    if (zip) suffixParts.push(zip);
    const suffix = suffixParts.join(" ");

    if (street && suffix) return `${street}, ${suffix}`;
    return street || suffix;
  }
}
