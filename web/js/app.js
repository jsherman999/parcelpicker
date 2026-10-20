// In-browser UI + orchestration. Replaces the /api/* fetch calls with direct
// calls into the local runner/provider modules. Rendering, county switching,
// property links, and map-click behavior are carried over from the original
// backend/static/app.js unchanged.

import { COUNTIES, createProvider } from "./providers/registry.js";
import { ParcelLookupRunner } from "./runner.js";
import { ParcelStore } from "./store.js";
import { LLMService } from "./llm.js";
import { SETTINGS, REQUEST } from "./config.js";
import { runToCsv, runToGeoJson, downloadText } from "./export.js";
import { escapeHtml } from "./util.js";
import { pointInGeometry, polygonRingSignedArea } from "./geometry.js";

const llm = new LLMService();

// Open the IndexedDB store up front. If it's unavailable (e.g. private mode),
// caching/history are disabled and the app still works in-memory.
let store = null;
try {
  store = await ParcelStore.open();
} catch (err) {
  console.warn("IndexedDB unavailable — cache and history disabled:", err);
}

const countySelect = document.getElementById("county");

// Fill the county dropdown alphabetically from the registry, keeping the
// default selection from index.html (St. Louis).
function populateCountySelect() {
  const current = countySelect.value || "stlouis";
  const ids = Object.keys(COUNTIES).sort((a, b) =>
    COUNTIES[a].label.localeCompare(COUNTIES[b].label)
  );
  countySelect.replaceChildren(
    ...ids.map((id) => {
      const { label, badge } = COUNTIES[id];
      return new Option(badge ? `${label} (${badge})` : label, id, false, id === current);
    })
  );
}
populateCountySelect();

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
let selectionAddress = null; // what a map click wrote into the address box

// One provider and one runner per county, created on demand.
const providers = {};
function providerFor(county) {
  if (!providers[county]) providers[county] = createProvider(county, REQUEST);
  return providers[county];
}

const runners = {};
function getRunner() {
  const county = getCounty();
  if (!runners[county]) {
    runners[county] = new ParcelLookupRunner(providerFor(county), SETTINGS, store, llm);
  }
  return runners[county];
}

function getCounty() {
  return countySelect.value || "wright";
}

function getCountyConfig() {
  return COUNTIES[getCounty()] || COUNTIES.wright;
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

// CC-BY-4.0 credit for the ErisData adapter spec behind spec-driven counties.
const ERIS_ATTRIBUTION =
  'Parcel layer spec: <a href="https://github.com/Eriskii/ErisData">ErisData</a> ' +
  '(Eriskii, <a href="https://creativecommons.org/licenses/by/4.0/">CC-BY-4.0</a>)';

function applyCounty({ keepView = false } = {}) {
  const cfg = getCountyConfig();
  subheadingEl.textContent = cfg.label + " address → owner → adjacent parcel rings";
  addressInput.placeholder = cfg.placeholder;
  map.attributionControl.removeAttribution(ERIS_ATTRIBUTION);
  if (getCountyConfig().spec) map.attributionControl.addAttribution(ERIS_ATTRIBUTION);
  if (!keepView) map.setView(cfg.center, cfg.zoom);
  drawCountyBorder();
  resetSession();
  if (cfg.coverage) setStatus(`Note: ${cfg.label} ${cfg.coverage}.`);
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

function featureContains(feat, lon, lat) {
  return Boolean(feat) && pointInGeometry(lon, lat, feat.geometry);
}

function countyForPoint(lon, lat) {
  for (const id of Object.keys(COUNTIES)) {
    if (featureContains(countyBoundaries[id], lon, lat)) return id;
  }
  return null;
}

// Any MN county boundary containing the point, supported or not (the
// boundary file covers all 87; unsupported ones carry the reason).
function boundaryForPoint(lon, lat) {
  return Object.values(countyBoundaries).find((feat) => featureContains(feat, lon, lat)) || null;
}

// Pre-select the county the user is physically in (falls back to the default,
// St. Louis, if geolocation is unavailable, denied, or outside all counties).
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

// Shoelace centroid for a GeoJSON polygon ring; falls back to the mean
// vertex for degenerate (zero-area) polygon rings.
function polygonRingCentroid(ring) {
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
// MultiPolygons (and donut-shaped parcels) don't land in a hole.
function geometryLabelPoint(geometry) {
  if (!geometry || !Array.isArray(geometry.coordinates)) return null;
  const polygons =
    geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
  let bestRing = null;
  let bestArea = -1;
  for (const poly of polygons) {
    const outer = poly && poly[0];
    if (!outer || outer.length < 3) continue;
    const area = Math.abs(polygonRingSignedArea(outer));
    if (area > bestArea) {
      bestArea = area;
      bestRing = outer;
    }
  }
  return bestRing ? polygonRingCentroid(bestRing) : null;
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
      `<strong>Parcel:</strong> ${escapeHtml(parcel.parcel_id)}<br/>` +
        `<strong>Owner:</strong> ${escapeHtml(parcel.owner_name || "(unknown)")}<br/>` +
        `<strong>Est. market value:</strong> ${escapeHtml(formatMarketValue(parcel))}<br/>` +
        `<strong>Land use / class:</strong> ${escapeHtml(parcel.land_use || "—")}<br/>` +
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

// "$412,300 (2026)": Minnesota's Estimated Market Value, with the assessment
// year when the county layer publishes one; "—" when it doesn't.
const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
function formatMarketValue(parcel) {
  const value = Number(parcel.market_value);
  if (!Number.isFinite(value) || value <= 0) return "—";
  const year = parcel.market_value_year ? ` (${parcel.market_value_year})` : "";
  return `${usd.format(value)}${year}`;
}

function renderTable(parcels) {
  resultsBody.innerHTML = "";

  if (!parcels.length) {
    resultsBody.innerHTML =
      '<tr><td colspan="7" class="empty">No parcels to display.</td></tr>';
    return;
  }

  for (const parcel of parcels) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${parcel.ring_number}${parcel.is_seed ? " (seed)" : ""}</td>
      <td>${escapeHtml(parcel.parcel_id)}</td>
      <td>${escapeHtml(parcel.owner_name || "")}</td>
      <td>${escapeHtml(parcel.normalized_owner_name || "")}</td>
      <td>${escapeHtml(parcel.site_address || "")}</td>
      <td class="num">${escapeHtml(formatMarketValue(parcel))}</td>
      <td>${escapeHtml(parcel.land_use || "—")}</td>
    `;
    resultsBody.appendChild(tr);
  }
}

// Links for a parcel in the given county. `input` is the run input, if any:
// a typed address is the best search query; otherwise the parcel's own site
// address, then its ID.
function buildPropertyLinks(parcel, county, input = null) {
  const cfg = COUNTIES[county];
  if (!cfg) return [];
  const parcelId = parcel?.parcel_id || "";
  const typedAddress = input?.kind === "address" ? input.address : "";
  const query = (typedAddress || parcel?.site_address || parcelId).trim();
  if (!query) return [];

  const zillowQuery = `${query} ${cfg.label} MN`;
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
  ];

  if (cfg.propertySearch) {
    links.push({
      label: cfg.propertySearch.label,
      href: cfg.propertySearch.href,
      primary: false,
    });
  }

  if (parcelId) {
    links.push({
      label: `${cfg.label} Parcel JSON`,
      href: providerFor(county).parcelJsonUrl(parcelId),
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
  renderPropertyLinksForParcel(seedParcel, run.county, run.input);
}

function hidePropertyLinks() {
  propertyLinksEl.classList.add("hidden");
  linkListEl.innerHTML = "";
  linksContextEl.textContent = "";
}

function renderPropertyLinksForParcel(parcel, county, input = null) {
  if (!parcel) {
    hidePropertyLinks();
    return;
  }
  const typedAddress = input?.kind === "address" ? input.address : "";
  const displayAddress = parcel.site_address || typedAddress || "(unknown)";
  linksContextEl.textContent = `${displayAddress} • Parcel ${parcel.parcel_id || "(n/a)"}`;

  const links = buildPropertyLinks(parcel, county, input);
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
  if (detectedAddress && run.input?.kind === "point") {
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
    renderPropertyLinksForParcel(selected, selected.county);
  } else {
    hidePropertyLinks();
  }
  if (expandNeighborsBtn) expandNeighborsBtn.disabled = !selected;
}

function resetSession() {
  sessionParcels.clear();
  selectedParcelId = null;
  if (selectionAddress !== null && addressInput.value === selectionAddress) addressInput.value = "";
  selectionAddress = null;
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
  const suffix =
    run.capped_by === "request_budget"
      ? " (stopped early: request budget used up)"
      : run.capped_by === "max_parcels"
        ? " (stopped early: parcel limit reached)"
        : "";
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

    const kindLabel = {
      point: "map click",
      parcel: "expand neighbors",
      address: run.input?.address,
    }[run.input?.kind];
    const countyLabel = COUNTIES[run.county]?.label || run.county;
    const label = `${kindLabel || run.input_label} (${countyLabel})`;
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
  // The box still holds what a map click put there (the parcel's address, or
  // nothing): look up from that parcel rather than geocoding its address.
  if (selectedParcelId && selectionAddress !== null && address === selectionAddress.trim()) {
    await expandSelected();
    return;
  }
  selectionAddress = null;
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
    selectionAddress = parcel.site_address || "";
    addressInput.value = selectionAddress;
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
  const { lat, lng } = event.latlng;
  // Follow the click across county lines: switch to whichever supported
  // county contains it (keeping the current view) rather than querying the
  // selected county's layer, which would find nothing there.
  const clicked = countyForPoint(lng, lat);
  if (clicked && clicked !== getCounty()) {
    countySelect.value = clicked;
    applyCounty({ keepView: true });
  } else if (!clicked) {
    const props = boundaryForPoint(lng, lat)?.properties;
    if (props?.unsupported) {
      setStatus(`${props.name} County isn't supported: ${props.unsupported}.`, true);
      return;
    }
  }
  runLookupByPoint(lat, lng);
});

// ---- LLM settings panel (Phase 4) -------------------------------------
const llmVendorEl = document.getElementById("llm-vendor");
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
  llmVendorEl.value = cfg.vendor;
  llmModelEl.value = cfg.model;
  llmKeyEl.value = cfg.apiKey;
  if (llm.isAvailable) {
    llmStatusEl.textContent = `Configured: ${cfg.vendor} / ${cfg.model}.`;
  }
  refreshLlmAvailability();
  // Default the LLM toggle on at load when a key is configured.
  if (llm.isAvailable) useLlmInput.checked = true;
}

llmSaveBtn.addEventListener("click", () => {
  const vendor = llmVendorEl.value || "openai";
  const model = (llmModelEl.value || "").trim() || "gpt-4o-mini";
  const apiKey = (llmKeyEl.value || "").trim();
  llm.saveConfig({ vendor, model, apiKey, enabled: true });
  llmModelEl.value = model;
  refreshLlmAvailability();
  llmStatusEl.textContent = llm.isAvailable
    ? `Saved. LLM enabled (${vendor} / ${model}). Tick the checkbox above to use it.`
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
