"""Generate parcelpicker's bundled ErisData spec file and 87-county boundaries.

usage: python3 -I gen_bundle.py <ErisData dir> <verify.json> <examples.json> <tiger geojson> <parcelpicker/web>

Inputs come from verify.py and examples_rural.py + examples_town.py (live checks
run 2026-10-16); the drop/address/coverage decisions below come from those runs
plus owner_fill.py, post_cors.py and coverage.py.
"""
import json
import math
import re
import sys

ERIS, VER, PH, TIGER, WEB = sys.argv[1:6]
VERIFIED = "2026-10-16"

# The 16 counties with hand-written providers (ids match web/js/providers).
EXISTING = {
    "27001": "aitkin", "27003": "anoka", "27007": "beltrami", "27019": "carver",
    "27025": "chisago", "27037": "dakota", "27053": "hennepin", "27071": "koochiching",
    "27097": "morrison", "27109": "olmsted", "27123": "ramsey", "27137": "stlouis",
    "27139": "scott", "27141": "sherburne", "27163": "washington", "27171": "wright",
}

# Why a county has no provider. Shown in the app when a click lands there.
UNSUPPORTED = {
    "27067": "its parcel data is paywalled (ErisData)",
    "27069": "it only publishes a parcel viewer, no queryable layer (ErisData)",
    "27127": "it only publishes a parcel viewer, no queryable layer (ErisData)",
    "27133": "it only publishes a parcel viewer, no queryable layer (ErisData)",
    "27005": "its public parcel layer has no owner field",
    "27015": "its public parcel layer has no owner field",
    "27055": "its public parcel layer has no owner field",
    "27161": "its public parcel layer has no owner field",
    "27165": "its public parcel layer has owner names for only a few parcels",
    "27045": "its parcel server is http-only, which browsers block on an https page",
    "27153": "its public parcel layer has no owner names (owner is '0' for 94% of parcels)",
    "27013": "its public parcel layer has no owner names (the spec's owner field holds the parcel number)",
    "27103": "its only public parcel layer is a 2021 snapshot of part of North Mankato, with owner last names only",
}

# Layers that pass every check but cover only part of the county (from the
# coverage probe: grid points plus parcel counts around each town center).
COVERAGE = {
    "27105": "parcel data covers the Worthington area only",
    "27091": "parcel data covers rural parcels only; Fairmont, Truman and Ceylon are missing",
}

# Spec address fields that hold a full site street address (house number +
# street, sometimes with a padded city/ZIP tail). Checked county by county
# against live samples and field aliases.
ADDRESS_FULL = {
    "27009", "27027", "27039", "27041", "27049", "27065", "27073", "27089",
    "27091", "27105", "27131", "27145", "27147", "27159",
}
# Spec address mappings that are blanked, and why.
ADDRESS_BLANKED = {
    "27021": "street name only (st_name)",
    "27029": "street name only (st_name)",
    "27047": "street name and type only, no house number",
    "27093": "street name only",
    "27169": "street name only",
    "27051": "taxpayer mailing address, not the site address",
    "27057": "taxpayer mailing address (PI*), not the site address (PA*)",
    "27059": "owner mailing address, not the site address",
    "27061": "taxpayer mailing address, not the site address",
    "27075": "taxpayer mailing address, not the site address",
    "27095": "taxpayer mailing address, not the site address",
    "27149": "taxpayer mailing address (PO boxes), not the site address",
    "27155": "taxpayer mailing address, not the site address",
}


JUNK_OWNER = re.compile(r"\b(ROW|R/W|STREETS?|ROADS?|HWY|HIGHWAY|RAILROAD|RAILWAY|DEDICATED)\b", re.I)


def pick_example(found):
    """Example address: the town pass (OSM building/address point that
    geocodes back to itself) first, then the rural pass; skip any whose
    geocode lands on right-of-way."""
    for cand in (found.get("town") or {}, found):
        if cand.get("placeholder") and not JUNK_OWNER.search(cand["hit"]["owner"]):
            return cand["placeholder"]
    return None


def county_id(basename):
    return re.sub(r"[^a-z0-9]", "", basename.lower())


def bbox(geom):
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    xs = [p[0] for poly in polys for p in poly[0]]
    ys = [p[1] for poly in polys for p in poly[0]]
    return min(xs), min(ys), max(xs), max(ys)


def merc(lat):
    return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def center_zoom(geom, width_px=640, height_px=520):
    x0, y0, x1, y1 = bbox(geom)
    zx = math.log2(width_px * 360 / (256 * (x1 - x0)))
    zy = math.log2(height_px * 2 * math.pi / (256 * (merc(y1) - merc(y0))))
    zoom = max(9, min(12, math.floor(min(zx, zy))))
    return [round((y0 + y1) / 2, 4), round((x0 + x1) / 2, 4)], zoom


def round_geom(geom, nd=5):
    def rr(c):
        return [round(c[0], nd), round(c[1], nd)] if isinstance(c[0], (int, float)) else [rr(x) for x in c]
    return {"type": geom["type"], "coordinates": rr(geom["coordinates"])}


def main():
    tiger = {ft["properties"]["GEOID"]: ft for ft in json.load(open(TIGER))["features"]}
    assert len(tiger) == 87, len(tiger)
    ver = {r["fips"]: r for r in json.load(open(VER))}
    ph = json.load(open(PH))

    counties = {}
    for fips, r in sorted(ver.items()):
        if fips in UNSUPPORTED:
            assert r.get("fatal") or fips in ("27153", "27103", "27013"), fips
            continue
        assert not r.get("fatal"), (fips, r.get("fatal"))
        assert r["cors_gh"] in ("*", "https://jsherman999.github.io"), fips
        spec = json.load(open(f"{ERIS}/GIS/parcels/adapters/{r['adapter']}.json"))
        props = tiger[fips]["properties"]
        cid = county_id(props["BASENAME"])
        label = f"{props['BASENAME']} County"
        fields = {"apn": r["fields"]["apn"], "owner": r["fields"]["owner"], "address": ""}
        entry = {"id": cid, "label": label, "fips": fips, "adapter": r["adapter"],
                 "publisher": spec.get("publisher", ""), "url": r["url"], "filter": r.get("filter") or ""}
        spec_addr = r["fields"].get("address")
        if spec_addr:
            if fips in ADDRESS_FULL:
                fields["address"] = spec_addr
            else:
                entry["addressNote"] = f"spec address {spec_addr} not used: {ADDRESS_BLANKED[fips]}"
        else:
            assert fips not in ADDRESS_FULL and fips not in ADDRESS_BLANKED, fips
        entry["fields"] = fields
        entry["center"], entry["zoom"] = center_zoom(tiger[fips]["geometry"])
        example = pick_example(ph.get(fips) or {})
        entry["placeholder"] = f"Example: {example}" if example else "Full street address + city + MN + ZIP (or click the map)"
        if fips in COVERAGE:
            entry["coverage"] = COVERAGE[fips]
        entry["verified"] = VERIFIED
        counties[cid] = entry

    assert not set(counties) & set(EXISTING.values())
    bundle = {
        "attribution": {
            "source": "ErisData GIS/parcels adapter registry",
            "author": "Eriskii",
            "url": "https://github.com/Eriskii/ErisData",
            "license": "CC-BY-4.0",
            "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
            "changes": "Subset to the Minnesota counties without a hand-written parcelpicker provider; field names "
                       "case-corrected and http URLs upgraded to https where needed; partial or mailing-address "
                       "address mappings blanked; county map center/zoom and example addresses added; every "
                       f"endpoint live-verified on {VERIFIED} (CORS, owner-filled point intersect, adjacency).",
        },
        "generated": VERIFIED,
        "counties": dict(sorted(counties.items())),
    }
    with open(f"{WEB}/mn_parcel_specs.json", "w") as fh:
        json.dump(bundle, fh, indent=1)
        fh.write("\n")

    feats = []
    for fips, ft in sorted(tiger.items(), key=lambda kv: kv[1]["properties"]["BASENAME"]):
        props = ft["properties"]
        cid = EXISTING.get(fips) or county_id(props["BASENAME"])
        p = {"id": cid, "name": props["BASENAME"], "fips": fips}
        if fips in UNSUPPORTED:
            p["unsupported"] = UNSUPPORTED[fips]
        feats.append({"type": "Feature", "id": cid, "properties": p, "geometry": round_geom(ft["geometry"])})
    with open(f"{WEB}/county_boundaries.geojson", "w") as fh:
        json.dump({"type": "FeatureCollection", "features": feats}, fh, separators=(",", ":"))
        fh.write("\n")

    print(f"{len(counties)} spec counties; {len(feats)} boundaries; "
          f"{sum(1 for c in counties.values() if c['fields']['address'])} with address field; "
          f"{sum(1 for c in counties.values() if c['placeholder'].startswith('Example'))} with example address")


main()
