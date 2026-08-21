// Port of backend/services/aitkin.py
import { BaseParcelProvider, streetPrefix } from "./base.js";

export class AitkinProvider extends BaseParcelProvider {
  endpointUrl =
    "https://gisweb.co.aitkin.mn.us/arcgis/rest/services/" +
    "ParcelTaxData/FeatureServer/0/query";
  sourceLabel = "aitkin_county_arcgis";
  parcelIdField = "PRCL_NBR";
  ownerField = "OWNNAME";
  addressField = "ADDR_1";
  extraOutFields = ["ADDR_2", "Physical_Address", "Physical_City", "Physical_Zip"];
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
    // ADDR_2 is "CITY MN ZIP" and ADDR_1 is street-only; strip commas and
    // trailing state + zip from full-address input.
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
    const street = String(attrs[this.addressField] ?? "").trim();
    // ADDR_2 is "CITY MN ZIP" — collapse its double spaces and use verbatim.
    const line2 = String(attrs.ADDR_2 ?? "").trim().replace(/\s+/g, " ");

    if (street && line2) return `${street}, ${line2}`;
    return street || line2;
  }
}
