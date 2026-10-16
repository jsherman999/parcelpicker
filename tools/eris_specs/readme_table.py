"""Print the README table of spec-driven counties from web/mn_parcel_specs.json."""
import json
import sys
import urllib.parse

bundle = json.load(open(sys.argv[1]))
rows = ["| County | Parcel ID | Owner | Address lookup | Server | Notes |", "|---|---|---|---|---|---|"]
for c in sorted(bundle["counties"].values(), key=lambda c: c["label"]):
    host = urllib.parse.urlparse(c["url"]).netloc
    addr = f"`{c['fields']['address']}`" if c["fields"]["address"] else "geocode → point"
    notes = []
    if "plan_parcels_open" in c["url"]:
        notes.append(f"statewide MnGeo layer, `{c['filter']}`")
    elif c.get("filter"):
        notes.append(f"filter `{c['filter']}`")
    if c.get("coverage"):
        notes.append(f"**partial:** {c['coverage']}")
    rows.append(f"| {c['label'].replace(' County', '')} | `{c['fields']['apn']}` | `{c['fields']['owner']}` | {addr} | `{host}` | {'; '.join(notes)} |")
print("\n".join(rows))
