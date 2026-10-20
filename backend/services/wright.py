from __future__ import annotations

from backend.services.base import BaseParcelProvider


WRIGHT_QUERY_URL = (
    "https://services2.arcgis.com/CiQCvRGImIxsaFnM/arcgis/rest/services/"
    "Parcel_Data/FeatureServer/0/query"
)


class WrightParcelProvider(BaseParcelProvider):

    endpoint_url = WRIGHT_QUERY_URL
    source_id = "wright_county_arcgis"
    parcel_id_field = "PID"
    owner_field = "OWNNAME"
    value_field = "EMV"
    value_year_field = "ASMT_YR"
    land_use_field = "TPCLS1_DSC"
    address_field = "PHYSADDR"
    adjacent_spatial_rel = "esriSpatialRelIntersects"
