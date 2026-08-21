// Port of backend/services/mn_state.py
import { BaseParcelProvider } from "./base.js";

// All seven metro counties are published on one MN state ArcGIS server, one
// layer each (0 Anoka, 1 Carver, 2 Dakota, 3 Hennepin, 4 Ramsey, 5 Scott,
// 6 Washington). Anoka/Hennepin/Ramsey/Scott use their own county services;
// the ones below share this statewide schema.
export const MN_STATE_PARCELS_FEATURESERVER =
  "https://arcgis.metc.state.mn.us/data1/rest/services/parcels/Parcels/FeatureServer";

export class MnStateSchemaProvider extends BaseParcelProvider {
  // Shared adapter for metro counties on the MN state parcel server.
  // Schema: PIN / OWNER_NAME / ANUMBER (int) / ST_NAME / ST_POS_TYP /
  // ST_POS_DIR / CTU_NAME / ZIP. Subclasses pin the layer index, source
  // label, and a CO_NAME safety clause so a mis-routed query can never
  // return another county's parcels.
  coName = "";
  parcelIdField = "PIN";
  ownerField = "OWNER_NAME";
  addressField = "";
  extraOutFields = [
    "ANUMBER",
    "ST_NAME",
    "ST_PRE_TYP",
    "ST_PRE_DIR",
    "ST_POS_TYP",
    "ST_POS_DIR",
    "CTU_NAME",
    "ZIP",
  ];
  adjacentSpatialRel = "esriSpatialRelIntersects";

  async _queryCounty(params, budget) {
    if (this.coName) {
      params = { ...params };
      const where = params.where || "1=1";
      params.where = `(${where}) AND CO_NAME = '${this._sqlEscape(this.coName)}'`;
    }
    return super._queryCounty(params, budget);
  }

  _getAddressWhereExact(cleaned) {
    const houseNo = this._extractHouseNumber(cleaned);
    const streetToken = this._extractStreetToken(cleaned);
    if (streetToken === null && houseNo === null) return "1=0";
    const clauses = [];
    if (houseNo !== null) clauses.push(`ANUMBER = ${houseNo}`);
    clauses.push(`UPPER(ST_NAME) LIKE '%${this._sqlEscape(streetToken)}%'`);
    return clauses.join(" AND ");
  }

  _getAddressWhereContains(cleaned) {
    const streetToken = this._extractStreetToken(cleaned);
    if (!streetToken) return "1=0";
    return `UPPER(ST_NAME) LIKE '%${this._sqlEscape(streetToken)}%'`;
  }

  _buildAddress(attrs) {
    const number = this._formatInt(attrs.ANUMBER);
    const streetName = String(attrs.ST_NAME ?? "").trim();
    const posType = String(attrs.ST_POS_TYP ?? "").trim();
    const posDir = String(attrs.ST_POS_DIR ?? "").trim();
    const city = String(attrs.CTU_NAME ?? "").trim();
    const zip = String(attrs.ZIP ?? "").trim();

    const parts = [];
    if (number) parts.push(number);
    if (streetName) parts.push(streetName);
    if (posType) parts.push(posType);
    if (posDir) parts.push(posDir);
    const streetLine = parts.join(" ");

    const suffixParts = [];
    suffixParts.push(city || "MN");
    if (zip) suffixParts.push(zip);
    const suffix = suffixParts.join(" ");

    if (streetLine && suffix) return `${streetLine}, ${suffix}`;
    return streetLine || suffix;
  }

  _formatInt(value) {
    if (value === null || value === undefined) return "";
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return String(value).trim();
    return n > 0 ? String(n) : "";
  }

  _extractHouseNumber(address) {
    const firstPart = address.split(",")[0].trim();
    const m = firstPart.match(/^(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  _extractStreetToken(address) {
    const withoutHouse = address.replace(/^\s*\d+\S?\s+/, "").trim();
    if (!withoutHouse) return null;
    const first = withoutHouse.split(/\s+/)[0].trim();
    return first || null;
  }
}

export class DakotaProvider extends MnStateSchemaProvider {
  endpointUrl = MN_STATE_PARCELS_FEATURESERVER + "/2/query";
  sourceLabel = "dakota_county_arcgis_state";
  coName = "Dakota";
}

export class WashingtonProvider extends MnStateSchemaProvider {
  endpointUrl = MN_STATE_PARCELS_FEATURESERVER + "/6/query";
  sourceLabel = "washington_county_arcgis_state";
  coName = "Washington";
}

export class CarverProvider extends MnStateSchemaProvider {
  // Verified 2026-08-21: OWNER_NAME is 100% null in the Carver layer, while
  // TAX_NAME (the taxpayer name) is populated for 47,585 of 47,886 parcels.
  ownerField = "TAX_NAME";
  endpointUrl = MN_STATE_PARCELS_FEATURESERVER + "/1/query";
  sourceLabel = "carver_county_arcgis_state";
  coName = "Carver";
}
