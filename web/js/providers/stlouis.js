// Port of backend/services/stlouis.py
import { BaseParcelProvider } from "./base.js";

export class StLouisProvider extends BaseParcelProvider {
  endpointUrl =
    "https://gis.stlouiscountymn.gov/server2/rest/services/" +
    "GeneralUse/Cadastral/MapServer/23/query";
  sourceLabel = "stlouis_county_arcgis";
  parcelIdField = "PRCL_NBR";
  ownerField = "OWNAME";
  addressField = "PHYSADDR";
  extraOutFields = ["PHYSCITY", "PHYSZIP"];

  _getAddressWhereExact(cleaned) {
    return `UPPER(${this.addressField}) = '${this._sqlEscape(this._extractStreetPortion(cleaned))}'`;
  }

  _getAddressWhereContains(cleaned) {
    return `UPPER(${this.addressField}) LIKE '%${this._sqlEscape(this._extractStreetPortion(cleaned))}%'`;
  }

  _extractStreetPortion(address) {
    let result = address.replace(/\s+MN\s+\d{5}(?:-\d{4})?$/i, "");
    result = result.trim().replace(/\s+\S+$/, "");
    return this._normalizeAddress(result);
  }

  _buildAddress(attrs) {
    const street = String(attrs.PHYSADDR ?? "").trim();
    const city = String(attrs.PHYSCITY ?? "").trim();
    const zipVal = attrs.PHYSZIP;

    let zipStr = "";
    if (zipVal !== null && zipVal !== undefined) {
      const n = parseInt(zipVal, 10);
      zipStr = Number.isFinite(n) ? String(n) : "";
    }

    const suffixParts = [];
    suffixParts.push(city || "MN");
    if (zipStr) suffixParts.push(zipStr);
    const suffix = suffixParts.join(" ");

    if (street && suffix) return `${street}, ${suffix}`;
    return street || suffix;
  }
}
