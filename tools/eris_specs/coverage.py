"""Coverage probe: fraction of grid points (rural) and incorporated-place
interior points (towns) inside each county that intersect any parcel.

usage: python3 -I coverage.py <verify.json> <tiger geojson> <out json>
"""
import json
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

VER, TIGER, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
PLACES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/4/query"


def ring_contains(lon, lat, ring):
    inside, j = False, len(ring) - 1
    for i in range(len(ring)):
        xi, yi, xj, yj = ring[i][0], ring[i][1], ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def in_county(lon, lat, geom):
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    return any(ring_contains(lon, lat, p[0]) and not any(ring_contains(lon, lat, h) for h in p[1:]) for p in polys)


def bbox(geom):
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    xs = [p[0] for poly in polys for p in poly[0]]
    ys = [p[1] for poly in polys for p in poly[0]]
    return min(xs), min(ys), max(xs), max(ys)


def hit(r, lon, lat):
    f = r["fields"]
    flt = r.get("filter")
    q = urllib.parse.urlencode({
        "f": "json", "where": f"(1=1) AND ({flt})" if flt else "1=1", "geometry": f"{lon},{lat}",
        "geometryType": "esriGeometryPoint", "spatialRel": "esriSpatialRelIntersects", "inSR": "4326",
        "outFields": f"{f['apn']},{f['owner']}", "returnGeometry": "false",
    })
    for attempt in range(3):
        try:
            d = json.load(urllib.request.urlopen(r["url"] + "/query?" + q, timeout=40))
            feats = [x for x in d.get("features") or [] if str(x["attributes"].get(f["apn"]) or "").strip()]
            if not feats:
                return "miss"
            return "owner" if str(feats[0]["attributes"].get(f["owner"]) or "").strip() not in ("", "0") else "blank"
        except Exception:  # noqa: BLE001
            pass
    return "error"


def probe(args):
    r, geom = args
    x0, y0, x1, y1 = bbox(geom)
    grid = []
    n = 7
    for i in range(n):
        for j in range(n):
            lon = x0 + (x1 - x0) * (i + 0.5) / n
            lat = y0 + (y1 - y0) * (j + 0.5) / n
            if in_county(lon, lat, geom):
                grid.append((lon, lat))
    q = urllib.parse.urlencode({
        "f": "json", "where": "STATE='27'", "geometry": f"{x0},{y0},{x1},{y1}", "geometryType": "esriGeometryEnvelope",
        "inSR": "4326", "spatialRel": "esriSpatialRelIntersects", "outFields": "BASENAME,INTPTLAT,INTPTLON",
        "returnGeometry": "false",
    })
    towns = []
    for ft in json.load(urllib.request.urlopen(PLACES + "?" + q, timeout=60)).get("features") or []:
        a = ft["attributes"]
        lon, lat = float(a["INTPTLON"]), float(a["INTPTLAT"])
        if in_county(lon, lat, geom):
            towns.append((a["BASENAME"], lon, lat))
    g = [hit(r, lon, lat) for lon, lat in grid]
    t = [(name, hit(r, lon, lat)) for name, lon, lat in towns]
    return {
        "fips": r["fips"], "name": r["name"],
        "grid": {k: g.count(k) for k in ("owner", "blank", "miss", "error")},
        "towns": {k: sum(1 for _, v in t if v == k) for k in ("owner", "blank", "miss", "error")},
        "town_misses": [name for name, v in t if v == "miss"],
    }


def main():
    tiger = {ft["properties"]["GEOID"]: ft for ft in json.load(open(TIGER))["features"]}
    rows = [r for r in json.load(open(VER)) if not r.get("fatal") and r["fips"] != "27153"]
    out = []
    with ThreadPoolExecutor(6) as ex:
        for res in ex.map(probe, [(r, tiger[r["fips"]]["geometry"]) for r in rows]):
            out.append(res)
            print(res["fips"], res["name"], "grid", res["grid"], "towns", res["towns"], res["town_misses"][:6], flush=True)
    json.dump(out, open(OUT, "w"), indent=1)


main()
