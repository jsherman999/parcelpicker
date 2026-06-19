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
  })
  .catch((err) => {
    console.warn("county boundaries load failed:", err);
  });

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "var(--error)" : "var(--muted)";
}

function setBusy(isBusy) {
  lookupButton.disabled = isBusy;
  lookupButton.textContent = isBusy ? "Running..." : "Run Lookup";
}

function clearMap() {
  for (const layer of layers) map.removeLayer(layer);
  layers = [];
}

function renderParcels(parcels) {
  clearMap();
  const bounds = L.latLngBounds([]);

  for (const parcel of parcels) {
    if (!parcel.geometry) continue;

    const color = ringColors[parcel.ring_number] || "#6c6c6c";
    const layer = L.geoJSON(parcel.geometry, {
      bubblingMouseEvents: false,
      style: {
        color,
        weight: parcel.is_seed ? 3 : 2,
        fillColor: color,
        fillOpacity: parcel.is_seed ? 0.35 : 0.2,
      },
    }).addTo(map);

    layer.bindPopup(
      `<strong>Parcel:</strong> ${parcel.parcel_id}<br/>` +
        `<strong>Owner:</strong> ${parcel.owner_name || "(unknown)"}<br/>` +
        `<strong>Ring:</strong> ${parcel.ring_number}`
    );

    layers.push(layer);
    const layerBounds = layer.getBounds();
    if (layerBounds.isValid()) bounds.extend(layerBounds);
  }

  if (bounds.isValid()) map.fitBounds(bounds.pad(0.2));
}

function renderTable(parcels) {
  resultsBody.innerHTML = "";

  if (!parcels.length) {
    resultsBody.innerHTML =
      '<tr><td colspan="5" class="empty">No parcel rows for this run.</td></tr>';
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

function buildPropertyLinks(run, seedParcel) {
  const cfg = getCountyConfig();
  const parcelId = seedParcel?.parcel_id || "";
  const siteAddress = seedParcel?.site_address || "";
  const inputAddress = (run.input_address || "").startsWith("POINT(")
    ? ""
    : run.input_address || "";
  const query = (inputAddress || siteAddress || parcelId).trim();
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
    propertyLinksEl.classList.add("hidden");
    linkListEl.innerHTML = "";
    linksContextEl.textContent = "";
    return;
  }

  const displayAddress = seedParcel.site_address || run.input_address || "(unknown)";
  linksContextEl.textContent = `${displayAddress} • Parcel ${seedParcel.parcel_id || "(n/a)"}`;

  const links = buildPropertyLinks(run, seedParcel);
  if (!links.length) {
    propertyLinksEl.classList.add("hidden");
    linkListEl.innerHTML = "";
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

    const label = run.input_address.startsWith("POINT(") ? "map click" : run.input_address;
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
  setStatus(`Running lookup at ${lat.toFixed(5)}, ${lon.toFixed(5)}...`);

  try {
    const run = await getRunner().runLookupFromPoint({
      lat,
      lon,
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
