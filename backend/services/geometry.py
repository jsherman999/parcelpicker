"""Esri <-> GeoJSON polygon conversion and point-in-polygon tests.

"Polygon ring" here means a closed line of a polygon's boundary (Esri
`rings`, GeoJSON coordinates). It is unrelated to the adjacency rings of a
lookup run.
"""

from __future__ import annotations

from typing import Any


def _signed_area(polygon_ring: list) -> float:
    """Shoelace area: negative for clockwise rings (Esri outer rings)."""
    area = 0.0
    count = len(polygon_ring)
    for i in range(count):
        x0, y0 = polygon_ring[i - 1][0], polygon_ring[i - 1][1]
        x1, y1 = polygon_ring[i][0], polygon_ring[i][1]
        area += x0 * y1 - x1 * y0
    return area / 2


def _point_in_polygon_ring(lon: float, lat: float, polygon_ring: list) -> bool:
    count = len(polygon_ring)
    if count < 3:
        return False
    inside = False
    j = count - 1
    for i in range(count):
        xi, yi = polygon_ring[i][0], polygon_ring[i][1]
        xj, yj = polygon_ring[j][0], polygon_ring[j][1]
        if ((yi > lat) != (yj > lat)) and (
            lon < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi
        ):
            inside = not inside
        j = i
    return inside


def _point_in_polygon(lon: float, lat: float, polygon: list) -> bool:
    if not polygon or not isinstance(polygon[0], list):
        return False
    if not _point_in_polygon_ring(lon, lat, polygon[0]):
        return False
    return not any(
        isinstance(hole, list) and _point_in_polygon_ring(lon, lat, hole)
        for hole in polygon[1:]
    )


def point_in_geometry(lon: float, lat: float, geometry: dict[str, Any] | None) -> bool:
    if not geometry or not isinstance(geometry.get("coordinates"), list):
        return False
    if geometry.get("type") == "Polygon":
        return _point_in_polygon(lon, lat, geometry["coordinates"])
    if geometry.get("type") == "MultiPolygon":
        return any(_point_in_polygon(lon, lat, poly) for poly in geometry["coordinates"])
    return False


def esri_to_geojson(geometry: dict[str, Any] | None) -> dict[str, Any] | None:
    """Esri polygon or point -> GeoJSON.

    Esri keeps every polygon ring of a multipart parcel in one `rings` list:
    outer rings clockwise, holes counter-clockwise. Several outer rings become
    a MultiPolygon, each hole going to the outer ring that contains it.
    Coordinate order is kept as-is.
    """
    if not geometry:
        return None
    if "x" in geometry and "y" in geometry:
        return {"type": "Point", "coordinates": [geometry["x"], geometry["y"]]}
    rings = geometry.get("rings")
    if not isinstance(rings, list) or not rings:
        return None

    outer_idx = [i for i, ring in enumerate(rings) if _signed_area(ring) < 0]
    if not outer_idx:
        # No clockwise ring: treat the first as the outer one.
        return {"type": "Polygon", "coordinates": rings}
    if len(outer_idx) == 1:
        first = outer_idx[0]
        holes = [ring for i, ring in enumerate(rings) if i != first]
        return {"type": "Polygon", "coordinates": [rings[first], *holes]}

    polygons = {i: [rings[i]] for i in outer_idx}
    for i, hole in enumerate(rings):
        if i in polygons:
            continue
        owner = next(
            (
                k
                for k in outer_idx
                if hole and _point_in_polygon_ring(hole[0][0], hole[0][1], rings[k])
            ),
            None,
        )
        if owner is None:
            preceding = [k for k in outer_idx if k < i]
            owner = preceding[-1] if preceding else outer_idx[0]
        polygons[owner].append(hole)
    return {"type": "MultiPolygon", "coordinates": [polygons[i] for i in outer_idx]}


def geojson_to_esri(geometry: dict[str, Any] | None) -> dict[str, Any] | None:
    """GeoJSON Polygon/MultiPolygon -> Esri polygon (rings flattened back)."""
    if not geometry or not isinstance(geometry.get("coordinates"), list):
        return None
    if geometry.get("type") == "Polygon":
        rings = geometry["coordinates"]
    elif geometry.get("type") == "MultiPolygon":
        rings = [ring for polygon in geometry["coordinates"] for ring in polygon]
    else:
        return None
    return {"rings": rings, "spatialReference": {"wkid": 4326}}
