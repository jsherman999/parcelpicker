// Port of backend/services/wright.py
import { BaseParcelProvider } from "./base.js";

export class WrightProvider extends BaseParcelProvider {
  endpointUrl =
    "https://services2.arcgis.com/CiQCvRGImIxsaFnM/arcgis/rest/services/" +
    "Parcel_Data/FeatureServer/0/query";
  sourceId = "wright_county_arcgis";
  parcelIdField = "PID";
  ownerField = "OWNNAME";
  valueField = "EMV";
  valueYearField = "ASMT_YR";
  landUseField = "TPCLS1_DSC";
  addressField = "PHYSADDR";
  adjacentSpatialRel = "esriSpatialRelIntersects";
}
