const map = L.map("map").setView([45.2, -93.95], 11);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 20,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const addressInput = document.getElementById("address");
const ringsInput = document.getElementById("rings");
const useLlmInput = document.getElementById("use-llm");
const lookupButton = document.getElementById("lookup");
const statusEl = document.getElementById("status");
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

const ringColors = {
  0: "#1a6f4b",
  1: "#2d4f9a",
  2: "#b76a22",
};

let layers = [];

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "var(--error)" : "var(--muted)";
}

function setBusy(isBusy) {
  lookupButton.disabled = isBusy;
  lookupButton.textContent = isBusy ? "Running..." : "Run Lookup";
}

function clearMap() {
  for (const layer of layers) {
    map.removeLayer(layer);
  }
  layers = [];
}

function renderParcels(parcels) {
  clearMap();
  const bounds = L.latLngBounds([]);

  for (const parcel of parcels) {
    if (!parcel.geometry) {
      continue;
    }

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
    if (layerBounds.isValid()) {
      bounds.extend(layerBounds);
    }
  }

  if (bounds.isValid()) {
    map.fitBounds(bounds.pad(0.2));
  }
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

function renderRun(run) {
  runMetaEl.classList.remove("hidden");
  runIdEl.textContent = run.id;
  runStatusEl.textContent = run.status;
  parcelCountEl.textContent = run.parcel_count;
  ownerCountEl.textContent = run.owner_count;
  seedParcelEl.textContent = run.seed_parcel_id || "(none)";
  summaryEl.textContent = run.summary || "";

  csvLink.href = `/api/runs/${run.id}/csv`;
  geojsonLink.href = `/api/runs/${run.id}/geojson`;

  renderParcels(run.parcels || []);
  renderTable(run.parcels || []);
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
    const response = await fetch("/api/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address,
        rings: Number(ringsInput.value),
        use_llm: Boolean(useLlmInput.checked),
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || "Lookup failed.");
    }

    renderRun(payload);
    const suffix = payload.status === "capped" ? " (capped by limits)" : "";
    setStatus(`Run ${payload.id} complete${suffix}.`);
  } catch (error) {
    runMetaEl.classList.add("hidden");
    clearMap();
    renderTable([]);
    setStatus(error.message || "Lookup failed.", true);
  } finally {
    setBusy(false);
  }
}

async function runLookupByPoint(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return;
  }

  setBusy(true);
  setStatus(`Running lookup at ${lat.toFixed(5)}, ${lon.toFixed(5)}...`);

  try {
    const response = await fetch("/api/lookup/point", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lat,
        lon,
        rings: Number(ringsInput.value),
        use_llm: Boolean(useLlmInput.checked),
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || "Lookup failed.");
    }

    renderRun(payload);
    const suffix = payload.status === "capped" ? " (capped by limits)" : "";
    setStatus(`Run ${payload.id} complete${suffix}.`);
  } catch (error) {
    runMetaEl.classList.add("hidden");
    clearMap();
    renderTable([]);
    setStatus(error.message || "Lookup failed.", true);
  } finally {
    setBusy(false);
  }
}

lookupButton.addEventListener("click", runLookup);
addressInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    runLookup();
  }
});

map.on("click", (event) => {
  if (lookupButton.disabled) {
    return;
  }
  runLookupByPoint(event.latlng.lat, event.latlng.lng);
});
