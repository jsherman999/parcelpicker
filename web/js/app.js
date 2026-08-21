// In-browser UI + orchestration. Replaces the /api/* fetch calls with direct
// calls into the local runner/provider modules. Rendering, county switching,
// property links, and map-click behavior are carried over from the original
// backend/static/app.js unchanged.

import { createService } from "./providers/registry.js";
import { ParcelLookupRunner } from "./runner.js";
import { ParcelStore } from "./store.js";
import { LLMService } from "./llm.js";
import { SETTINGS, REQUEST } from "./config.js";
import { runToCsv, runToGeoJson, downloadText } from "./export.js";
import { escapeHtml } from "./util.js";

const llm = new LLMService();

// Open the IndexedDB store up front. If it's unavailable (e.g. private mode),
// caching/history are disabled and the app still works in-memory.
let store = null;
try {
  store = await ParcelStore.open();
} catch (err) {
  console.warn("IndexedDB unavailable — cache and history disabled:", err);
}

const countyConfig = {
  wright: {
    label: "Wright County",
    center: [45.2, -93.95],
    zoom: 11,
    placeholder: "Example: 4706 Mayer Ave NE St Michael MN 55376",
    propertySearch: {
      label: "Wright Property Search",
      href: "https://propertyaccess.co.wright.mn.us/search/commonsearch.aspx?mode=combined",
    },
    arcgisJsonBase:
      "https://services2.arcgis.com/CiQCvRGImIxsaFnM/arcgis/rest/services/Parcel_Data/FeatureServer/0/query",
    arcgisJsonFields: "PID,OWNNAME,PHYSADDR",
    arcgisJsonIdField: "PID",
    zillowSuffix: "Wright County MN",
  },
  hennepin: {
    label: "Hennepin County",
    center: [44.98, -93.27],
    zoom: 12,
    placeholder: "Example: 1945 Drew Ave S Minneapolis MN 55416",
    propertySearch: {
      label: "Hennepin Property Map",
      href: "https://gis.hennepin.us/property/map/",
    },
    arcgisJsonBase:
      "https://gis.hennepin.us/arcgis/rest/services/HennepinData/LAND_PROPERTY/MapServer/1/query",
    arcgisJsonFields: "PID,OWNER_NM,HOUSE_NO,STREET_NM,MAILING_MUNIC_NM,ZIP_CD",
    arcgisJsonIdField: "PID",
    zillowSuffix: "Hennepin County MN",
  },
  stlouis: {
    label: "St. Louis County",
    center: [46.79, -92.1],
    zoom: 10,
    placeholder: "Example: 121 Hawthorne Rd Duluth MN 55812",
    propertySearch: {
      label: "St. Louis County Property",
      href: "https://www.stlouiscountymn.gov/departments-a-z/assessor/property-information",
    },
    arcgisJsonBase:
      "https://gis.stlouiscountymn.gov/server2/rest/services/GeneralUse/Cadastral/MapServer/23/query",
    arcgisJsonFields: "PRCL_NBR,OWNAME,PHYSADDR,PHYSCITY,PHYSZIP",
    arcgisJsonIdField: "PRCL_NBR",
    zillowSuffix: "St. Louis County MN",
  },
  sherburne: {
    label: "Sherburne County",
    center: [45.45, -93.78],
    zoom: 11,
    placeholder: "Example: 18879 180th Ave NW Big Lake MN 55309",
    propertySearch: {
      label: "Sherburne Property Search",
      href: "https://beacon.schneidercorp.com/Application.aspx?AppID=133&LayerID=1600&PageTypeID=2&PageID=828",
    },
    arcgisJsonBase:
      "https://gis.co.sherburne.mn.us/arcgis/rest/services/OpenData/Parcels/FeatureServer/0/query",
    arcgisJsonFields:
      "PIN,OWNER_NAME,BLDG_NUM,STREETNAME,STREETTYPE,SUFFIX_DIR,CITY_MAIL,ZIP",
    arcgisJsonIdField: "PIN",
    zillowSuffix: "Sherburne County MN",
  },
  anoka: {
    label: "Anoka County",
    center: [45.27, -93.25],
    zoom: 11,
    placeholder: "Example: 23925 Germanium St NW Saint Francis MN 55070",
    propertySearch: {
      label: "Anoka Property Search",
      href: "https://gis.anokacountymn.gov/propertysearch/",
    },
    arcgisJsonBase:
      "https://gisservices.co.anoka.mn.us/anoka_gis/rest/services/Parcels/FeatureServer/0/query",
    arcgisJsonFields: "PIN,OWNER,LOC_ADDR,LOC_CITY,LOC_ZIP",
    arcgisJsonIdField: "PIN",
    zillowSuffix: "Anoka County MN",
  },
  ramsey: {
    label: "Ramsey County",
    center: [45.02, -93.05],
    zoom: 10,
    placeholder: "Example: 2715 Upper Afton Rd E Maplewood MN 55119",
    propertySearch: {
      label: "Ramsey Open Data",
      href: "https://opendata.ramseycountymn.gov/",
    },
    arcgisJsonBase:
      "https://maps.co.ramsey.mn.us/arcgis/rest/services/OpenData/OpenData/MapServer/12/query",
    arcgisJsonFields: "ParcelID,OwnerName,SiteAddress,SiteCityName,SiteZIP5",
    arcgisJsonIdField: "ParcelID",
    zillowSuffix: "Ramsey County MN",
  },
  olmsted: {
    label: "Olmsted County",
    center: [44.02, -92.95],
    zoom: 10,
    placeholder: "Example: 6126 19th St SE Rochester MN 55068",
    propertySearch: {
      label: "Olmsted County GIS Map",
      href: "https://gweb01.co.olmsted.mn.us/WebApps/OlmstedCountyGISMap/",
    },
    arcgisJsonBase:
      "https://public.gis.olmstedcounty.gov/arcgis/rest/services/Parcels_Addressing/MapServer/3/query",
    arcgisJsonFields: "PIN,OwnerName1,SiteAddrNo,SiteStName,SiteCity,SiteZip5",
    arcgisJsonIdField: "PIN",
    zillowSuffix: "Olmsted County MN",
  },
  chisago: {
    label: "Chisago County",
    center: [45.6, -93.02],
    zoom: 10,
    placeholder: "Example: 16823 River Rd North Branch MN 55056",
    propertySearch: {
      label: "Chisago Parcel Viewer",
      href: "https://gis.chisagocountymn.gov/Link/WAB/",
    },
    arcgisJsonBase:
      "https://gis.chisagocounty.us/arcgis/rest/services/AssessmentInformation/TaxParcels/MapServer/0/query",
    arcgisJsonFields: "PIN,Ownname,PropAddr,PropCity,PropZip",
    arcgisJsonIdField: "PIN",
    zillowSuffix: "Chisago County MN",
  },
  morrison: {
    label: "Morrison County",
    center: [46.05, -94.65],
    zoom: 10,
    placeholder: "Example: 30281 Nature Rd Royalton MN 56373",
    propertySearch: {
      label: "Morrison County Assessor",
      href: "https://morrisoncountymn.gov/government/assessor/",
    },
    arcgisJsonBase:
      "https://services1.arcgis.com/lQjrBHFnTgKBR9zX/arcgis/rest/services/Parcels/FeatureServer/0/query",
    arcgisJsonFields: "PIN,Primary_Owner,Situs_Freeform_Addr,SitusCity,SitusZip",
    arcgisJsonIdField: "PIN",
    zillowSuffix: "Morrison County MN",
  },
  scott: {
    label: "Scott County",
    center: [44.6, -93.78],
    zoom: 10,
    placeholder: "Example: 72 Cedar Lake Ct New Prague MN 56071",
    propertySearch: {
      label: "Scott County Open Data",
      href: "https://open-data-scottcounty.hub.arcgis.com/datasets/parcels/explore",
    },
    arcgisJsonBase:
      "https://services.arcgis.com/DqIh9WAsIZcPlBEF/arcgis/rest/services/Parcels/FeatureServer/0/query",
    arcgisJsonFields: "PID,TaxPayerName,PropertyAddress1,PropertyCity,PropertyZip",
    arcgisJsonIdField: "PID",
    zillowSuffix: "Scott County MN",
  },
  aitkin: {
    label: "Aitkin County",
    center: [46.72, -93.37],
    zoom: 10,
    placeholder: "Example: 230 S Maddy St McGregor MN 55760",
    propertySearch: {
      label: "Aitkin County GIS",
      href: "https://gisweb.co.aitkin.mn.us/",
    },
    arcgisJsonBase:
      "https://gisweb.co.aitkin.mn.us/arcgis/rest/services/ParcelTaxData/FeatureServer/0/query",
    arcgisJsonFields: "PRCL_NBR,OWNNAME,ADDR_1,ADDR_2",
    arcgisJsonIdField: "PRCL_NBR",
    zillowSuffix: "Aitkin County MN",
  },
  koochiching: {
    label: "Koochiching County",
    center: [48.47, -94.47],
    zoom: 10,
    placeholder: "Example: 12005 Town Road 129 Baudette MN 56623",
    propertySearch: {
      label: "Koochiching County",
      href: "https://koochichingcounty.gov/",
    },
    arcgisJsonBase:
      "https://services3.arcgis.com/8mdusDCY0WncdJVw/arcgis/rest/services/KoochichingCountyParcelDataPublish/FeatureServer/0/query",
    arcgisJsonFields: "PARCEL_ID,OWNNAME,ADDR_1,CITY,ZIP_CODE_5",
    arcgisJsonIdField: "PARCEL_ID",
    zillowSuffix: "Koochiching County MN",
  },
  beltrami: {
    label: "Beltrami County",
    center: [47.85, -95.65],
    zoom: 10,
    placeholder: "Example: 8644 Lumberjack Rd NW Puposky MN 56667",
    propertySearch: {
      label: "Beltrami County Assessor",
      href: "https://beltramicounty.org/assessor/",
    },
    arcgisJsonBase:
      "https://arcgis.co.beltrami.mn.us/arcgis/rest/services/BeltramiData/BeltramiOpenData/MapServer/2/query",
    arcgisJsonFields: "PIN,OWNERNAME1,OWNERNAME2,PROP_ADD1,PROP_CITY,PROP_ZIP",
    arcgisJsonIdField: "PIN",
    zillowSuffix: "Beltrami County MN",
  },
  dakota: {
    label: "Dakota County",
    center: [44.78, -93.28],
    zoom: 10,
    placeholder: "Example: 4955 Diamond Path Apple Valley MN 55124",
    propertySearch: {
      label: "Dakota County GIS",
      href: "https://gis.co.dakota.mn.us/dcgis/",
    },
    arcgisJsonBase:
      "https://arcgis.metc.state.mn.us/data1/rest/services/parcels/Parcels/FeatureServer/2/query",
    arcgisJsonFields: "PIN,OWNER_NAME,ANUMBER,ST_NAME,ST_POS_TYP,CTU_NAME,ZIP",
    arcgisJsonIdField: "PIN",
    zillowSuffix: "Dakota County MN",
  },
  washington: {
    label: "Washington County",
    center: [45.33, -93.1],
    zoom: 10,
    placeholder: "Example: 12001 120th St NE Bayport MN 55003",
    propertySearch: {
      label: "Washington County GIS",
      href: "https://washingtoncountymn.gov/government/departments-a-z/g/gis",
    },
    arcgisJsonBase:
      "https://arcgis.metc.state.mn.us/data1/rest/services/parcels/Parcels/FeatureServer/6/query",
    arcgisJsonFields: "PIN,OWNER_NAME,ANUMBER,ST_NAME,ST_POS_TYP,CTU_NAME,ZIP",
    arcgisJsonIdField: "PIN",
    zillowSuffix: "Washington County MN",
  },
  carver: {
    label: "Carver County",
    center: [44.82, -93.85],
    zoom: 10,
    placeholder: "Example: 13075 166th St Chanhassen MN 55317",
    propertySearch: {
      label: "Carver County Property Search",
      href: "https://gis.carvercountymn.gov/property/",
    },
    arcgisJsonBase:
      "https://arcgis.metc.state.mn.us/data1/rest/services/parcels/Parcels/FeatureServer/1/query",
    arcgisJsonFields: "PIN,TAX_NAME,ANUMBER,ST_NAME,CTU_NAME,ZIP",
    arcgisJsonIdField: "PIN",
    zillowSuffix: "Carver County MN",
  },
};

const countySelect = document.getElementById("county");
const addressInput = document.getElementById("address");
const ringsInput = document.getElementById("rings");
const useLlmInput = document.getElementById("use-llm");
const lookupButton = document.getElementById("lookup");
const statusEl = document.getElementById("status");
const subheadingEl = document.getElementById("subheading");
const runMetaEl = document.getElementById("run-meta");
const runIdEl = document.getElementById("run-id");
const runStatusEl = document.getElementById("run-status");
const parcelCountEl = document.getElementById("parcel-count");
const ownerCountEl = document.getElementById("owner-count");
const seedParcelEl = document.getElementById("seed-parcel");
const summaryEl = document.getElementById("summary");
const csvLink = document.getElementById("csv-link");
const geojsonLink = document.getElementById("geojson-link");
const resultsBody = document.getElementById("results-body");
const propertyLinksEl = document.getElementById("property-links");
const linksContextEl = document.getElementById("links-context");
const linkListEl = document.getElementById("link-list");
const expandNeighborsBtn = document.getElementById("expand-neighbors");
const clearSelectionBtn = document.getElementById("clear-selection");

const ringColors = { 0: "#1a6f4b", 1: "#2d4f9a", 2: "#b76a22" };

const countyBorderStyle = {
  color: "#0b3d2e",
  weight: 2,
  fill: false,
  dashArray: "5 4",
  interactive: false,
};

let layers = [];
let countyBoundaries = {};
let currentBorderLayer = null;
let currentRun = null;
let sessionParcels = new Map(); // parcel_id -> parcel (accumulated map selection)
let selectedParcelId = null; // most recently inspected parcel

// One runner per county, created on demand (each wraps its own provider).
const runners = {};
function getRunner() {
  const county = getCounty();
  if (!runners[county]) {
    const service = createService(county, REQUEST);
    runners[county] = new ParcelLookupRunner(service, SETTINGS, county, store, llm);
  }
  return runners[county];
}

function getCounty() {
  return countySelect.value || "wright";
}

function getCountyConfig() {
  return countyConfig[getCounty()] || countyConfig.wright;
}

const map = L.map("map").setView(getCountyConfig().center, getCountyConfig().zoom);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 20,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

function drawCountyBorder() {
  if (currentBorderLayer) {
    map.removeLayer(currentBorderLayer);
    currentBorderLayer = null;
  }
  const geom = countyBoundaries[getCounty()];
  if (!geom) return;
  currentBorderLayer = L.geoJSON(geom, countyBorderStyle).addTo(map);
  if (currentBorderLayer.bringToBack) currentBorderLayer.bringToBack();
}

function applyCounty() {
  const cfg = getCountyConfig();
  subheadingEl.textContent = cfg.label + " address → owner → adjacent parcel rings";
  addressInput.placeholder = cfg.placeholder;
  map.setView(cfg.center, cfg.zoom);
  drawCountyBorder();
  resetSession();
}

countySelect.addEventListener("change", applyCounty);
applyCounty();

fetch("county_boundaries.geojson")
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error("status " + r.status))))
  .then((fc) => {
    for (const feat of fc.features || []) {
      const id = feat.id || (feat.properties && feat.properties.id);
      if (id) countyBoundaries[id] = feat;
    }
    drawCountyBorder();
    detectCounty();
  })
  .catch((err) => {
    console.warn("county boundaries load failed:", err);
  });

// Pre-select the county the user is physically in (falls back to the default,
// St. Louis, if geolocation is unavailable, denied, or outside all counties).
function ringContains(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function polygonContains(lon, lat, rings) {
  if (!rings || !rings.length || !ringContains(lon, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i += 1) {
    if (ringContains(lon, lat, rings[i])) return false; // inside a hole
  }
  return true;
}

function countyForPoint(lon, lat) {
  for (const id of Object.keys(countyConfig)) {
    const feat = countyBoundaries[id];
    const geom = feat && feat.geometry;
    if (!geom) continue;
    if (geom.type === "Polygon" && polygonContains(lon, lat, geom.coordinates)) return id;
    if (
      geom.type === "MultiPolygon" &&
      geom.coordinates.some((poly) => polygonContains(lon, lat, poly))
    ) {
      return id;
    }
  }
  return null;
}

function detectCounty() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const match = countyForPoint(pos.coords.longitude, pos.coords.latitude);
      if (match && match !== getCounty()) {
        countySelect.value = match;
        applyCounty();
        setStatus(`Detected ${getCountyConfig().label} from your location.`);
      }
    },
    () => {
      // denied / unavailable / timed out — keep the St. Louis default
    },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 }
  );
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "var(--error)" : "var(--muted)";
}

function setBusy(isBusy) {
  lookupButton.disabled = isBusy;
  lookupButton.textContent = isBusy ? "Running..." : "Run Lookup";
  if (expandNeighborsBtn) expandNeighborsBtn.disabled = isBusy || !selectedParcelId;
}

function clearMap() {
  for (const layer of layers) map.removeLayer(layer);
  layers = [];
}

// ---- Owner labels on the map --------------------------------------------

// Absolute shoelace area for a GeoJSON ring of [lon, lat] pairs.
function ringArea(ring) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i += 1) {
    area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(area / 2);
}

// Shoelace centroid for a GeoJSON ring; falls back to the mean vertex for
// degenerate (zero-area) rings.
function ringCentroid(ring) {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i += 1) {
    const x0 = ring[j][0];
    const y0 = ring[j][1];
    const x1 = ring[i][0];
    const y1 = ring[i][1];
    const f = x0 * y1 - x1 * y0;
    area += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  area /= 2;
  if (Math.abs(area) < 1e-12) {
    return [
      ring.reduce((sum, pt) => sum + pt[0], 0) / ring.length,
      ring.reduce((sum, pt) => sum + pt[1], 0) / ring.length,
    ];
  }
  return [cx / (6 * area), cy / (6 * area)];
}

// Label point for a GeoJSON geometry: centroid of the largest polygon so
// MultiPolygons (and donut-shaped rings) don't land in a hole.
function geometryLabelPoint(geometry) {
  if (!geometry || !Array.isArray(geometry.coordinates)) return null;
  const polygons =
    geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
  let bestRing = null;
  let bestArea = -1;
  for (const poly of polygons) {
    const outer = poly && poly[0];
    if (!outer || outer.length < 3) continue;
    const area = ringArea(outer);
    if (area > bestArea) {
      bestArea = area;
      bestRing = outer;
    }
  }
  return bestRing ? ringCentroid(bestRing) : null;
}

// Permanent, non-interactive owner label centered on the parcel.
function addOwnerLabel(parcel) {
  const point = geometryLabelPoint(parcel.geometry);
  if (!point) return null;
  const name = parcel.owner_name || parcel.normalized_owner_name || "(unknown)";
  // L.marker expects [lat, lng]; the centroid is [lon, lat].
  const marker = L.marker([point[1], point[0]], {
    icon: L.divIcon({
      className: "owner-label",
      html: `<span class="owner-label-text${parcel.is_seed ? " seed" : ""}">${escapeHtml(
        name
      )}</span>`,
    }),
    interactive: false,
    keyboard: false,
    zIndexOffset: parcel.is_seed ? 1000 : 0,
  }).addTo(map);
  return marker;
}

function renderParcels(parcels, highlightId = null) {
  clearMap();
  const bounds = L.latLngBounds([]);

  for (const parcel of parcels) {
    if (!parcel.geometry) continue;

    const isHighlight = highlightId != null && parcel.parcel_id === highlightId;
    const color = ringColors[parcel.ring_number] || "#6c6c6c";
    const layer = L.geoJSON(parcel.geometry, {
      bubblingMouseEvents: false,
      style: {
        color,
        weight: isHighlight || parcel.is_seed ? 3 : 2,
        fillColor: color,
        fillOpacity: isHighlight ? 0.4 : parcel.is_seed ? 0.3 : 0.2,
      },
    }).addTo(map);

    layer.bindPopup(
      `<strong>Parcel:</strong> ${parcel.parcel_id}<br/>` +
        `<strong>Owner:</strong> ${parcel.owner_name || "(unknown)"}<br/>` +
        `<strong>Ring:</strong> ${parcel.ring_number}`
    );

    layers.push(layer);
    const label = addOwnerLabel(parcel);
    if (label) layers.push(label);
    const layerBounds = layer.getBounds();
    if (layerBounds.isValid()) bounds.extend(layerBounds);
  }

  if (bounds.isValid()) map.fitBounds(bounds.pad(0.2));
}

function renderTable(parcels) {
  resultsBody.innerHTML = "";

  if (!parcels.length) {
    resultsBody.innerHTML =
      '<tr><td colspan="5" class="empty">No parcels to display.</td></tr>';
    return;
  }

  for (const parcel of parcels) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${parcel.ring_number}${parcel.is_seed ? " (seed)" : ""}</td>
      <td>${parcel.parcel_id}</td>
      <td>${parcel.owner_name || ""}</td>
      <td>${parcel.normalized_owner_name || ""}</td>
      <td>${parcel.site_address || ""}</td>
    `;
    resultsBody.appendChild(tr);
  }
}

function buildPropertyLinks(seedParcel, inputAddress = "") {
  const cfg = getCountyConfig();
  const parcelId = seedParcel?.parcel_id || "";
  const siteAddress = seedParcel?.site_address || "";
  const safeInput = String(inputAddress || "");
  const cleanInput = safeInput.startsWith("POINT(") || safeInput.startsWith("PARCEL(")
    ? ""
    : safeInput;
  const query = (cleanInput || siteAddress || parcelId).trim();
  if (!query) return [];

  const zillowQuery = `${query} ${cfg.zillowSuffix}`;
  const where = parcelId
    ? `${cfg.arcgisJsonIdField}='${parcelId.replace(/'/g, "''")}'`
    : "";

  const links = [
    {
      label: "Open Zillow",
      href: `https://www.zillow.com/homes/${encodeURIComponent(zillowQuery)}_rb/`,
      primary: true,
    },
    {
      label: "Open Realtor",
      href: `https://www.realtor.com/realestateandhomes-search?query=${encodeURIComponent(
        zillowQuery
      )}`,
      primary: false,
    },
    {
      label: cfg.propertySearch.label,
      href: cfg.propertySearch.href,
      primary: false,
    },
  ];

  if (where) {
    links.push({
      label: `${cfg.label} Parcel JSON`,
      href:
        cfg.arcgisJsonBase +
        `?f=pjson&where=${encodeURIComponent(where)}&outFields=${cfg.arcgisJsonFields}&returnGeometry=true&outSR=4326`,
      primary: false,
    });
  }

  return links;
}

function renderPropertyLinks(run) {
  const seedParcel = (run.parcels || []).find((parcel) => parcel.is_seed);
  if (!seedParcel) {
    hidePropertyLinks();
    return;
  }
  renderPropertyLinksForParcel(seedParcel, run.input_address);
}

function hidePropertyLinks() {
  propertyLinksEl.classList.add("hidden");
  linkListEl.innerHTML = "";
  linksContextEl.textContent = "";
}

function renderPropertyLinksForParcel(parcel, inputAddress = "") {
  if (!parcel) {
    hidePropertyLinks();
    return;
  }
  const displayAddress = parcel.site_address || inputAddress || "(unknown)";
  linksContextEl.textContent = `${displayAddress} • Parcel ${parcel.parcel_id || "(n/a)"}`;

  const links = buildPropertyLinks(parcel, inputAddress);
  if (!links.length) {
    hidePropertyLinks();
    return;
  }

  linkListEl.innerHTML = links
    .map(
      (link) =>
        `<a class="link-chip${link.primary ? " primary" : ""}" href="${link.href}" target="_blank" rel="noopener">${link.label}</a>`
    )
    .join("");
  propertyLinksEl.classList.remove("hidden");
}

function renderRun(run) {
  currentRun = run;
  runMetaEl.classList.remove("hidden");
  runIdEl.textContent = run.id;
  runStatusEl.textContent = run.from_cache ? `${run.status} (cache)` : run.status;
  parcelCountEl.textContent = run.parcel_count;
  ownerCountEl.textContent = run.owner_count;
  seedParcelEl.textContent = run.seed_parcel_id || "(none)";
  summaryEl.textContent = run.summary || "";

  const seedParcel = (run.parcels || []).find((parcel) => parcel.is_seed);
  const detectedAddress = (seedParcel && seedParcel.site_address) || "";
  if (detectedAddress && String(run.input_address || "").startsWith("POINT(")) {
    addressInput.value = detectedAddress;
  }

  renderPropertyLinks(run);
  renderParcels(run.parcels || []);
  renderTable(run.parcels || []);
}

function renderSession() {
  const parcels = [...sessionParcels.values()];
  const selected = selectedParcelId ? sessionParcels.get(selectedParcelId) : null;

  runMetaEl.classList.add("hidden");
  renderParcels(parcels, selectedParcelId);
  renderTable(parcels);
  if (selected) {
    renderPropertyLinksForParcel(selected, "");
  } else {
    hidePropertyLinks();
  }
  if (expandNeighborsBtn) expandNeighborsBtn.disabled = !selected;
}

function resetSession() {
  sessionParcels.clear();
  selectedParcelId = null;
  clearMap();
  renderTable([]);
  hidePropertyLinks();
  if (expandNeighborsBtn) expandNeighborsBtn.disabled = true;
}

csvLink.addEventListener("click", (event) => {
  event.preventDefault();
  if (!currentRun) return;
  downloadText(`run_${currentRun.id}.csv`, runToCsv(currentRun), "text/csv");
});

geojsonLink.addEventListener("click", (event) => {
  event.preventDefault();
  if (!currentRun) return;
  downloadText(
    `run_${currentRun.id}.geojson`,
    JSON.stringify(runToGeoJson(currentRun), null, 2),
    "application/geo+json"
  );
});

function handleRunResult(run) {
  if (run.status === "failed") throw new Error(run.error || "Lookup failed.");
  if (run.status === "not_found") throw new Error(run.error || "No parcel found.");
  renderRun(run);
  const suffix = run.status === "capped" ? " (capped by limits)" : "";
  const cacheSuffix = run.from_cache ? " (loaded from 30-day cache)" : "";
  setStatus(`Run ${run.id} complete${suffix}${cacheSuffix}.`);
  refreshHistory();
}

const historyPanelEl = document.getElementById("history-panel");
const historyListEl = document.getElementById("history-list");

async function refreshHistory() {
  if (!store || !historyListEl) return;
  let runs = [];
  try {
    runs = await store.listRuns(10);
  } catch (err) {
    return;
  }
  if (!runs.length) {
    historyPanelEl.classList.add("hidden");
    return;
  }
  historyListEl.innerHTML = "";
  for (const run of runs) {
    const li = document.createElement("li");
    li.className = "history-item";

    const label = run.input_address.startsWith("POINT(")
      ? "map click"
      : run.input_address.startsWith("PARCEL(")
        ? "expand neighbors"
        : run.input_address;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-link";
    button.dataset.runId = run.id;
    button.textContent = `#${run.id} ${label}`;

    const meta = document.createElement("span");
    meta.className = "history-meta";
    meta.textContent = `${run.status} • ${new Date(run.created_at).toLocaleString()}`;

    li.append(button, meta);
    historyListEl.appendChild(li);
  }
  historyPanelEl.classList.remove("hidden");
}

if (historyListEl) {
  historyListEl.addEventListener("click", async (event) => {
    const button = event.target.closest(".history-link");
    if (!button || !store) return;
    const runId = Number(button.dataset.runId);
    try {
      const run = await store.getRun(runId);
      if (run) {
        renderRun(run);
        setStatus(`Loaded run ${run.id} from history.`);
      }
    } catch (err) {
      setStatus("Could not load run from history.", true);
    }
  });
}

function handleRunError(error) {
  runMetaEl.classList.add("hidden");
  propertyLinksEl.classList.add("hidden");
  linkListEl.innerHTML = "";
  currentRun = null;
  clearMap();
  renderTable([]);
  setStatus(error.message || "Lookup failed.", true);
}

async function runLookup() {
  const address = addressInput.value.trim();
  if (!address) {
    setStatus("Enter an address first.", true);
    return;
  }

  setBusy(true);
  setStatus("Running lookup...");

  try {
    const run = await getRunner().runLookup({
      address,
      rings: Number(ringsInput.value),
      useLlm: Boolean(useLlmInput.checked),
    });
    handleRunResult(run);
  } catch (error) {
    handleRunError(error);
  } finally {
    setBusy(false);
  }
}

async function runLookupByPoint(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

  setBusy(true);
  setStatus(`Looking up parcel at ${lat.toFixed(5)}, ${lon.toFixed(5)}...`);

  try {
    const parcel = await getRunner().lookupSeedByPoint({ lat, lon });
    if (!parcel || !parcel.parcel_id) {
      setStatus("No parcel found at clicked location.", true);
      return;
    }
    sessionParcels.set(parcel.parcel_id, parcel);
    selectedParcelId = parcel.parcel_id;
    renderSession();
    setStatus(
      `Selected parcel ${parcel.parcel_id} — ${parcel.owner_name || "owner unknown"}. ` +
        "Click another parcel to inspect it, or use Expand Neighbors."
    );
  } catch (error) {
    setStatus(error.message || "Lookup failed.", true);
  } finally {
    setBusy(false);
  }
}

async function expandSelected() {
  const seed = selectedParcelId ? sessionParcels.get(selectedParcelId) : null;
  if (!seed) {
    setStatus("Click a parcel first, then expand its neighbors.", true);
    return;
  }
  const rings = Number(ringsInput.value);
  setBusy(true);
  setStatus(`Expanding neighbors around ${seed.parcel_id} (rings ${rings})...`);

  try {
    const run = await getRunner().runLookupFromSeed({
      seedParcel: seed,
      rings,
      useLlm: Boolean(useLlmInput.checked),
    });
    if (run.status === "failed" || run.status === "not_found") {
      throw new Error(run.error || "Expansion failed.");
    }
    for (const parcel of run.parcels || []) {
      sessionParcels.set(parcel.parcel_id, { ...parcel });
    }
    renderSession();
    setStatus(`Expanded ${seed.parcel_id}: ${run.parcel_count} parcels across rings 0-${rings}.`);
    refreshHistory();
  } catch (error) {
    setStatus(error.message || "Expansion failed.", true);
  } finally {
    setBusy(false);
  }
}

function clearSelection() {
  resetSession();
  setStatus("Map selection cleared. Click any parcel to inspect it.");
}

if (expandNeighborsBtn) expandNeighborsBtn.addEventListener("click", expandSelected);
if (clearSelectionBtn) clearSelectionBtn.addEventListener("click", clearSelection);

lookupButton.addEventListener("click", runLookup);
addressInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") runLookup();
});

map.on("click", (event) => {
  if (lookupButton.disabled) return;
  runLookupByPoint(event.latlng.lat, event.latlng.lng);
});

// ---- LLM settings panel (Phase 4) -------------------------------------
const llmProviderEl = document.getElementById("llm-provider");
const llmModelEl = document.getElementById("llm-model");
const llmKeyEl = document.getElementById("llm-key");
const llmSaveBtn = document.getElementById("llm-save");
const llmClearBtn = document.getElementById("llm-clear");
const llmStatusEl = document.getElementById("llm-status");

function refreshLlmAvailability() {
  const available = llm.isAvailable;
  useLlmInput.disabled = !available;
  if (!available) useLlmInput.checked = false;
}

function initLlmSettings() {
  const cfg = llm.getConfig();
  llmProviderEl.value = cfg.provider;
  llmModelEl.value = cfg.model;
  llmKeyEl.value = cfg.apiKey;
  if (llm.isAvailable) {
    llmStatusEl.textContent = `Configured: ${cfg.provider} / ${cfg.model}.`;
  }
  refreshLlmAvailability();
  // Default the LLM toggle on at load when a key is configured.
  if (llm.isAvailable) useLlmInput.checked = true;
}

llmSaveBtn.addEventListener("click", () => {
  const provider = llmProviderEl.value || "openai";
  const model = (llmModelEl.value || "").trim() || "gpt-4o-mini";
  const apiKey = (llmKeyEl.value || "").trim();
  llm.saveConfig({ provider, model, apiKey, enabled: true });
  llmModelEl.value = model;
  refreshLlmAvailability();
  llmStatusEl.textContent = llm.isAvailable
    ? `Saved. LLM enabled (${provider} / ${model}). Tick the checkbox above to use it.`
    : "Saved, but no API key entered — LLM stays off.";
});

llmClearBtn.addEventListener("click", () => {
  llm.saveConfig({ apiKey: "" });
  llmKeyEl.value = "";
  refreshLlmAvailability();
  llmStatusEl.textContent = "Key cleared. LLM disabled.";
});

initLlmSettings();

// Populate run history from any prior session.
refreshHistory();
