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
const locateMeButton = document.getElementById("locate-me");
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
const propertyLinksEl = document.getElementById("property-links");
const linksContextEl = document.getElementById("links-context");
const linkListEl = document.getElementById("link-list");

const ringColors = {
  0: "#1a6f4b",
  1: "#2d4f9a",
  2: "#b76a22",
};

let layers = [];
let userLocationMarker = null;

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "var(--error)" : "var(--muted)";
}

function setBusy(isBusy) {
  lookupButton.disabled = isBusy;
  locateMeButton.disabled = isBusy;
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

function buildPropertyLinks(run, seedParcel) {
  const parcelId = seedParcel?.parcel_id || "";
  const siteAddress = seedParcel?.site_address || "";
  const inputAddress = (run.input_address || "").startsWith("POINT(")
    ? ""
    : run.input_address || "";
  const query = (inputAddress || siteAddress || parcelId).trim();
  if (!query) {
    return [];
  }

  const zillowQuery = `${query} Wright County MN`.trim();
  const where = parcelId ? `PID='${parcelId.replace(/'/g, "''")}'` : "";

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
      label: "Wright Property Search",
      href: "https://propertyaccess.co.wright.mn.us/search/commonsearch.aspx?mode=combined",
      primary: false,
    },
  ];

  if (where) {
    links.push({
      label: "Wright Parcel JSON",
      href:
        "https://web.co.wright.mn.us/arcgisserver/rest/services/Wright_County_Parcels/MapServer/1/query" +
        `?f=pjson&where=${encodeURIComponent(where)}&outFields=PID,OWNNAME,PHYSADDR&returnGeometry=true&outSR=4326`,
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
  runMetaEl.classList.remove("hidden");
  runIdEl.textContent = run.id;
  runStatusEl.textContent = run.from_cache ? `${run.status} (cache)` : run.status;
  parcelCountEl.textContent = run.parcel_count;
  ownerCountEl.textContent = run.owner_count;
  seedParcelEl.textContent = run.seed_parcel_id || "(none)";
  summaryEl.textContent = run.summary || "";

  csvLink.href = `/api/runs/${run.id}/csv`;
  geojsonLink.href = `/api/runs/${run.id}/geojson`;

  // If the run came from a map click, preload the detected parcel address so
  // the normal address-based "Run Lookup" flow can be used immediately.
  const seedParcel = (run.parcels || []).find((parcel) => parcel.is_seed);
  const detectedAddress = (seedParcel && seedParcel.site_address) || "";
  if (detectedAddress && String(run.input_address || "").startsWith("POINT(")) {
    addressInput.value = detectedAddress;
  }

  renderPropertyLinks(run);
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
    const cacheSuffix = payload.from_cache ? " (loaded from 30-day cache)" : "";
    setStatus(`Run ${payload.id} complete${suffix}${cacheSuffix}.`);
  } catch (error) {
    runMetaEl.classList.add("hidden");
    propertyLinksEl.classList.add("hidden");
    linkListEl.innerHTML = "";
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
    const cacheSuffix = payload.from_cache ? " (loaded from 30-day cache)" : "";
    setStatus(`Run ${payload.id} complete${suffix}${cacheSuffix}.`);
  } catch (error) {
    runMetaEl.classList.add("hidden");
    propertyLinksEl.classList.add("hidden");
    linkListEl.innerHTML = "";
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

function locateMe() {
  if (!navigator.geolocation) {
    setStatus("Geolocation is not supported by this browser.", true);
    return;
  }

  setBusy(true);
  setStatus("Requesting your location...");

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const lat = position.coords.latitude;
      const lon = position.coords.longitude;

      // Show user location on map
      if (userLocationMarker) {
        map.removeLayer(userLocationMarker);
      }
      userLocationMarker = L.circleMarker([lat, lon], {
        radius: 8,
        color: "#ff3b6f",
        fillColor: "#ff3b6f",
        fillOpacity: 0.85,
        weight: 2,
      })
        .addTo(map)
        .bindPopup("Your location");

      // Default to 2-ring scan for geo-located lookups
      ringsInput.value = "2";

      setBusy(false);
      runLookupByPoint(lat, lon);
    },
    (error) => {
      setBusy(false);
      const messages = {
        1: "Location permission denied. Allow location access and try again.",
        2: "Location unavailable. Make sure GPS/location services are enabled.",
        3: "Location request timed out. Try again.",
      };
      setStatus(messages[error.code] || "Could not determine location.", true);
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
}

locateMeButton.addEventListener("click", locateMe);
