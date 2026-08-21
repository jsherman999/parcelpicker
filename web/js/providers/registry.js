// Port of backend/services/registry.py
import { WrightProvider } from "./wright.js";
import { HennepinProvider } from "./hennepin.js";
import { StLouisProvider } from "./stlouis.js";
import { SherburneProvider } from "./sherburne.js";
import { AnokaProvider } from "./anoka.js";
import { RamseyProvider } from "./ramsey.js";
import { OlmstedProvider } from "./olmsted.js";
import { ChisagoProvider } from "./chisago.js";
import { MorrisonProvider } from "./morrison.js";
import { ScottProvider } from "./scott.js";
import { AitkinProvider } from "./aitkin.js";
import { KoochichingProvider } from "./koochiching.js";
import { BeltramiProvider } from "./beltrami.js";
import {
  DakotaProvider,
  WashingtonProvider,
  CarverProvider,
} from "./mn_state.js";

export const COUNTY_CLASSES = {
  wright: WrightProvider,
  hennepin: HennepinProvider,
  stlouis: StLouisProvider,
  sherburne: SherburneProvider,
  anoka: AnokaProvider,
  ramsey: RamseyProvider,
  olmsted: OlmstedProvider,
  chisago: ChisagoProvider,
  morrison: MorrisonProvider,
  scott: ScottProvider,
  aitkin: AitkinProvider,
  koochiching: KoochichingProvider,
  beltrami: BeltramiProvider,
  dakota: DakotaProvider,
  washington: WashingtonProvider,
  carver: CarverProvider,
};

export const COUNTY_LABELS = {
  wright: "Wright County",
  hennepin: "Hennepin County",
  stlouis: "St. Louis County",
  sherburne: "Sherburne County",
  anoka: "Anoka County",
  ramsey: "Ramsey County",
  olmsted: "Olmsted County",
  chisago: "Chisago County",
  morrison: "Morrison County",
  scott: "Scott County",
  aitkin: "Aitkin County",
  koochiching: "Koochiching County",
  beltrami: "Beltrami County",
  dakota: "Dakota County",
  washington: "Washington County",
  carver: "Carver County",
};

export function createService(county, options = {}) {
  const Cls = COUNTY_CLASSES[county];
  if (!Cls) {
    throw new Error(
      `Unknown county: ${county}. Options: ${Object.keys(COUNTY_CLASSES).join(", ")}`
    );
  }
  return new Cls(options);
}
