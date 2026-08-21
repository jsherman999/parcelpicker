from __future__ import annotations

from typing import Any

from backend.services.base import BaseParcelService
from backend.services.wright import WrightParcelService
from backend.services.hennepin import HennepinParcelService
from backend.services.stlouis import StLouisParcelService
from backend.services.sherburne import SherburneParcelService
from backend.services.anoka import AnokaParcelService
from backend.services.ramsey import RamseyParcelService
from backend.services.olmsted import OlmstedParcelService
from backend.services.chisago import ChisagoParcelService
from backend.services.morrison import MorrisonParcelService
from backend.services.scott import ScottParcelService
from backend.services.aitkin import AitkinParcelService
from backend.services.koochiching import KoochichingParcelService
from backend.services.beltrami import BeltramiParcelService
from backend.services.mn_state import (
    DakotaParcelService,
    WashingtonParcelService,
    CarverParcelService,
)


COUNTY_CLASSES: dict[str, type[BaseParcelService]] = {
    "wright": WrightParcelService,
    "hennepin": HennepinParcelService,
    "stlouis": StLouisParcelService,
    "sherburne": SherburneParcelService,
    "anoka": AnokaParcelService,
    "ramsey": RamseyParcelService,
    "olmsted": OlmstedParcelService,
    "chisago": ChisagoParcelService,
    "morrison": MorrisonParcelService,
    "scott": ScottParcelService,
    "aitkin": AitkinParcelService,
    "koochiching": KoochichingParcelService,
    "beltrami": BeltramiParcelService,
    "dakota": DakotaParcelService,
    "washington": WashingtonParcelService,
    "carver": CarverParcelService,
}

COUNTY_LABELS: dict[str, str] = {
    "wright": "Wright County",
    "hennepin": "Hennepin County",
    "stlouis": "St. Louis County",
    "sherburne": "Sherburne County",
    "anoka": "Anoka County",
    "ramsey": "Ramsey County",
    "olmsted": "Olmsted County",
    "chisago": "Chisago County",
    "morrison": "Morrison County",
    "scott": "Scott County",
    "aitkin": "Aitkin County",
    "koochiching": "Koochiching County",
    "beltrami": "Beltrami County",
    "dakota": "Dakota County",
    "washington": "Washington County",
    "carver": "Carver County",
}


def create_service(county: str, **kwargs: Any) -> BaseParcelService:
    cls = COUNTY_CLASSES.get(county)
    if cls is None:
        raise ValueError(f"Unknown county: {county}. Options: {list(COUNTY_CLASSES.keys())}")
    return cls(**kwargs)
