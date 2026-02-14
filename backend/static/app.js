const map = L.map("map").setView([45.20, -93.95], 11);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 20,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const addressInput = document.getElementById("address");
const lookupButton = document.getElementById("lookup");
const statusEl = document.getElementById("status");
const detailsEl = document.getElementById("details");

const parcelIdEl = document.getElementById("parcel-id");
const ownerEl = document.getElementById("owner");
const siteAddressEl = document.getElementById("site-address");
const matchedByEl = document.getElementById("matched-by");
const sourceEl = document.getElementById("source");

let activeLayer = null;

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "#8a1f1f" : "#5f736a";
}

function setBusy(isBusy) {
  lookupButton.disabled = isBusy;
  lookupButton.textContent = isBusy ? "Looking up..." : "Lookup";
}

function renderGeometry(geometry) {
  if (activeLayer) {
    map.removeLayer(activeLayer);
    activeLayer = null;
  }

  if (!geometry) {
    return;
  }

  activeLayer = L.geoJSON(geometry, {
    style: {
      color: "#176b48",
      weight: 2,
      fillColor: "#49b27d",
      fillOpacity: 0.28,
    },
  }).addTo(map);

  const bounds = activeLayer.getBounds();
  if (bounds.isValid()) {
    map.fitBounds(bounds.pad(0.25));
  }
}

async function runLookup() {
  const address = addressInput.value.trim();
  if (!address) {
    setStatus("Enter an address first.", true);
    return;
  }

  setBusy(true);
  setStatus("Searching Wright County parcels...");

  try {
    const response = await fetch("/api/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || "Lookup failed.");
    }

    parcelIdEl.textContent = payload.parcel_id || "(not found)";
    ownerEl.textContent = payload.owner_name || "(not found)";
    siteAddressEl.textContent = payload.site_address || "(not found)";
    matchedByEl.textContent = payload.matched_by;
    sourceEl.textContent = payload.source;
    detailsEl.classList.remove("hidden");

    renderGeometry(payload.geometry);
    setStatus("Lookup complete.");
  } catch (error) {
    detailsEl.classList.add("hidden");
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
