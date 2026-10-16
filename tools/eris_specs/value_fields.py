"""Check value / land-use / year fields: existence (canonical case), and fill
rates over ~300 parcels sampled evenly by object id.

usage: python3 -I value_fields.py <targets.json> <out.json>
targets: [{"id", "url" (layer, no /query), "filter", "value": str|[str], "use": str, "extra": [str]}]
"""
import json
import re
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

TARGETS, OUT = sys.argv[1], sys.argv[2]
YEAR_RE = re.compile(r"(year|yr)", re.I)
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"


def get(url, params, post=False):
    data = urllib.parse.urlencode({"f": "json", **params})
    for attempt in range(3):
        try:
            if post:
                rq = urllib.request.Request(url, data=data.encode(), headers={"User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded"})
            else:
                rq = urllib.request.Request(url + "?" + data, headers={"User-Agent": UA})
            with urllib.request.urlopen(rq, timeout=60) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            err = e
    raise err


def missing(v):
    if v is None:
        return True
    s = str(v).strip()
    return s == "" or s.upper() == "NULL" or s in ("0", "-9999", "0.0", "-9999.0")


def check(t):
    out = {"id": t["id"]}
    meta = get(t["url"], {})
    fields = {f["name"].lower(): f for f in meta.get("fields") or []}
    oid = meta.get("objectIdField") or next((f["name"] for f in meta["fields"] if f["type"] == "esriFieldTypeOID"), "OBJECTID")
    vals = t["value"] if isinstance(t.get("value"), list) else ([t["value"]] if t.get("value") else [])
    want = vals + ([t["use"]] if t.get("use") else []) + t.get("extra", [])
    canon = {}
    for w in want:
        f = fields.get(w.lower())
        canon[w] = f["name"] if f else None
        if not f:
            out.setdefault("missing_fields", []).append(w)
    out["canon"] = canon
    out["types"] = {w: fields[w.lower()]["type"].replace("esriFieldType", "") for w in want if w.lower() in fields}
    out["year_fields"] = [f["name"] for f in meta["fields"] if YEAR_RE.search(f["name"]) or YEAR_RE.search(f.get("alias") or "")]
    flt = t.get("filter")
    where = f"(1=1) AND ({flt})" if flt else "1=1"
    ids = sorted(get(t["url"] + "/query", {"where": where, "returnIdsOnly": "true"}).get("objectIds") or [])
    step = max(1, len(ids) // 300)
    pick = ids[::step][:300]
    ask = [canon[w] for w in want if canon.get(w)] + out["year_fields"]
    rows = []
    for i in range(0, len(pick), 100):
        d = get(t["url"] + "/query", {"objectIds": ",".join(map(str, pick[i:i + 100])), "outFields": ",".join(dict.fromkeys(ask)) or oid, "returnGeometry": "false"})
        rows += [f["attributes"] for f in d.get("features") or []]
    out["n"] = len(rows)
    vcanon = [canon[v] for v in vals if canon.get(v)]
    if vcanon:
        def total(a):
            nums = []
            for v in vcanon:
                x = a.get(v)
                try:
                    x = float(str(x).replace(",", "").replace("$", "")) if not missing(x) else None
                except ValueError:
                    x = None
                if x is not None and x > 0:
                    nums.append(x)
            return sum(nums) if nums else None
        tv = [total(a) for a in rows]
        filled = [x for x in tv if x is not None]
        out["value_fill"] = round(len(filled) / max(1, len(rows)), 3)
        out["value_sample"] = sorted(filled)[len(filled) // 2] if filled else None
    if t.get("use") and canon.get(t["use"]):
        u = [str(a.get(canon[t["use"]])).strip() for a in rows if not missing(a.get(canon[t["use"]]))]
        out["use_fill"] = round(len(u) / max(1, len(rows)), 3)
        from collections import Counter
        out["use_top"] = Counter(u).most_common(4)
    for w in t.get("extra", []):
        if canon.get(w):
            ex = [a.get(canon[w]) for a in rows if not missing(a.get(canon[w]))]
            out.setdefault("extra_fill", {})[w] = [round(len(ex) / max(1, len(rows)), 3), ex[:3]]
    years = {}
    for y in out["year_fields"]:
        from collections import Counter
        years[y] = Counter(str(a.get(y)) for a in rows).most_common(3)
    out["years"] = years
    return out


def main():
    targets = json.load(open(TARGETS))
    res = []
    with ThreadPoolExecutor(6) as ex:
        def safe(t):
            try:
                return check(t)
            except Exception as e:  # noqa: BLE001
                return {"id": t["id"], "error": f"{type(e).__name__}: {e}"}
        for r in ex.map(safe, targets):
            res.append(r)
            print(json.dumps(r)[:700], flush=True)
    json.dump(res, open(OUT, "w"), indent=1)


main()
