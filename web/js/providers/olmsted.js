// Port of backend/services/olmsted.py
import { BaseParcelProvider, DIRECTIONALS } from "./base.js";

const OLMSTED_BASE_URL =
  "https://public.gis.olmstedcounty.gov/arcgis/rest/services/Parcels_Addressing/MapServer";

// Input street-type spellings -> the abbreviation stored in SiteStType/ST_TYPE.
const STREET_TYPES = {
  AVE: "AVE", AV: "AVE", AVENUE: "AVE",
  BLVD: "BLVD", BOULEVARD: "BLVD",
  CIR: "CIR", CIRCLE: "CIR",
  CT: "CT", COURT: "CT",
  DR: "DR", DRIVE: "DR",
  HWY: "HWY", HIGHWAY: "HWY",
  LN: "LN", LANE: "LN",
  PKWY: "PKWY", PARKWAY: "PKWY",
  PL: "PL", PLACE: "PL",
  RD: "RD", ROAD: "RD",
  ST: "ST", STREET: "ST",
  TRL: "TRL", TRAIL: "TRL",
  WAY: "WAY",
};
const streetType = (tok) => (Object.hasOwn(STREET_TYPES, tok) ? STREET_TYPES[tok] : "");

// Route prefixes written before a route number ("COUNTY RD 19", "HWY 14"),
// longest spelling first. The layers keep the prefix in SitePreTyp/PRE_TYPE
// and only the number in SiteStName/ST_NAME.
const ROUTE_PREFIXES = [
  ["COUNTY ROAD", "COUNTY"], ["COUNTY RD", "COUNTY"], ["CO ROAD", "COUNTY"],
  ["CO RD", "COUNTY"], ["COUNTY HIGHWAY", "COUNTY"], ["COUNTY HWY", "COUNTY"],
  ["CO HWY", "COUNTY"], ["CSAH", "COUNTY"], ["CR", "COUNTY"], ["COUNTY", "COUNTY"],
  ["US HIGHWAY", "HWY"], ["US HWY", "HWY"], ["STATE HIGHWAY", "HWY"],
  ["STATE HWY", "HWY"], ["MN HWY", "HWY"], ["HIGHWAY", "HWY"], ["HWY", "HWY"],
  ["US", "HWY"], ["TH", "HWY"],
  ["INTERSTATE", "I"], ["I", "I"],
].map(([spelling, kind]) => [spelling.split(" "), kind]);

// Address component fields of the parcel layer (3) and the E911 address
// point layer (0).
const PARCEL_FIELDS = {
  houseNo: "SiteAddrNo", preDir: "SitePreDir", preType: "SitePreTyp",
  name: "SiteStName", type: "SiteStType", postDir: "SitePostDir",
  city: "SiteCity", zip: "SiteZip5",
};
const E911_FIELDS = {
  houseNo: "ADDNO", preDir: "PRE_DIR", preType: "PRE_TYPE",
  name: "ST_NAME", type: "ST_TYPE", postDir: "POST_DIR",
  city: "CITY", zip: "ZIP5",
};

export class OlmstedProvider extends BaseParcelProvider {
  endpointUrl = `${OLMSTED_BASE_URL}/3/query`;
  e911Url = `${OLMSTED_BASE_URL}/0/query`;
  sourceLabel = "olmsted_county_arcgis";
  parcelIdField = "PIN";
  ownerField = "OwnerName1";
  valueField = "EMVTotal";
  landUseField = "LandUseDes";
  // No single street field: the address is component fields, so the base
  // where builders are replaced (see below) and addressField stays empty.
  addressField = "";
  extraOutFields = [
    "OwnerName2",
    "SiteAddrNo",
    "SitePreDir",
    "SitePreTyp",
    "SiteStName",
    "SiteStType",
    "SitePostDir",
    "SiteCity",
    "SiteZip5",
  ];
  adjacentSpatialRel = "esriSpatialRelIntersects";

  // Parcel site address (exact, then loose), then the E911 address point.
  // The parsed input keeps its city and ZIP, so the base class's street-line
  // retry is skipped: it would drop them and match the same street number in
  // another town.
  async _queryByAddress(cleaned, budget) {
    if (!this._parseAddress(cleaned)) return null;
    for (const where of new Set([
      this._getAddressWhereExact(cleaned),
      this._getAddressWhereContains(cleaned),
    ])) {
      const features = await this._queryCounty(
        {
          where,
          outFields: this._getOutfields(),
          returnGeometry: "true",
          outSR: "4326",
        },
        budget
      );
      const feature = this._firstFeatureWithPid(features);
      if (feature) return feature;
    }
    return this._queryByE911Point(cleaned, budget);
  }

  // Many addresses (e.g. Mayo Clinic's 200 1st St SW) are E911 points on a
  // parcel whose site address is a different one, so look the point up and
  // take the parcel under it.
  async _queryByE911Point(cleaned, budget) {
    const where = this._addressWhere(this._parseAddress(cleaned), E911_FIELDS, false);
    const points = await this._queryUrl(
      this.e911Url,
      { where, outFields: "ADDRESS_ID", returnGeometry: "true", outSR: "4326" },
      budget
    );
    const point = points.find((f) => f.geometry && "x" in f.geometry);
    if (!point) return null;
    const feature = await this._queryByPoint(point.geometry.x, point.geometry.y, budget);
    if (feature) feature.matchedBy = "e911_point_intersect";
    return feature;
  }

  _getAddressWhereExact(cleaned) {
    return this._addressWhere(this._parseAddress(cleaned), PARCEL_FIELDS, false);
  }

  _getAddressWhereContains(cleaned) {
    return this._addressWhere(this._parseAddress(cleaned), PARCEL_FIELDS, true);
  }

  // The house number, post-directional, city/ZIP and route kind always apply
  // when the input has them. Exact also pins the pre-directional, street type
  // and full name; loose drops those and matches the name by its first word.
  _addressWhere(parsed, fields, loose) {
    if (!parsed) return "1=0";
    const q = (v) => `'${this._sqlEscape(v)}'`;
    const clauses = [`${fields.houseNo} = ${q(parsed.houseNo)}`];

    if (loose && !/^\d+$/.test(parsed.name)) {
      clauses.push(`UPPER(${fields.name}) LIKE ${q(`%${parsed.name.split(" ")[0]}%`)}`);
    } else {
      clauses.push(`UPPER(${fields.name}) = ${q(parsed.name)}`);
    }

    if (parsed.routeKind === "COUNTY") {
      clauses.push(`${fields.preType} LIKE 'COUNTY%'`);
    } else if (parsed.routeKind === "HWY") {
      clauses.push(`(${fields.preType} = 'HWY' OR ${fields.type} = 'HWY')`);
    } else if (parsed.routeKind === "I") {
      clauses.push(`${fields.preType} = 'I'`);
    } else if (parsed.type) {
      // "19th St SE" is a different road from "County Rd 19 SE". COALESCE
      // because the county's firewall rejects "IS NULL" from browsers.
      if (loose) clauses.push(`COALESCE(${fields.preType}, '') = ''`);
      else clauses.push(`${fields.type} = ${q(parsed.type)}`);
    }

    if (parsed.preDir && !loose) clauses.push(`${fields.preDir} = ${q(parsed.preDir)}`);
    if (parsed.postDir) clauses.push(`${fields.postDir} = ${q(parsed.postDir)}`);

    // City or ZIP: either may be off (Mayo Clinic's own 55905 vs the street's
    // 55902; a township name instead of the postal city).
    const locality = [];
    if (parsed.city) locality.push(`UPPER(${fields.city}) = ${q(parsed.city)}`);
    if (parsed.zip) locality.push(`${fields.zip} = ${q(parsed.zip)}`);
    if (locality.length) clauses.push(`(${locality.join(" OR ")})`);

    return clauses.join(" AND ");
  }

  // "200 1ST ST SW ROCHESTER MN 55905" -> {houseNo: "200", name: "1",
  // type: "ST", postDir: "SW", city: "ROCHESTER", zip: "55905"}.
  // "6126 COUNTY RD 19 SE" -> {houseNo: "6126", routeKind: "COUNTY",
  // name: "19", postDir: "SE"}. Null without a house number and street.
  _parseAddress(address) {
    let s = String(address || "")
      .toUpperCase()
      .replace(/[.,]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    let zip = "";
    const zipMatch = s.match(/\s(\d{5})(?:-\d{4})?$/);
    if (zipMatch) {
      zip = zipMatch[1];
      s = s.slice(0, zipMatch.index);
    }
    s = s
      .replace(/\s(?:MN|MINNESOTA)$/, "")
      .replace(/\s(?:(?:APT|UNIT|STE|SUITE)\s+|#\s*)[A-Z0-9-]+\b/, "");

    const tokens = s.split(" ").filter(Boolean);
    if (tokens.length < 2 || !/^\d+$/.test(tokens[0])) return null;
    const parsed = {
      houseNo: tokens[0],
      preDir: "",
      routeKind: "",
      name: "",
      type: "",
      postDir: "",
      city: "",
      zip,
    };
    let i = 1;

    if (
      ["N", "S", "E", "W"].includes(tokens[i]) &&
      i + 1 < tokens.length &&
      !streetType(tokens[i + 1])
    ) {
      parsed.preDir = tokens[i];
      i += 1;
    }

    for (const [spelling, kind] of ROUTE_PREFIXES) {
      const end = i + spelling.length;
      const route = (tokens[end] || "").replace(/^(\d+)(?:ST|ND|RD|TH)$/, "$1");
      if (spelling.every((t, k) => tokens[i + k] === t) && /^\d+$/.test(route)) {
        parsed.routeKind = kind;
        parsed.name = route;
        i = end + 1;
        break;
      }
    }

    if (!parsed.routeKind) {
      if (i >= tokens.length) return null;
      let j = i + 1;
      while (j < tokens.length && !streetType(tokens[j]) && !DIRECTIONALS.has(tokens[j])) {
        j += 1;
      }
      // Without a street type or directional the street/city boundary is
      // unknown: take one word as the street and leave the rest as the city.
      if (j === tokens.length) j = i + 1;
      // "19TH" -> "19": street names are stored without ordinal suffixes.
      parsed.name = tokens
        .slice(i, j)
        .map((t) => t.replace(/^(\d+)(?:ST|ND|RD|TH)$/, "$1"))
        .join(" ");
      i = j;
    }
    // Also after a route number ("COUNTY 137 RD SE"); the route kind then
    // stands in for the type in the WHERE clause.
    if (streetType(tokens[i])) {
      parsed.type = streetType(tokens[i]);
      i += 1;
    }

    if (DIRECTIONALS.has(tokens[i])) {
      parsed.postDir = tokens[i];
      i += 1;
    }
    parsed.city = tokens.slice(i).join(" ").replace(/^SAINT\b/, "ST");
    return parsed;
  }

  _featureToRecord(feature, matchedBy) {
    const record = super._featureToRecord(feature, feature.matchedBy || matchedBy);
    const attrs = feature.attributes || {};
    const secondOwner = String(attrs.OwnerName2 ?? "").trim();
    if (record.owner_name && secondOwner) {
      record.owner_name = `${record.owner_name} & ${secondOwner}`;
    }
    return record;
  }

  _buildAddress(attrs) {
    const parts = [
      "SiteAddrNo",
      "SitePreDir",
      "SitePreTyp",
      "SiteStName",
      "SiteStType",
      "SitePostDir",
    ].map((f) => String(attrs[f] ?? "").trim());
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
