// Geometry helpers. All coordinates are [lon, lat] (EPSG:4326). "Polygon
// ring" here means a closed coordinate list, not an adjacency ring.

// Signed shoelace area of a polygon ring: negative for clockwise.
export function polygonRingSignedArea(ring) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return area / 2;
}

// Ray casting; true when (lon, lat) is inside the polygon ring.
export function pointInPolygonRing(lon, lat, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Inside the outer polygon ring and outside every hole.
function pointInPolygon(lon, lat, polygonRings) {
  if (!Array.isArray(polygonRings) || !pointInPolygonRing(lon, lat, polygonRings[0])) return false;
  return !polygonRings.slice(1).some((hole) => pointInPolygonRing(lon, lat, hole));
}

// Polygon or MultiPolygon.
export function pointInGeometry(lon, lat, geometry) {
  if (!geometry || !Array.isArray(geometry.coordinates)) return false;
  if (geometry.type === "Polygon") return pointInPolygon(lon, lat, geometry.coordinates);
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.some((poly) => pointInPolygon(lon, lat, poly));
  }
  return false;
}

// Esri polygon rings -> GeoJSON. Esri lists every polygon ring of a
// multipart parcel in one array: outer rings run clockwise, holes
// counter-clockwise. One outer ring gives a Polygon; several give a
// MultiPolygon, each hole attached to the outer ring that contains it.
// Coordinate order is kept as-is. If no ring is clockwise (a server that
// ignores the convention), the first ring is the outer one.
function esriPolygonToGeoJson(polygonRings) {
  const rings = polygonRings.filter((r) => Array.isArray(r) && r.length >= 3);
  if (!rings.length) return null;
  const isOuter = rings.map((r) => polygonRingSignedArea(r) < 0);
  if (!isOuter.some(Boolean)) return { type: "Polygon", coordinates: rings };

  const polygons = [];
  const holes = [];
  rings.forEach((ring, i) => {
    if (isOuter[i]) polygons.push([ring]);
    else holes.push({ ring, after: polygons.length - 1 });
  });
  for (const { ring, after } of holes) {
    const [lon, lat] = ring[0];
    const owner =
      polygons.find((poly) => pointInPolygonRing(lon, lat, poly[0])) ||
      polygons[Math.max(after, 0)];
    owner.push(ring);
  }
  return polygons.length === 1
    ? { type: "Polygon", coordinates: polygons[0] }
    : { type: "MultiPolygon", coordinates: polygons };
}

export function esriToGeoJson(geometry) {
  if (!geometry) return null;
  if (Array.isArray(geometry.rings)) return esriPolygonToGeoJson(geometry.rings);
  if ("x" in geometry && "y" in geometry) {
    return { type: "Point", coordinates: [geometry.x, geometry.y] };
  }
  return null;
}

// GeoJSON Polygon/MultiPolygon -> Esri polygon (rings flattened back).
export function geoJsonToEsri(geojson) {
  if (!geojson || !Array.isArray(geojson.coordinates)) return null;
  let rings;
  if (geojson.type === "Polygon") rings = geojson.coordinates;
  else if (geojson.type === "MultiPolygon") rings = geojson.coordinates.flat();
  else return null;
  return { rings, spatialReference: { wkid: 4326 } };
}
