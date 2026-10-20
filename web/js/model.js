// The parcel and run model, defined once. Everything that builds, stores or
// reads a parcel or a run goes through these helpers, so adding a field is a
// change here (plus a RECORD_VERSION bump in store.js).
//
// Identity: a parcel ID is unique only within its county, so a parcel is
// identified by (county, parcel_id) everywhere: in the store, the caches and
// the runs.
//
// Vocabulary:
//   provider   - a county's parcel data source (BaseParcelProvider subclass)
//   source_id  - the provider's label, e.g. "wright_county_arcgis"
//   ring       - an adjacency ring: 0 is the seed, 1 its neighbors, ...
//                (polygon rings in geometry are always "polygon rings")
//   run        - one lookup: a seed parcel plus its adjacency rings

// How a parcel was found. A closed set; where it came from is in source_id.
export const MATCHED_BY = Object.freeze({
  ADDRESS: "address", // the county layer's own address fields
  ADDRESS_POINT: "address_point", // a county address point, then the parcel under it
  GEOCODE_POINT: "geocode_point", // geocoder point, then the parcel under it
  MAP_POINT: "map_point", // a map click
  CACHE_POINT: "cache_point", // a map click resolved from locally cached parcels
  ADJACENT: "adjacent", // touches/intersects a parcel in the previous ring
});

// A run's input: what the lookup started from.
//   {kind: "address", address} | {kind: "point", lat, lon} | {kind: "parcel", parcel_id}
export const addressInput = (address) => ({ kind: "address", address: String(address) });
export const pointInput = (lat, lon) => ({ kind: "point", lat, lon });
export const parcelInput = (parcelId) => ({ kind: "parcel", parcel_id: String(parcelId) });

export function inputLabel(input) {
  switch (input?.kind) {
    case "address":
      return input.address;
    case "point":
      return `${input.lat.toFixed(6)}, ${input.lon.toFixed(6)}`;
    case "parcel":
      return `parcel ${input.parcel_id}`;
    default:
      return "";
  }
}

// Trim, collapse whitespace, uppercase. The one normalization used for
// address cache keys, address queries and owner grouping.
export function normalizeText(value) {
  return String(value ?? "").trim().split(/\s+/).filter(Boolean).join(" ").toUpperCase();
}

// A parcel as a provider returns it and the store keeps it.
export function toParcel(src, overrides = {}) {
  const p = { ...src, ...overrides };
  return {
    county: String(p.county ?? ""),
    parcel_id: String(p.parcel_id ?? "").trim(),
    owner_name: String(p.owner_name ?? "").trim(),
    site_address: String(p.site_address ?? "").trim(),
    market_value: p.market_value ?? null,
    market_value_year: p.market_value_year || "",
    land_use: p.land_use || "",
    geometry: p.geometry ?? null,
    source_id: String(p.source_id ?? ""),
    matched_by: p.matched_by || "",
  };
}

// A parcel's place in a run: the parcel plus its ring, seed flag and
// normalized owner.
export function toRunParcel(src, { ring_number, is_seed, normalized_owner_name } = {}) {
  return {
    ...toParcel(src),
    ring_number: ring_number ?? src.ring_number ?? 0,
    is_seed: Boolean(is_seed ?? src.is_seed),
    normalized_owner_name: normalized_owner_name ?? src.normalized_owner_name ?? normalizeText(src.owner_name),
  };
}

// Unique owners among run parcels (normalized name, else the raw name).
export function countOwners(parcels) {
  const keys = new Set();
  for (const p of parcels) {
    const key = normalizeText(p.normalized_owner_name || p.owner_name);
    if (key) keys.add(key);
  }
  return keys.size;
}

// Run outcomes. "capped" runs hit a limit (capped_by) after finding a seed
// and keep the parcels collected so far.
export const RUN_STATUS = Object.freeze({
  COMPLETED: "completed",
  CAPPED: "capped",
  NOT_FOUND: "not_found",
  FAILED: "failed",
});

export const CAPPED_BY = Object.freeze({
  MAX_PARCELS: "max_parcels",
  REQUEST_BUDGET: "request_budget",
});

// Ring order, seed first within a ring, then parcel ID.
function compareRunParcels(a, b) {
  return (
    a.ring_number - b.ring_number ||
    (b.is_seed ? 1 : 0) - (a.is_seed ? 1 : 0) ||
    String(a.parcel_id).localeCompare(String(b.parcel_id))
  );
}

// A run: one lookup in one county, its input, outcome and run parcels.
export function toRun(fields, parcels = []) {
  const runParcels = parcels.map((p) => toRunParcel(p)).sort(compareRunParcels);
  const input = fields.input ?? null;
  return {
    id: fields.id ?? null,
    county: String(fields.county ?? ""),
    input,
    input_label: fields.input_label ?? inputLabel(input),
    rings_requested: fields.rings_requested,
    status: fields.status,
    capped_by: fields.capped_by ?? null,
    source_id: String(fields.source_id ?? ""),
    llm_enabled: Boolean(fields.llm_enabled),
    seed_parcel_id: fields.seed_parcel_id ?? null,
    summary: fields.summary ?? null,
    error: fields.error ?? null,
    created_at: fields.created_at,
    completed_at: fields.completed_at ?? null,
    parcel_count: runParcels.length,
    owner_count: countOwners(runParcels),
    parcels: runParcels,
    from_cache: Boolean(fields.from_cache),
  };
}
