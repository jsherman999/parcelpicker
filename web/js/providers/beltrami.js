// Port of backend/services/beltrami.py
import { BaseParcelProvider, streetPrefix } from "./base.js";

export class BeltramiProvider extends BaseParcelProvider {
  endpointUrl =
    "https://arcgis.co.beltrami.mn.us/arcgis/rest/services/" +
    "BeltramiData/BeltramiOpenData/MapServer/2/query";
  sourceLabel = "beltrami_county_arcgis";
  parcelIdField = "PIN";
  ownerField = "OWNERNAME1";
  addressField = "PROP_ADD1";
  extraOutFields = ["OWNERNAME2", "PROP_CITY", "PROP_ZIP"];
  adjacentSpatialRel = "esriSpatialRelIntersects";

  _getAddressWhereExact(cleaned) {
    const street = this._streetLine(cleaned);
    if (!street) return "1=0";
    return `UPPER(${this.addressField}) = '${this._sqlEscape(street)}'`;
  }

  _getAddressWhereContains(cleaned) {
    // PROP_ADD1 values carry trailing spaces, so a prefix match is the
    // robust containment test.
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
    // PROP_ADD1 is street-only, so drop a trailing city token if present.
    // A short trailing token is a directional, not a city.
    if (tokens.length > 4 && !/^\d+$/.test(tokens[tokens.length - 1]) && tokens[tokens.length - 1].length > 2) {
      return tokens.slice(0, -1).join(" ");
    }
    return stripped || null;
  }

  _featureToRecord(feature, matchedBy) {
    const record = super._featureToRecord(feature, matchedBy);
    const attrs = feature.attributes || {};
    const secondOwner = String(attrs.OWNERNAME2 ?? "").trim();
    if (record.owner_name && secondOwner) {
      record.owner_name = `${record.owner_name} & ${secondOwner}`;
    }
    return record;
  }

  _buildAddress(attrs) {
    const street = String(attrs[this.addressField] ?? "").trim();
    const city = String(attrs.PROP_CITY ?? "").trim();
    const zip = String(attrs.PROP_ZIP ?? "").trim();

    const suffixParts = [];
    suffixParts.push(city || "MN");
    if (zip) suffixParts.push(zip);
    const suffix = suffixParts.join(" ");

    if (street && suffix) return `${street}, ${suffix}`;
    return street || suffix;
  }
}
