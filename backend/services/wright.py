from __future__ import annotations

from backend.services.base import BaseParcelService


WRIGHT_QUERY_URL = (
    "https://web.co.wright.mn.us/arcgisserver/rest/services/"
    "Wright_County_Parcels/MapServer/1/query"
)


class WrightParcelService(BaseParcelService):

    endpoint_url = WRIGHT_QUERY_URL
    source_label = "wright_county_arcgis"
    parcel_id_field = "PID"
    owner_field = "OWNNAME"
    address_field = "PHYSADDR"
