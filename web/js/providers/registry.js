// Port of backend/services/registry.py
import { WrightProvider } from "./wright.js";
import { HennepinProvider } from "./hennepin.js";
import { StLouisProvider } from "./stlouis.js";
import { SherburneProvider } from "./sherburne.js";
import { AnokaProvider } from "./anoka.js";

export const COUNTY_CLASSES = {
  wright: WrightProvider,
  hennepin: HennepinProvider,
  stlouis: StLouisProvider,
  sherburne: SherburneProvider,
  anoka: AnokaProvider,
};

export const COUNTY_LABELS = {
  wright: "Wright County",
  hennepin: "Hennepin County",
  stlouis: "St. Louis County",
  sherburne: "Sherburne County",
  anoka: "Anoka County",
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
