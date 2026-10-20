// Client-side CSV / GeoJSON export. Replaces the backend
// /api/runs/{id}/csv and /api/runs/{id}/geojson routes from main.py.

function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function runToCsv(run) {
  const header = [
    "run_id",
    "county",
    "ring_number",
    "is_seed",
    "parcel_id",
    "owner_name",
    "normalized_owner_name",
    "site_address",
    "est_market_value",
    "market_value_year",
    "land_use",
    "matched_by",
    "source_id",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const p of run.parcels || []) {
    lines.push(
      [
        run.id,
        run.county ?? "",
        p.ring_number ?? "",
        p.is_seed ? 1 : 0,
        p.parcel_id ?? "",
        p.owner_name ?? "",
        p.normalized_owner_name ?? "",
        p.site_address ?? "",
        p.market_value ?? "",
        p.market_value_year ?? "",
        p.land_use ?? "",
        p.matched_by ?? "",
        p.source_id ?? "",
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\r\n");
}

export function runToGeoJson(run) {
  const features = [];
  for (const p of run.parcels || []) {
    if (!p.geometry) continue;
    features.push({
      type: "Feature",
      geometry: p.geometry,
      properties: {
        run_id: run.id,
        county: run.county,
        ring_number: p.ring_number,
        is_seed: p.is_seed,
        parcel_id: p.parcel_id,
        owner_name: p.owner_name,
        normalized_owner_name: p.normalized_owner_name,
        site_address: p.site_address,
        est_market_value: p.market_value ?? null,
        market_value_year: p.market_value_year || null,
        land_use: p.land_use || null,
        matched_by: p.matched_by,
        source_id: p.source_id,
      },
    });
  }
  return { type: "FeatureCollection", name: `run_${run.id}`, features };
}

export function downloadText(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
