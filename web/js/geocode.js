// Address -> point geocoder. Replaces the Census geocoder (which failed CORS)
// with Nominatim/OpenStreetMap, which sends Access-Control-Allow-Origin: * and
// is already our basemap tile source.
//
// Nominatim usage policy: <= 1 request/second and a descriptive client. We
// enforce a >= 1.1s gap here. Results are bounded to a Minnesota viewbox to
// improve match accuracy for this MN-only app.

import { sleep, fetchWithTimeout } from "./util.js";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const MIN_GEOCODE_INTERVAL_MS = 1100;

// Minnesota bounding box: west, north, east, south (lon/lat).
const MN_VIEWBOX = "-97.239209,49.384358,-89.491739,43.499356";

let lastGeocodeAt = 0;

// Simple in-memory cache so repeated lookups in a session don't re-hit Nominatim.
const cache = new Map();

export async function geocodeAddress(address, { timeoutMs = 20000 } = {}) {
  const key = (address || "").trim().toUpperCase();
  if (!key) return null;
  if (cache.has(key)) return cache.get(key);

  const wait = MIN_GEOCODE_INTERVAL_MS - (Date.now() - lastGeocodeAt);
  if (wait > 0) await sleep(wait);
  lastGeocodeAt = Date.now();

  const params = new URLSearchParams({
    q: address,
    format: "jsonv2",
    limit: "1",
    countrycodes: "us",
    addressdetails: "0",
    viewbox: MN_VIEWBOX,
    bounded: "1",
  });

  let result = null;
  try {
    const res = await fetchWithTimeout(
      `${NOMINATIM_URL}?${params.toString()}`,
      { headers: { Accept: "application/json" } },
      timeoutMs
    );
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length) {
        const lon = parseFloat(data[0].lon);
        const lat = parseFloat(data[0].lat);
        if (Number.isFinite(lon) && Number.isFinite(lat)) {
          result = {
            lon,
            lat,
            matchedAddress: String(data[0].display_name || "").trim(),
          };
        }
      }
    }
  } catch (err) {
    // Network/CORS/timeout — treat as "no geocode" and let the caller fall back.
    result = null;
  }

  cache.set(key, result);
  return result;
}
