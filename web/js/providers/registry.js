// The county registry: one record per supported county, holding its
// provider and everything the UI shows for it. Hand-written counties are
// listed here; spec-driven counties come from web/mn_parcel_specs.json.
//
// Record: { id, label, center, zoom, placeholder, propertySearch?, badge?,
//           coverage?, Provider | spec }
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

const HAND_WRITTEN = {
  wright: {
    Provider: WrightProvider,
    label: "Wright County",
    center: [45.2, -93.95],
    zoom: 11,
    placeholder: "Example: 4706 Mayer Ave NE St Michael MN 55376",
    propertySearch: {
      label: "Wright Property Search",
      href: "https://propertyaccess.co.wright.mn.us/search/commonsearch.aspx?mode=combined",
    },
  },
  hennepin: {
    Provider: HennepinProvider,
    label: "Hennepin County",
    center: [44.98, -93.27],
    zoom: 12,
    placeholder: "Example: 1945 Drew Ave S Minneapolis MN 55416",
    propertySearch: {
      label: "Hennepin Property Map",
      href: "https://gis.hennepin.us/property/map/",
    },
  },
  stlouis: {
    Provider: StLouisProvider,
    label: "St. Louis County",
    center: [46.79, -92.1],
    zoom: 10,
    placeholder: "Example: 121 Hawthorne Rd Duluth MN 55812",
    propertySearch: {
      label: "St. Louis County Property",
      href: "https://www.stlouiscountymn.gov/departments-a-z/assessor/property-information",
    },
  },
  sherburne: {
    Provider: SherburneProvider,
    label: "Sherburne County",
    center: [45.45, -93.78],
    zoom: 11,
    placeholder: "Example: 18879 180th Ave NW Big Lake MN 55309",
    propertySearch: {
      label: "Sherburne Property Search",
      href: "https://beacon.schneidercorp.com/Application.aspx?AppID=133&LayerID=1600&PageTypeID=2&PageID=828",
    },
  },
  anoka: {
    Provider: AnokaProvider,
    label: "Anoka County",
    center: [45.27, -93.25],
    zoom: 11,
    placeholder: "Example: 23925 Germanium St NW Saint Francis MN 55070",
    propertySearch: {
      label: "Anoka Property Search",
      href: "https://gis.anokacountymn.gov/propertysearch/",
    },
  },
  ramsey: {
    Provider: RamseyProvider,
    label: "Ramsey County",
    center: [45.02, -93.05],
    zoom: 10,
    placeholder: "Example: 2715 Upper Afton Rd E Maplewood MN 55119",
    propertySearch: {
      label: "Ramsey Open Data",
      href: "https://opendata.ramseycountymn.gov/",
    },
  },
  olmsted: {
    Provider: OlmstedProvider,
    label: "Olmsted County",
    center: [44.01, -92.38],
    zoom: 10,
    placeholder: "Example: 6126 County Rd 19 SE Rochester MN 55904",
    propertySearch: {
      label: "Olmsted County GIS Map",
      href: "https://gweb01.co.olmsted.mn.us/WebApps/OlmstedCountyGISMap/",
    },
  },
  chisago: {
    Provider: ChisagoProvider,
    label: "Chisago County",
    center: [45.6, -93.02],
    zoom: 10,
    placeholder: "Example: 16823 River Rd North Branch MN 55056",
    propertySearch: {
      label: "Chisago Parcel Viewer",
      href: "https://gis.chisagocountymn.gov/Link/WAB/",
    },
  },
  morrison: {
    Provider: MorrisonProvider,
    label: "Morrison County",
    center: [46.06, -94.21],
    zoom: 9,
    placeholder: "Example: 30281 Nature Rd Royalton MN 56373",
    propertySearch: {
      label: "Morrison County Assessor",
      href: "https://morrisoncountymn.gov/government/assessor/",
    },
  },
  scott: {
    Provider: ScottProvider,
    label: "Scott County",
    center: [44.6, -93.78],
    zoom: 10,
    placeholder: "Example: 72 Cedar Lake Ct New Prague MN 56071",
    propertySearch: {
      label: "Scott County Open Data",
      href: "https://open-data-scottcounty.hub.arcgis.com/datasets/parcels/explore",
    },
  },
  aitkin: {
    Provider: AitkinProvider,
    label: "Aitkin County",
    center: [46.72, -93.37],
    zoom: 10,
    placeholder: "Example: 230 S Maddy St McGregor MN 55760",
    propertySearch: {
      label: "Aitkin County GIS",
      href: "https://gisweb.co.aitkin.mn.us/",
    },
  },
  koochiching: {
    Provider: KoochichingProvider,
    label: "Koochiching County",
    center: [48.28, -93.76],
    zoom: 9,
    placeholder: "Example: 12005 Town Road 129 Baudette MN 56623",
    propertySearch: {
      label: "Koochiching County",
      href: "https://koochichingcounty.gov/",
    },
  },
  beltrami: {
    Provider: BeltramiProvider,
    label: "Beltrami County",
    center: [47.465, -94.875],
    zoom: 10,
    placeholder: "Example: 8644 Lumberjack Rd NW Puposky MN 56667",
    propertySearch: {
      label: "Beltrami County Assessor",
      href: "https://beltramicounty.org/assessor/",
    },
  },
  blueearth: {
    Provider: BlueEarthProvider,
    label: "Blue Earth County",
    center: [44.06, -94.07],
    zoom: 10,
    placeholder: "Example: 204 S 5th St Mankato MN 56001",
    propertySearch: {
      label: "Blue Earth Property Information",
      href: "https://beacon.schneidercorp.com/Application.aspx?AppID=387&LayerID=5678&PageTypeID=2&PageID=3065",
    },
  },
  dakota: {
    Provider: DakotaProvider,
    label: "Dakota County",
    center: [44.78, -93.28],
    zoom: 10,
    placeholder: "Example: 4955 Diamond Path Apple Valley MN 55124",
    propertySearch: {
      label: "Dakota County GIS",
      href: "https://gis.co.dakota.mn.us/dcgis/",
    },
  },
  washington: {
    Provider: WashingtonProvider,
    label: "Washington County",
    center: [45.02, -92.88],
    zoom: 9,
    placeholder: "Example: 12001 120th St NE Bayport MN 55003",
    propertySearch: {
      label: "Washington County GIS",
      href: "https://washingtoncountymn.gov/government/departments-a-z/g/gis",
    },
  },
  carver: {
    Provider: CarverProvider,
    label: "Carver County",
    center: [44.82, -93.85],
    zoom: 10,
    placeholder: "Example: 13075 166th St Chanhassen MN 55317",
    propertySearch: {
      label: "Carver County Property Search",
      href: "https://gis.carvercountymn.gov/property/",
    },
  },
};

export const COUNTIES = {};
for (const [id, record] of Object.entries(HAND_WRITTEN)) {
  COUNTIES[id] = { id, ...record };
}

// Counties without a hand-written provider, served by SpecParcelProvider from
// adapter specs in ErisData (https://github.com/Eriskii/ErisData, CC-BY-4.0,
// by Eriskii), subset and live-verified into web/mn_parcel_specs.json. The
// bundle generator precomputed center/zoom from Census county bounds and a
// geocodable example address per county; no county property-search page is
// known for these. If the bundle can't load, the app still runs with the
// counties above.
async function loadSpecCounties() {
  try {
    const res = await fetch(new URL("../../mn_parcel_specs.json", import.meta.url));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bundle = await res.json();
    return Object.values(bundle.counties || {}).filter((spec) => !COUNTIES[spec.id]);
  } catch (err) {
    console.warn("Spec county bundle failed to load:", err);
    return [];
  }
}

for (const spec of await loadSpecCounties()) {
  COUNTIES[spec.id] = {
    id: spec.id,
    label: spec.label,
    center: spec.center,
    zoom: spec.zoom,
    placeholder: spec.placeholder,
    badge: spec.badge || "",
    coverage: spec.coverage || "",
    spec,
  };
}

export function createProvider(county, options = {}) {
  const record = COUNTIES[county];
  if (!record) {
    throw new Error(`Unknown county: ${county}. Options: ${Object.keys(COUNTIES).join(", ")}`);
  }
  return record.spec
    ? new SpecParcelProvider(record.spec, { ...options, county })
    : new record.Provider({ ...options, county });
}
