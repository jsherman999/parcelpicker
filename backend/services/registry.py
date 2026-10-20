from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from backend.services.base import BaseParcelProvider
from backend.services.wright import WrightParcelProvider
from backend.services.hennepin import HennepinParcelProvider
from backend.services.stlouis import StLouisParcelProvider
from backend.services.sherburne import SherburneParcelProvider
from backend.services.anoka import AnokaParcelProvider
from backend.services.ramsey import RamseyParcelProvider
from backend.services.olmsted import OlmstedParcelProvider
from backend.services.chisago import ChisagoParcelProvider
from backend.services.morrison import MorrisonParcelProvider
from backend.services.scott import ScottParcelProvider
from backend.services.aitkin import AitkinParcelProvider
from backend.services.koochiching import KoochichingParcelProvider
from backend.services.beltrami import BeltramiParcelProvider
from backend.services.mn_state import (
    DakotaParcelProvider,
    WashingtonParcelProvider,
    CarverParcelProvider,
)


@dataclass(frozen=True, slots=True)
class County:
    label: str
    provider: type[BaseParcelProvider]


# One record per supported county, keyed by the county id that parcels,
# runs and address aliases carry.
COUNTIES: dict[str, County] = {
    "wright": County("Wright County", WrightParcelProvider),
    "hennepin": County("Hennepin County", HennepinParcelProvider),
    "stlouis": County("St. Louis County", StLouisParcelProvider),
    "sherburne": County("Sherburne County", SherburneParcelProvider),
    "anoka": County("Anoka County", AnokaParcelProvider),
    "ramsey": County("Ramsey County", RamseyParcelProvider),
    "olmsted": County("Olmsted County", OlmstedParcelProvider),
    "chisago": County("Chisago County", ChisagoParcelProvider),
    "morrison": County("Morrison County", MorrisonParcelProvider),
    "scott": County("Scott County", ScottParcelProvider),
    "aitkin": County("Aitkin County", AitkinParcelProvider),
    "koochiching": County("Koochiching County", KoochichingParcelProvider),
    "beltrami": County("Beltrami County", BeltramiParcelProvider),
    "dakota": County("Dakota County", DakotaParcelProvider),
    "washington": County("Washington County", WashingtonParcelProvider),
    "carver": County("Carver County", CarverParcelProvider),
}


def create_provider(county: str, **kwargs: Any) -> BaseParcelProvider:
    record = COUNTIES.get(county)
    if record is None:
        raise ValueError(f"Unknown county: {county}. Options: {list(COUNTIES)}")
    return record.provider(county=county, **kwargs)
