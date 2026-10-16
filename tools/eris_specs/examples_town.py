"""Pass 2: for counties with no example address yet, search inside the
county's largest incorporated places (TIGER), where OSM buildings carry
addresses, and verify geocode -> owner-filled point intersect.

usage: python3 -I examples_town.py <verify.json> <tiger geojson> <examples.json (updated in place)> [fips ...]
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request

VER, TIGER, PH = sys.argv[1], sys.argv[2], sys.argv[3]
ONLY = set(sys.argv[4:])
SKIP = {"549 Madson Ave SW Hutchinson MN 55350"}  # geocodes onto a lot line
# Owners that mean the geocode landed on right-of-way, not the addressed lot.
JUNK_OWNER = re.compile(r"\b(ROW|R/W|STREETS?|ROADS?|HWY|HIGHWAY|RAILROAD|RAILWAY|DEDICATED)\b", re.I)
UA = "parcelpicker-build/1.0 (+https://github.com/jsherman999/parcelpicker)"
MN_VIEWBOX = "-97.239209,49.384358,-89.491739,43.499356"
PLACES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/4/query"
ABBR = {
    "Avenue": "Ave", "Street": "St", "Road": "Rd", "Drive": "Dr", "Lane": "Ln",
    "Boulevard": "Blvd", "Court": "Ct", "Circle": "Cir", "Trail": "Trl", "Place": "Pl",
    "Parkway": "Pkwy", "Highway": "Hwy", "Terrace": "Ter",
    "Northeast": "NE", "Northwest": "NW", "Southeast": "SE", "Southwest": "SW",
    "North": "N", "South": "S", "East": "E", "West": "W",
}
OFFSETS = [(0, 0), (0.002, 0), (-0.002, 0), (0, 0.002), (0, -0.002), (0.004, 0.003), (-0.004, -0.003)]
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


def bbox(geom):
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    xs = [p[0] for poly in polys for p in poly[0]]
    ys = [p[1] for poly in polys for p in poly[0]]
    return min(xs), min(ys), max(xs), max(ys)


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


def places_in(geom):
    x0, y0, x1, y1 = bbox(geom)
    q = urllib.parse.urlencode({
        "f": "json", "where": "STATE='27'", "geometry": f"{x0},{y0},{x1},{y1}", "geometryType": "esriGeometryEnvelope",
        "inSR": "4326", "spatialRel": "esriSpatialRelIntersects", "outFields": "BASENAME,AREALAND,INTPTLAT,INTPTLON",
        "returnGeometry": "false",
    })
    d = json.load(urllib.request.urlopen(PLACES + "?" + q, timeout=60))
    out = []
    for ft in d.get("features") or []:
        a = ft["attributes"]
        lon, lat = float(a["INTPTLON"]), float(a["INTPTLAT"])
        if in_county(lon, lat, geom):
            out.append((int(a["AREALAND"] or 0), a["BASENAME"], lon, lat))
    return sorted(out, reverse=True)[:3]


def main():
    tiger = {ft["properties"]["GEOID"]: ft for ft in json.load(open(TIGER))["features"]}
    ver = {r["fips"]: r for r in json.load(open(VER))}
    ph = json.load(open(PH))
    for fips, res0 in sorted(ph.items()):
        if ONLY and fips not in ONLY:
            continue
        res = {}
        r = ver[fips]
        geom = tiger[fips]["geometry"]
        done = False
        for _, town, plon, plat in places_in(geom):
            for dx, dy in OFFSETS:
                rev = nominatim("reverse", {"lat": plat + dy, "lon": plon + dx, "format": "jsonv2", "zoom": "18", "addressdetails": "1"})
                a = rev.get("address") or {}
                if not (a.get("house_number") and a.get("road")) or ";" in a["house_number"]:
                    continue
                # only addresses carried by an OSM building or address point
                if not (rev.get("category") == "building" or (rev.get("category") == "place" and rev.get("type") == "house")):
                    continue
                words = a["road"].split()
                # "South Street" stays "South St": a lone directional is the street name.
                road = " ".join(w if len(words) == 2 and i == 0 else ABBR.get(w, w) for i, w in enumerate(words))
                addr = f"{a['house_number']} {road} {town} MN" + (f" {a['postcode']}" if a.get("postcode") else "")
                if addr in SKIP:
                    continue
                fwd = nominatim("search", {"q": addr, "format": "jsonv2", "limit": "1", "countrycodes": "us",
                                           "addressdetails": "0", "viewbox": MN_VIEWBOX, "bounded": "1"})
                if not fwd:
                    res.setdefault("rejected", []).append(f"{addr}: no forward geocode")
                    continue
                if (fwd[0].get("osm_type"), fwd[0].get("osm_id")) != (rev.get("osm_type"), rev.get("osm_id")):
                    res.setdefault("rejected", []).append(f"{addr}: forward geocode resolves to a different OSM object")
                    continue
                glon, glat = float(fwd[0]["lon"]), float(fwd[0]["lat"])
                if not in_county(glon, glat, geom):
                    res.setdefault("rejected", []).append(f"{addr}: geocodes outside county")
                    continue
                hit = point_hit(r, glon, glat)
                if not hit or not hit["owner"] or JUNK_OWNER.search(hit["owner"]) or "1/2th" in addr:
                    res.setdefault("rejected", []).append(f"{addr}: no owner-filled parcel at geocode ({hit})")
                    continue
                res.update({"placeholder": addr, "geocode": [glon, glat], "hit": hit})
                done = True
                break
            if done:
                break
        res0["town"] = res
        print(fips, r["name"], "->", res.get("placeholder") or "NONE", res.get("hit") or res.get("rejected", [])[-3:], flush=True)
        json.dump(ph, open(PH, "w"), indent=1)


main()
