"""Long (> 2,000 char) adjacency query sent as a form POST, checked for CORS
headers, on every candidate endpoint and the 16 existing ones.

usage: python3 -I post_cors.py <verify.json> <parcelpicker/web/js/app.js>
"""
import json, sys, re, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor
GH = "https://jsherman999.github.io"
# Some county firewalls 403 the default Python-urllib agent; look like a browser.
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
R = json.load(open(sys.argv[1]))
app = open(sys.argv[2]).read()
targets = [(r["name"], r["url"] + "/query", r.get("filter")) for r in R if not r.get("fatal") and r["fips"] != "27153"]
for m in re.finditer(r'label: "([^"]+)",.*?arcgisJsonBase:\s*"([^"]+)"', app, re.S):
    name, url = m.group(1), m.group(2)
    co = {"Dakota County": "CO_NAME = 'Dakota'", "Washington County": "CO_NAME = 'Washington'", "Carver County": "CO_NAME = 'Carver'"}.get(name)
    targets.append(("EXISTING " + name, url, co))
def post(url, params):
    rq = urllib.request.Request(url, data=urllib.parse.urlencode(params).encode(), headers={"Origin": GH, "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"})
    with urllib.request.urlopen(rq, timeout=60) as r:
        return r.status, r.headers.get("Access-Control-Allow-Origin"), json.load(r)
def check(t):
    name, url, flt = t
    W = lambda w: f"({w}) AND ({flt})" if flt else w
    try:
        g = json.load(urllib.request.urlopen(urllib.request.Request(url + "?" + urllib.parse.urlencode({"f": "json", "where": W("1=1"), "outFields": "*", "returnGeometry": "true", "outSR": "4326", "resultRecordCount": "1"}), headers={"User-Agent": UA}), timeout=60))
        rings = g["features"][0]["geometry"]["rings"]
        # pad the geometry with interpolated vertices so the request is long (> 2000 chars)
        dense = []
        for ring in rings:
            out = []
            for i in range(len(ring) - 1):
                (x1, y1), (x2, y2) = ring[i][:2], ring[i + 1][:2]
                for k in range(6):
                    out.append([x1 + (x2 - x1) * k / 6, y1 + (y2 - y1) * k / 6])
            out.append(ring[-1][:2])
            dense.append(out)
        esri = json.dumps({"rings": dense, "spatialReference": {"wkid": 4326}}, separators=(",", ":"))
        p = {"f": "json", "where": W("1=1"), "geometry": esri, "geometryType": "esriGeometryPolygon", "spatialRel": "esriSpatialRelIntersects", "inSR": "4326", "outFields": "*", "returnGeometry": "true", "outSR": "4326", "resultRecordCount": "50"}
        st, acao, d = post(url, p)
        ok = acao in ("*", GH) and "error" not in d and len(d.get("features") or []) >= 1
        return f"{'OK  ' if ok else 'FAIL'} {name:32s} status={st} acao={acao} n={len(d.get('features') or [])} body={len(urllib.parse.urlencode(p))} err={d.get('error')}"
    except Exception as e:
        return f"FAIL {name:32s} {type(e).__name__}: {str(e)[:150]}"
with ThreadPoolExecutor(8) as ex:
    for line in ex.map(check, targets):
        print(line, flush=True)
