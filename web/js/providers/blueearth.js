// Blue Earth County (Mankato). The county's TaxParcelsWGS84 layer joins the
// parcel fabric to its Ownership table, so every field name is
// table-qualified ("Ownership.OWNNAME"). The qualified names work in WHERE
// and outFields and come back as the attribute keys. (ErisData's spec points
// at LandRecords/TaxParcels, whose "Name" field is the parcel number, not the
// owner.)
import { BaseParcelProvider, streetPrefix } from "./base.js";
import { MATCHED_BY } from "../model.js";

const ADDRESS_POINTS_URL =
  "https://gis.blueearthcountymn.gov/server/rest/services/" +
  "LandRecords/AddressPoints/MapServer/0/query";

const CITY_FIELD = "Ownership.PHYSCITY";
const ZIP_FIELD = "Ownership.PHYSZIP";

const POINT_FIELDS = { address: "Address", towns: ["POSTCOMM", "CTU_NAME"], zip: "ZIP" };
const PARCEL_FIELDS = { address: "Ownership.PHYSADDR", towns: [CITY_FIELD], zip: ZIP_FIELD };

// Uppercase, drop periods and commas, collapse spaces, and spell "SAINT" as
// "ST" ("Saint Clair" / "ST. CLAIR" -> "ST CLAIR").
function normalizePlace(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[.,]/g, " ")
    .replace(/\bSAINT\b/g, "ST")
    .replace(/\s+/g, " ")
    .trim();
}

// Choose among street-prefix matches using the rest of the input. Some
// street addresses recur across the county's towns ("101 E MAIN ST" is in
// Mankato, St. Clair and Vernon Center). A match is kept when the typed town
// or ZIP is its own, or when the input has no ZIP and no word outside its
// address. Among kept matches, a town or ZIP match wins, then one whose whole
// street line starts the input ("600 S COUNTY RD 20" over "600 S COUNTY RD 2").
function pickAddressMatch(features, input, street, fields) {
  const zip = (input.match(/ (\d{5})(?:-\d{4})?$/) || [])[1] || "";
  const core = input.replace(/(?: MN| MINNESOTA)?(?: \d{5}(?:-\d{4})?)?$/, "");
  const rest = ` ${core.slice(street.length)} `;
  let best = null;
  let bestScore = -1;
  for (const feature of features) {
    const attrs = feature.attributes || {};
    const address = normalizePlace(attrs[fields.address]);
    if (!address) continue;
    const words = new Set(address.split(" "));
    const townMatch =
      (zip && String(attrs[fields.zip] ?? "").trim() === zip) ||
      fields.towns.some((f) => {
        const town = normalizePlace(attrs[f]);
        return town && rest.includes(` ${town} `);
      });
    const extraWord = core.split(" ").some((w) => /[A-Z]/.test(w) && !words.has(w));
    if (!townMatch && (zip || extraWord)) continue;
    const score = (townMatch ? 2 : 0) + (`${core} `.startsWith(`${address} `) ? 1 : 0);
    if (score > bestScore) {
      best = feature;
      bestScore = score;
    }
  }
  return best;
}

export class BlueEarthProvider extends BaseParcelProvider {
  endpointUrl =
    "https://gis.blueearthcountymn.gov/server/rest/services/" +
    "LandRecords/TaxParcelsWGS84/MapServer/0/query";
  sourceId = "blueearth_county_arcgis";
  parcelIdField = "SDEDATA.TaxParcel.ParcelNo";
  ownerField = "Ownership.OWNNAME";
  addressField = "Ownership.PHYSADDR";
  extraOutFields = [CITY_FIELD, ZIP_FIELD];
  valueField = "Ownership.ESTTOTVAL";
  // Assessment year (2025 next to TPYEAR, the taxes-payable year, 2026).
  valueYearField = "Ownership.TAXINFOYEAR";
  adjacentSpatialRel = "esriSpatialRelIntersects";
  // GET URLs past ~9,000 chars get HTTP 414 (rural parcels run to 1,000+
  // vertices). A form POST works and carries the CORS header.
  postLongQueries = true;

  // The join layer has no pagination, so it rejects resultRecordCount
  // ("Pagination is not supported"). Apply the adjacency limit here instead.
  async _queryCounty(params, budget) {
    const { resultRecordCount, ...rest } = params;
    const features = await super._queryCounty(rest, budget);
    return resultRecordCount ? features.slice(0, Number(resultRecordCount)) : features;
  }

  // Addresses resolve through the county's address points first, then the
  // parcel site address (PHYSADDR, street line only, space-padded). If both
  // miss, lookup() falls back to the geocoder + point intersect.
  async _queryByAddress(cleaned, budget) {
    const input = normalizePlace(cleaned);
    const street = streetPrefix(input);
    if (!street) return null;
    const like = `LIKE '${this._sqlEscape(street)}%'`;

    // About 0.2 s. A point is placed on its parcel for ~98% of addresses.
    const points = await this._queryUrl(
      ADDRESS_POINTS_URL,
      {
        where: `UPPER(Address) ${like}`,
        outFields: "Address,POSTCOMM,CTU_NAME,ZIP",
        returnGeometry: "true",
        outSR: "4326",
      },
      budget
    );
    const point = pickAddressMatch(points, input, street, POINT_FIELDS);
    if (point && point.geometry) {
      const parcel = await this._queryByPoint(point.geometry.x, point.geometry.y, budget);
      if (parcel && String(parcel.attributes?.[this.ownerField] ?? "").trim()) {
        parcel.matchedBy = MATCHED_BY.ADDRESS_POINT;
        return parcel;
      }
    }

    // About 10 s: filters on the joined Ownership fields aren't indexed.
    const parcels = await this._queryCounty(
      {
        where: `UPPER(${this.addressField}) ${like}`,
        outFields: this._getOutfields(),
        returnGeometry: "true",
        outSR: "4326",
      },
      budget
    );
    const withPid = parcels.filter((f) =>
      String(f.attributes?.[this.parcelIdField] ?? "").trim()
    );
    return pickAddressMatch(withPid, input, street, PARCEL_FIELDS);
  }

  _buildAddress(attrs) {
    const street = String(attrs[this.addressField] ?? "").trim();
    if (!street) return "";
    const city = String(attrs[CITY_FIELD] ?? "").trim();
    const zip = String(attrs[ZIP_FIELD] ?? "").trim();
    const suffix = [city, zip].filter(Boolean).join(" ");
    return suffix ? `${street}, ${suffix}` : street;
  }
}
