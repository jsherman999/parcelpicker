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
import { BlueEarthProvider } from "./blueearth.js";
import {
  DakotaProvider,
  WashingtonProvider,
  CarverProvider,
} from "./mn_state.js";
import { SpecParcelProvider } from "./spec.js";

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
  blueearth: BlueEarthProvider,
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
  blueearth: "Blue Earth County",
  dakota: "Dakota County",
  washington: "Washington County",
  carver: "Carver County",
};

// Counties without a hand-written provider, served by SpecParcelProvider from
// adapter specs in ErisData (https://github.com/Eriskii/ErisData, CC-BY-4.0,
// by Eriskii), subset and live-verified into web/mn_parcel_specs.json.
// If the bundle can't load, the app still runs with the counties above.
async function loadSpecCounties() {
  try {
    const res = await fetch(new URL("../../mn_parcel_specs.json", import.meta.url));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bundle = await res.json();
    return Object.fromEntries(
      Object.entries(bundle.counties || {}).filter(([id]) => !COUNTY_CLASSES[id])
    );
  } catch (err) {
    console.warn("Spec county bundle failed to load:", err);
    return {};
  }
}

export const SPEC_COUNTIES = await loadSpecCounties();

for (const [id, spec] of Object.entries(SPEC_COUNTIES)) {
  COUNTY_LABELS[id] = spec.label;
}

export function createService(county, options = {}) {
  const Cls = COUNTY_CLASSES[county];
  if (Cls) return new Cls(options);
  const spec = SPEC_COUNTIES[county];
  if (spec) return new SpecParcelProvider(spec, options);
  throw new Error(
    `Unknown county: ${county}. Options: ${Object.keys(COUNTY_LABELS).join(", ")}`
  );
}
