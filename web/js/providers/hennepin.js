// Port of backend/services/hennepin.py
import { BaseParcelProvider } from "./base.js";

const HENNEPIN_PARCEL_URL =
  "https://gis.hennepin.us/arcgis/rest/services/" +
  "HennepinData/LAND_PROPERTY/MapServer/1/query";
const HENNEPIN_ADDRESS_POINTS_URL =
  "https://gis.hennepin.us/arcgis/rest/services/" +
  "HennepinData/LAND_PROPERTY/MapServer/0/query";

export class HennepinProvider extends BaseParcelProvider {
  endpointUrl = HENNEPIN_PARCEL_URL;
  sourceLabel = "hennepin_county_arcgis";
  parcelIdField = "PID";
  ownerField = "OWNER_NM";
  addressField = "";
  extraOutFields = ["HOUSE_NO", "FRAC_HOUSE_NO", "STREET_NM", "MAILING_MUNIC_NM", "ZIP_CD"];

  _getOutfields() {
    return [this.parcelIdField, this.ownerField, ...this.extraOutFields].join(",");
  }

  _buildAddress(attrs) {
    const houseNo = attrs.HOUSE_NO;
    const fracNo = String(attrs.FRAC_HOUSE_NO ?? "").trim();
    const streetNm = String(attrs.STREET_NM ?? "").trim();
    const city = String(attrs.MAILING_MUNIC_NM ?? "").trim();
    const zip = String(attrs.ZIP_CD ?? "").trim();

    const numberParts = [];
    if (houseNo !== null && houseNo !== undefined && parseInt(houseNo, 10) !== 0) {
      numberParts.push(String(parseInt(houseNo, 10)));
    }
    if (fracNo) numberParts.push(fracNo);

    const number = numberParts.join(" ");
    const streetLine = number ? `${number} ${streetNm}`.trim() : streetNm;

    const suffixParts = [];
    if (city) suffixParts.push(city);
    suffixParts.push("MN");
    if (zip) suffixParts.push(zip);
    const suffix = suffixParts.join(" ");

    if (streetLine && suffix) return `${streetLine}, ${suffix}`;
    return streetLine || suffix;
  }

  async _queryByAddress(cleaned, budget) {
    const fromPoints = await this._queryAddressPoints(cleaned, budget);
    if (fromPoints) return fromPoints;
    return this._queryParcelsByAddress(cleaned, budget);
  }

  async _queryAddressPoints(cleaned, budget) {
    const tryWhere = async (where) => {
      const features = await this._queryUrl(
        HENNEPIN_ADDRESS_POINTS_URL,
        { where, outFields: "PID,CONCAT_AD", returnGeometry: "false", outSR: "4326" },
        budget
      );
      const match = this._firstFeatureWithPid(features);
      if (match) {
        const pid = String(match.attributes?.PID ?? "").trim();
        if (pid) return this._queryParcelByPid(pid, budget);
      }
      return null;
    };

    const exact = await tryWhere(`UPPER(CONCAT_AD) = '${this._sqlEscape(cleaned)}'`);
    if (exact) return exact;
    return tryWhere(`UPPER(CONCAT_AD) LIKE '%${this._sqlEscape(cleaned)}%'`);
  }

  async _queryParcelsByAddress(cleaned, budget) {
    const street = this._extractStreetPart(cleaned);
    if (!street) return null;

    let features = await this._queryCounty(
      {
        where: `UPPER(STREET_NM) LIKE '%${this._sqlEscape(street)}%'`,
        outFields: this._getOutfields(),
        returnGeometry: "true",
        outSR: "4326",
      },
      budget
    );

    const houseNo = this._extractHouseNumber(cleaned);
    if (houseNo) {
      features = features.filter(
        (f) => parseInt(f.attributes?.HOUSE_NO ?? 0, 10) === houseNo
      );
    }
    return this._firstFeatureWithPid(features);
  }

  async _queryParcelByPid(pid, budget) {
    const features = await this._queryCounty(
      {
        where: `PID = '${this._sqlEscape(pid)}'`,
        outFields: this._getOutfields(),
        returnGeometry: "true",
        outSR: "4326",
      },
      budget
    );
    return this._firstFeatureWithPid(features);
  }

  _extractStreetPart(address) {
    let street = address.includes(",") ? address.split(",", 1)[0].trim() : address;
    street = street.replace(/^\d+\S?\s+/, "").trim();
    return street || null;
  }

  _extractHouseNumber(address) {
    const firstPart = address.split(",", 1)[0].trim();
    const match = firstPart.match(/^(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  }
}
