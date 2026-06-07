from __future__ import annotations

from typing import Any

from backend.services.base import BaseParcelService
from backend.services.wright import WrightParcelService
from backend.services.hennepin import HennepinParcelService
from backend.services.stlouis import StLouisParcelService
from backend.services.sherburne import SherburneParcelService
from backend.services.anoka import AnokaParcelService


COUNTY_CLASSES: dict[str, type[BaseParcelService]] = {
    "wright": WrightParcelService,
    "hennepin": HennepinParcelService,
    "stlouis": StLouisParcelService,
    "sherburne": SherburneParcelService,
    "anoka": AnokaParcelService,
}

COUNTY_LABELS: dict[str, str] = {
    "wright": "Wright County",
    "hennepin": "Hennepin County",
    "stlouis": "St. Louis County",
    "sherburne": "Sherburne County",
    "anoka": "Anoka County",
}


def create_service(county: str, **kwargs: Any) -> BaseParcelService:
    cls = COUNTY_CLASSES.get(county)
    if cls is None:
        raise ValueError(f"Unknown county: {county}. Options: {list(COUNTY_CLASSES.keys())}")
    return cls(**kwargs)
