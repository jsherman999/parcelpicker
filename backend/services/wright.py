from __future__ import annotations

from backend.services.base import BaseParcelService


WRIGHT_QUERY_URL = (
    "https://services2.arcgis.com/CiQCvRGImIxsaFnM/arcgis/rest/services/"
    "Parcel_Data/FeatureServer/0/query"
)


class WrightParcelService(BaseParcelService):

    endpoint_url = WRIGHT_QUERY_URL
    source_label = "wright_county_arcgis"
    parcel_id_field = "PID"
    owner_field = "OWNNAME"
    address_field = "PHYSADDR"
