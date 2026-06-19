// Port of backend/services/sherburne.py
import { BaseParcelProvider } from "./base.js";

export class SherburneProvider extends BaseParcelProvider {
  endpointUrl =
    "https://gis.co.sherburne.mn.us/arcgis/rest/services/" +
    "OpenData/Parcels/FeatureServer/0/query";
  sourceLabel = "sherburne_county_arcgis";
  parcelIdField = "PIN";
  ownerField = "OWNER_NAME";
  addressField = "";
  extraOutFields = [
    "BLDG_NUM",
    "STREETNAME",
    "STREETTYPE",
    "SUFFIX_DIR",
    "UNIT_INFO",
    "CITY_MAIL",
    "ZIP",
  ];

  _getOutfields() {
    return [this.parcelIdField, this.ownerField, ...this.extraOutFields].join(",");
  }

  _getAddressWhereExact(cleaned) {
    const houseNo = this._extractHouseNumber(cleaned);
    const streetToken = this._extractStreetToken(cleaned);
    if (streetToken === null && houseNo === null) return "1=0";

    const clauses = [];
    if (houseNo !== null) clauses.push(`BLDG_NUM = ${houseNo}`);
    if (streetToken) clauses.push(`UPPER(STREETNAME) LIKE '%${this._sqlEscape(streetToken)}%'`);
    return clauses.join(" AND ");
  }

  _getAddressWhereContains(cleaned) {
    const streetToken = this._extractStreetToken(cleaned);
    if (!streetToken) return "1=0";
    return `UPPER(STREETNAME) LIKE '%${this._sqlEscape(streetToken)}%'`;
  }

  _buildAddress(attrs) {
    const bldg = attrs.BLDG_NUM;
    const streetName = String(attrs.STREETNAME ?? "").trim();
    const streetType = String(attrs.STREETTYPE ?? "").trim();
    const suffixDir = String(attrs.SUFFIX_DIR ?? "").trim();
    const unit = String(attrs.UNIT_INFO ?? "").trim();
    const city = String(attrs.CITY_MAIL ?? "").trim();
    const zipStr = this._formatZip(attrs.ZIP);

    const parts = [];
    if (bldg !== null && bldg !== undefined) {
      const n = parseInt(bldg, 10);
      if (Number.isFinite(n) && n > 0) parts.push(String(n));
    }
    if (streetName) parts.push(streetName);
    if (streetType) parts.push(streetType);
    if (suffixDir) parts.push(suffixDir);
    if (unit) parts.push(unit);
    const streetLine = parts.join(" ");

    const suffixParts = [];
    suffixParts.push(city || "MN");
    if (zipStr) suffixParts.push(zipStr);
    const suffix = suffixParts.join(" ");

    if (streetLine && suffix) return `${streetLine}, ${suffix}`;
    return streetLine || suffix;
  }

  _formatZip(value) {
    if (value === null || value === undefined) return "";
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? String(n) : String(value).trim();
  }

  _extractHouseNumber(address) {
    const match = address.match(/^\s*(\d+)\b/);
    return match ? parseInt(match[1], 10) : null;
  }

  _extractStreetToken(address) {
    const withoutHouse = address.replace(/^\s*\d+\S?\s+/, "").trim();
    if (!withoutHouse) return null;
    const first = withoutHouse.split(/\s+/)[0].trim();
    return first || null;
  }
}
