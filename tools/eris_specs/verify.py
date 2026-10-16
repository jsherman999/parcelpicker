"""Live-verify ErisData MN parcel adapter specs for parcelpicker's browser build.

usage: python3 -I verify.py <ErisData dir> <tiger geojson> <out json> [fips ...]

For each candidate county (not already hand-written in parcelpicker), checks:
  - layer metadata reachable over https; spec fields exist (canonical case)
  - CORS: Access-Control-Allow-Origin for https://jsherman999.github.io and
    http://localhost:8427 on real query requests
  - owner fill rate (returnCountOnly)
  - point intersect (exactly as BaseParcelProvider._queryByPoint) at an
    interior point of an owner-filled parcel returns a parcel with owner set,
    and that point lies inside the county's TIGER boundary
  - adjacency query (as queryAdjacent) returns neighbors
  - address field samples, for manual full/partial/mailing classification
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ERIS, TIGER, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
ONLY = set(sys.argv[4:])

GH = "https://jsherman999.github.io"
LOCAL = "http://localhost:8427"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
EXISTING = {
    "27001", "27003", "27007", "27019", "27025", "27037", "27053", "27071",
    "27097", "27109", "27123", "27137", "27139", "27141", "27163", "27171",
}
UNAVAILABLE = {"27067", "27069", "27127", "27133"}


def get(url, params=None, origin=GH, timeout=40):
    full = url + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(full, headers={"Origin": origin, "User-Agent": UA})
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
                return {
                    "status": r.status,
                    "acao": r.headers.get("Access-Control-Allow-Origin"),
                    "json": json.loads(body.decode("utf-8", "replace")),
                    "url_len": len(full),
                }
        except urllib.error.HTTPError as e:
            last = {"status": e.code, "acao": e.headers.get("Access-Control-Allow-Origin"),
                    "error": f"HTTP {e.code}", "url_len": len(full)}
            if e.code < 500 and e.code != 429:
                return last
        except Exception as e:  # noqa: BLE001
            last = {"status": None, "acao": None, "error": f"{type(e).__name__}: {e}", "url_len": len(full)}
        time.sleep(1.5 * (attempt + 1))
    return last


def cors_ok(acao, origin):
    return acao in ("*", origin)


def ring_contains(lon, lat, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def esri_rings_contain(lon, lat, rings):
    # Esri rings: even-odd over all rings handles holes and multipart.
    inside = False
    for r in rings:
        if ring_contains(lon, lat, r):
            inside = not inside
    return inside


def geojson_contains(lon, lat, geom):
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    for poly in polys:
        if poly and ring_contains(lon, lat, poly[0]) and not any(ring_contains(lon, lat, h) for h in poly[1:]):
            return True
    return False


def interior_point(rings):
    """Point inside an Esri polygon: scanline through the bbox middle of the
    largest ring, midpoint of the widest inside interval."""
    def area(r):
        return abs(sum(r[i - 1][0] * r[i][1] - r[i][0] * r[i - 1][1] for i in range(len(r))) / 2)
    big = max(rings, key=area)
    ys = [p[1] for p in big]
    for frac in (0.5, 0.37, 0.63, 0.25, 0.75):
        y = min(ys) + (max(ys) - min(ys)) * frac
        xs = []
        for r in rings:
            for i in range(len(r)):
                (x1, y1), (x2, y2) = r[i - 1][:2], r[i][:2]
                if (y1 > y) != (y2 > y):
                    xs.append(x1 + (y - y1) * (x2 - x1) / (y2 - y1))
        xs.sort()
        best = None
        for k in range(0, len(xs) - 1, 2):
            w = xs[k + 1] - xs[k]
            if best is None or w > best[0]:
                best = (w, (xs[k] + xs[k + 1]) / 2)
        if best and esri_rings_contain(best[1], y, rings):
            return best[1], y
    return None


def blank(v):
    return v is None or str(v).strip() == ""


def verify(fips, aid, tiger_by_fips):
    spec = json.load(open(f"{ERIS}/GIS/parcels/adapters/{aid}.json"))
    f = spec["fields"]
    res = {"fips": fips, "adapter": aid, "spec_url": spec["source"]["url"], "filter": spec.get("filter"),
           "spec_fields": f, "problems": [], "notes": spec.get("notes", "")}
    url = spec["source"]["url"]
    if url.startswith("http://"):
        https = "https://" + url[len("http://"):]
        m = get(https, {"f": "json"}, timeout=25)
        if m.get("json") and "error" not in m["json"]:
            res["problems"].append("spec url is http; https variant works")
            url = https
        else:
            res["problems"].append(f"http-only endpoint (https failed: {m.get('error') or m.get('json', {}).get('error')}) -> mixed content on GitHub Pages")
            res["fatal"] = "http-only (mixed content blocked on https Pages)"
            return res
    res["url"] = url
    if not f.get("owner"):
        res["fatal"] = "spec has no owner field"
        return res

    meta = get(url, {"f": "json"})
    if not meta.get("json") or "error" in meta["json"]:
        res["fatal"] = f"metadata failed: {meta.get('error') or meta['json'].get('error')}"
        return res
    mj = meta["json"]
    res["meta"] = {
        "name": mj.get("name"), "geometryType": mj.get("geometryType"),
        "maxRecordCount": mj.get("maxRecordCount"), "currentVersion": mj.get("currentVersion"),
        "supportsPagination": (mj.get("advancedQueryCapabilities") or {}).get("supportsPagination"),
        "capabilities": mj.get("capabilities"),
    }
    names = {fl["name"].lower(): fl["name"] for fl in mj.get("fields") or []}
    canon = {}
    for key in ("apn", "owner", "address"):
        v = f.get(key)
        if not v:
            continue
        if v.lower() not in names:
            res["problems"].append(f"field {key}={v} not in layer")
            if key != "address":
                res["fatal"] = f"{key} field {v} missing from layer"
                return res
            continue
        canon[key] = names[v.lower()]
        if canon[key] != v:
            res["problems"].append(f"field case {v} -> {canon[key]}")
    res["fields"] = canon
    apn, owner, addr = canon["apn"], canon["owner"], canon.get("address")
    flt = spec.get("filter")

    def W(where):
        return f"({where}) AND ({flt})" if flt else where

    out_fields = ",".join(x for x in (apn, owner, addr) if x)

    # owner fill rate
    tot = get(url + "/query", {"f": "json", "where": W("1=1"), "returnCountOnly": "true"}, origin=LOCAL)
    filled = get(url + "/query", {"f": "json", "where": W(f"{owner} IS NOT NULL AND {owner} <> ''"), "returnCountOnly": "true"})
    res["cors_local"] = tot.get("acao")
    try:
        res["count_total"] = tot["json"]["count"]
        res["count_owner"] = filled["json"]["count"]
    except Exception:  # noqa: BLE001
        res["problems"].append(f"count query failed: {tot.get('error') or tot.get('json')} / {filled.get('error') or filled.get('json')}")

    # sample owner-filled parcels with geometry
    samp = get(url + "/query", {
        "f": "json", "where": W(f"{owner} IS NOT NULL AND {owner} <> ''"), "outFields": out_fields,
        "returnGeometry": "true", "outSR": "4326", "resultRecordCount": "10",
    })
    feats = (samp.get("json") or {}).get("features") or []
    if not feats:
        res["fatal"] = f"no owner-filled sample features: {samp.get('error') or str(samp.get('json'))[:200]}"
        return res
    county_geom = tiger_by_fips[fips]["geometry"]
    pt = None
    for ft in feats:
        g = ft.get("geometry") or {}
        if g.get("rings") and not blank(ft["attributes"].get(apn)):
            p = interior_point(g["rings"])
            if p and geojson_contains(p[0], p[1], county_geom):
                pt = p
                break
    if not pt:
        # fall back: any interior point even if outside county (records offset problems)
        for ft in feats:
            g = ft.get("geometry") or {}
            if g.get("rings"):
                pt = interior_point(g["rings"])
                if pt:
                    res["problems"].append("sample parcel interior point is OUTSIDE the county boundary")
                    break
    if not pt:
        res["fatal"] = "could not derive an interior test point"
        return res
    res["test_point"] = [round(pt[0], 6), round(pt[1], 6)]
    res["point_in_county"] = geojson_contains(pt[0], pt[1], county_geom)

    # point intersect exactly as BaseParcelProvider._queryByPoint
    pq = get(url + "/query", {
        "f": "json", "where": W("1=1"), "geometry": f"{pt[0]},{pt[1]}",
        "geometryType": "esriGeometryPoint", "spatialRel": "esriSpatialRelIntersects", "inSR": "4326",
        "outFields": out_fields, "returnGeometry": "true", "outSR": "4326",
    })
    res["cors_gh"] = pq.get("acao")
    pf = [x for x in ((pq.get("json") or {}).get("features") or []) if not blank(x["attributes"].get(apn))]
    if not pf:
        res["fatal"] = f"point intersect returned no parcel: {pq.get('error') or str(pq.get('json'))[:200]}"
        return res
    hit = pf[0]
    res["point_hit"] = {k: hit["attributes"].get(v) for k, v in canon.items()}
    if blank(hit["attributes"].get(owner)):
        res["fatal"] = "point intersect parcel has blank owner"
        return res

    # adjacency as queryAdjacent (GET, esri polygon in URL, resultRecordCount=50)
    esri = {"rings": hit["geometry"]["rings"], "spatialReference": {"wkid": 4326}}
    aq = get(url + "/query", {
        "f": "json", "where": W("1=1"), "geometry": json.dumps(esri, separators=(",", ":")),
        "geometryType": "esriGeometryPolygon", "spatialRel": "esriSpatialRelIntersects", "inSR": "4326",
        "outFields": out_fields, "returnGeometry": "true", "outSR": "4326", "resultRecordCount": "50",
    })
    af = (aq.get("json") or {}).get("features")
    res["adjacent"] = {"count": len(af) if af is not None else None, "url_len": aq.get("url_len"),
                       "error": aq.get("error") or (aq.get("json") or {}).get("error")}
    if af is None:
        res["problems"].append(f"adjacency query failed: {res['adjacent']['error']}")

    # address samples
    if addr:
        aq2 = get(url + "/query", {
            "f": "json", "where": W(f"{addr} IS NOT NULL AND {addr} <> ''"), "outFields": addr,
            "returnGeometry": "false", "resultRecordCount": "12",
        })
        res["address_samples"] = [x["attributes"].get(addr) for x in (aq2.get("json") or {}).get("features") or []]
        ac = get(url + "/query", {"f": "json", "where": W(f"{addr} IS NOT NULL AND {addr} <> ''"), "returnCountOnly": "true"})
        res["count_address"] = (ac.get("json") or {}).get("count")

    if not cors_ok(res["cors_gh"], GH):
        res["fatal"] = f"CORS: ACAO={res['cors_gh']!r} for {GH}"
    return res


def main():
    tiger = json.load(open(TIGER))
    tiger_by_fips = {ft["properties"]["GEOID"]: ft for ft in tiger["features"]}
    idx = json.load(open(f"{ERIS}/GIS/parcels/index.json"))["counties"]
    jobs = []
    for fips, ids in sorted(idx.items()):
        if not fips.startswith("27") or fips in EXISTING or fips in UNAVAILABLE:
            continue
        if ONLY and fips not in ONLY:
            continue
        jobs.append((fips, ids[0]))
    results = []
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(verify, fips, aid, tiger_by_fips): (fips, aid) for fips, aid in jobs}
        for fut in futs:
            fips, aid = futs[fut]
            try:
                r = fut.result()
            except Exception as e:  # noqa: BLE001
                r = {"fips": fips, "adapter": aid, "fatal": f"exception {type(e).__name__}: {e}"}
            r["name"] = tiger_by_fips[fips]["properties"]["BASENAME"]
            results.append(r)
            print(f"{fips} {aid:28s} {'FAIL: ' + r['fatal'] if r.get('fatal') else 'ok'}", flush=True)
    results.sort(key=lambda r: r["fips"])
    json.dump(results, open(OUT, "w"), indent=1)


main()
