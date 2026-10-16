"""Owner fill rate across each whole layer: ~400 parcels sampled evenly by
object id (the first rows of a layer are often unrepresentative).

usage: python3 -I owner_fill.py <verify.json> [fips ...]
"""
import json, sys, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor
R = json.load(open(sys.argv[1]))
want = set(sys.argv[2:])
def q(url, params):
    return json.load(urllib.request.urlopen(url + "/query?" + urllib.parse.urlencode({"f": "json", **params}), timeout=60))
def scan(r):
    meta = json.load(urllib.request.urlopen(r["url"] + "?f=json", timeout=30))
    oid = meta.get("objectIdField") or next((f["name"] for f in meta["fields"] if f["type"] == "esriFieldTypeOID"), "OBJECTID")
    owner = r["fields"]["owner"]; flt = r.get("filter")
    W = lambda w: f"({w}) AND ({flt})" if flt else w
    ids = q(r["url"], {"where": W("1=1"), "returnIdsOnly": "true"}).get("objectIds") or []
    ids.sort()
    step = max(1, len(ids) // 400)
    pick = ids[::step][:400]
    vals = []
    for i in range(0, len(pick), 100):
        chunk = pick[i:i+100]
        d = q(r["url"], {"objectIds": ",".join(map(str, chunk)), "outFields": owner, "returnGeometry": "false"})
        vals += [str(f["attributes"].get(owner) or "").strip() for f in d.get("features", [])]
    blank = sum(1 for v in vals if v in ("", "0"))
    return r["fips"], r["name"], len(ids), f"blank {blank}/{len(vals)} = {100*blank/max(1,len(vals)):.0f}%"
ok = [r for r in R if not r.get("fatal") and (not want or r["fips"] in want)]
with ThreadPoolExecutor(8) as ex:
    for row in ex.map(scan, ok):
        print(*row, flush=True)
