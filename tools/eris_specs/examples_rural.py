"""Find a real, geocodable example address per county and verify the app's
geocode -> point-intersect path end to end.

usage: python3 -I examples_rural.py <verify.json> <tiger geojson> <out json> [fips ...]
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request

VER, TIGER, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
ONLY = set(sys.argv[4:])
UA = "parcelpicker-build/1.0 (+https://github.com/jsherman999/parcelpicker)"
MN_VIEWBOX = "-97.239209,49.384358,-89.491739,43.499356"
ABBR = {
    "Avenue": "Ave", "Street": "St", "Road": "Rd", "Drive": "Dr", "Lane": "Ln",
    "Boulevard": "Blvd", "Court": "Ct", "Circle": "Cir", "Trail": "Trl", "Place": "Pl",
    "Parkway": "Pkwy", "Highway": "Hwy", "Terrace": "Ter", "County": "County",
    "Northeast": "NE", "Northwest": "NW", "Southeast": "SE", "Southwest": "SW",
    "North": "N", "South": "S", "East": "E", "West": "W",
}
_last = [0.0]


def nominatim(path, params):
    wait = 1.1 - (time.time() - _last[0])
    if wait > 0:
        time.sleep(wait)
    _last[0] = time.time()
    req = urllib.request.Request(f"https://nominatim.openstreetmap.org/{path}?{urllib.parse.urlencode(params)}",
                                 headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


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


def abbreviate(road):
    return " ".join(ABBR.get(w, w) for w in road.split())


def point_hit(r, lon, lat):
    f = r["fields"]
    flt = r.get("filter")
    where = f"(1=1) AND ({flt})" if flt else "1=1"
    q = urllib.parse.urlencode({
        "f": "json", "where": where, "geometry": f"{lon},{lat}", "geometryType": "esriGeometryPoint",
        "spatialRel": "esriSpatialRelIntersects", "inSR": "4326", "outFields": f"{f['apn']},{f['owner']}",
        "returnGeometry": "false",
    })
    d = json.load(urllib.request.urlopen(r["url"] + "/query?" + q, timeout=40))
    for ft in d.get("features") or []:
        a = ft["attributes"]
        if str(a.get(f["apn"]) or "").strip():
            return {"apn": a.get(f["apn"]), "owner": str(a.get(f["owner"]) or "").strip()}
    return None


def candidates(r, geom):
    # test parcel point first, then a small spiral around it, then the TIGER interior point
    x, y = r["test_point"]
    yield x, y
    for dx, dy in [(0.01, 0), (-0.01, 0), (0, 0.01), (0, -0.01), (0.03, 0.03), (-0.03, -0.03)]:
        yield x + dx, y + dy


def main():
    tiger = {ft["properties"]["GEOID"]: ft for ft in json.load(open(TIGER))["features"]}
    rows = [r for r in json.load(open(VER)) if not r.get("fatal") and r["fips"] != "27153"]
    out = {}
    for r in rows:
        if ONLY and r["fips"] not in ONLY:
            continue
        geom = tiger[r["fips"]]["geometry"]
        result = {"name": r["name"]}
        for lon, lat in candidates(r, geom):
            rev = nominatim("reverse", {"lat": lat, "lon": lon, "format": "jsonv2", "zoom": "18", "addressdetails": "1"})
            a = rev.get("address") or {}
            if not (a.get("house_number") and a.get("road")):
                continue
            place = a.get("city") or a.get("town") or a.get("village") or a.get("hamlet") or ""
            addr = f"{a['house_number']} {abbreviate(a['road'])}" + (f" {place}" if place else "") + " MN" + (f" {a['postcode']}" if a.get("postcode") else "")
            fwd = nominatim("search", {"q": addr, "format": "jsonv2", "limit": "1", "countrycodes": "us",
                                       "addressdetails": "0", "viewbox": MN_VIEWBOX, "bounded": "1"})
            if not fwd:
                result.setdefault("rejected", []).append(f"{addr}: no forward geocode")
                continue
            glon, glat = float(fwd[0]["lon"]), float(fwd[0]["lat"])
            if not in_county(glon, glat, geom):
                result.setdefault("rejected", []).append(f"{addr}: geocodes outside county")
                continue
            hit = point_hit(r, glon, glat)
            if not hit or not hit["owner"]:
                result.setdefault("rejected", []).append(f"{addr}: no owner-filled parcel at geocode ({hit})")
                continue
            result.update({"placeholder": addr, "geocode": [glon, glat], "hit": hit})
            break
        out[r["fips"]] = result
        print(r["fips"], r["name"], "->", result.get("placeholder") or "NONE", result.get("hit") or result.get("rejected"), flush=True)
    json.dump(out, open(OUT, "w"), indent=1)


main()
