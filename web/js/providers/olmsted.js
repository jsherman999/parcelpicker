// Port of backend/services/olmsted.py
import { BaseParcelProvider, DIRECTIONALS } from "./base.js";

export class OlmstedProvider extends BaseParcelProvider {
  endpointUrl =
    "https://public.gis.olmstedcounty.gov/arcgis/rest/services/" +
    "Parcels_Addressing/MapServer/3/query";
  sourceLabel = "olmsted_county_arcgis";
  parcelIdField = "PIN";
  ownerField = "OwnerName1";
  // No single street field: the address is component fields, so the base
  // where builders are replaced (see below) and addressField stays empty.
  addressField = "";
  extraOutFields = [
    "OwnerName2",
    "SiteAddrNo",
    "SiteStName",
    "SiteStType",
    "SitePostDir",
    "SiteCity",
    "SiteZip5",
  ];
  adjacentSpatialRel = "esriSpatialRelIntersects";

  _getAddressWhereExact(cleaned) {
    const [houseNo, streetToken] = this._houseAndStreet(cleaned);
    if (houseNo && streetToken) {
      const streetClause = /^\d+$/.test(streetToken)
        ? `SiteStName = '${this._sqlEscape(streetToken)}'`
        : `UPPER(SiteStName) LIKE '%${this._sqlEscape(streetToken)}%'`;
      return `SiteAddrNo = '${this._sqlEscape(houseNo)}' AND ${streetClause}`;
    }
    if (streetToken) {
      return `UPPER(SiteStName) LIKE '%${this._sqlEscape(streetToken)}%'`;
    }
    return "1=0";
  }

  _getAddressWhereContains(cleaned) {
    const [, streetToken] = this._houseAndStreet(cleaned);
    if (!streetToken) return "1=0";
    return `UPPER(SiteStName) LIKE '%${this._sqlEscape(streetToken)}%'`;
  }

  _houseAndStreet(address) {
    address = address.replace(/\s*,\s*/g, " ");
    const stripped = address.replace(/\s+MN\s+\d{5}(?:-\d{4})?$/i, "").trim();
    const tokens = stripped.split(/\s+/).filter(Boolean);
    if (!tokens.length || !/^\d+$/.test(tokens[0])) return ["", null];
    const houseNo = tokens[0];
    let streetToken = null;
    for (const tok of tokens.slice(1)) {
      if (!DIRECTIONALS.has(tok.toUpperCase())) {
        streetToken = tok;
        break;
      }
    }
    if (streetToken) {
      // "19TH" -> "19": street names are stored without ordinal suffixes.
      streetToken = streetToken.replace(/(\d+)(?:ST|ND|RD|TH)$/, "$1");
    }
    return [houseNo, streetToken];
  }

  _featureToRecord(feature, matchedBy) {
    const record = super._featureToRecord(feature, matchedBy);
    const attrs = feature.attributes || {};
    const secondOwner = String(attrs.OwnerName2 ?? "").trim();
    if (record.owner_name && secondOwner) {
      record.owner_name = `${record.owner_name} & ${secondOwner}`;
    }
    return record;
  }

  _buildAddress(attrs) {
    const parts = ["SiteAddrNo", "SiteStName", "SiteStType", "SitePostDir"].map(
      (f) => String(attrs[f] ?? "").trim()
    );
    const street = parts.filter(Boolean).join(" ");
    const city = String(attrs.SiteCity ?? "").trim();
    const zip = String(attrs.SiteZip5 ?? "").trim();

    const suffixParts = [];
    suffixParts.push(city || "MN");
    if (zip) suffixParts.push(zip);
    const suffix = suffixParts.join(" ");

    if (street && suffix) return `${street}, ${suffix}`;
    return street || suffix;
  }
}
