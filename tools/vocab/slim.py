# Merge generator outputs (one or more releases of one SDK) into the scanner's data file
# src/data/sdk-vocab/<registry>-<package>.json. The provider comes from the SDK's own default base URL host.
# Usage: python3 -I slim.py <out.json> <registry> <gen output.json>...
import json, re, sys
out_path, registry, ins = sys.argv[1], sys.argv[2], sys.argv[3:]
HOSTS = {"api.openai.com": "openai", "api.anthropic.com": "anthropic"}
docs = [json.load(open(p)) for p in ins]
lang, package = docs[0]["lang"], docs[0]["package"]
# the provider whose API host the SDK's own literals name most (a suffix match: mtls.api.openai.com is OpenAI)
votes = {}
for d in docs:
    for h, n in (d.get("urlHosts") or {}).items():
        for host, pv in HOSTS.items():
            if h == host or h.endswith("." + host): votes[pv] = votes.get(pv, 0) + n
    h = re.sub(r"^https://([^/]+).*$", r"\1", d.get("baseURL") or "")
    for host, pv in HOSTS.items():
        if h == host or h.endswith("." + host): votes[pv] = votes.get(pv, 0) + 1
provider = max(votes, key=votes.get) if votes else None
assert provider, f"no provider from base URLs {[d.get('baseURL') for d in docs]}"
multi = len({d["package"] for d in docs}) > 1
tag = lambda d: f'{d["package"]}@{d["version"]}' if multi else d["version"]
versions = [tag(d) for d in docs]
integrity = {tag(d): d.get("integrity", "unrecorded") for d in docs}
def full(d, name, pkg=None):
    # Go names are package-qualified with the import path; C# and Java names are already full
    return f"{pkg}.{name}" if d["lang"] == "go" and pkg and "." not in name else name
types, ptypes, clients = {}, {}, {}
for d in docs:
    v = d["version"]
    for m in d["methods"]:
        recv = full(d, m["recv"], m.get("pkg") or (d.get("imports") or [package])[0])
        t = types.setdefault(recv, {"res": {}, "methods": {}})
        ops = t["methods"].setdefault(m["name"], [])
        pt = m.get("paramsType") or next((p for p in m.get("params", []) if p not in ("string", "int", "long", "bool")), None)
        if pt and d["lang"] == "go" and "." not in pt: pt = f'{m.get("pkg") or d["imports"][0]}.{pt}'
        e = {"op": m["op"], **({"params": pt} if pt else {})}
        if e not in ops: ops.append(e)
    for r in d["resources"]:
        owner = full(d, r["owner"], r.get("pkg"))
        typ = full(d, r["type"], r.get("pkg"))
        types.setdefault(owner, {"res": {}, "methods": {}})["res"][r["field"]] = typ
    for c in d["clients"]:
        name = full(d, c.get("returns") or c["type"], c.get("pkg"))
        clients.setdefault(name, sorted({x for x in ([c["func"]] if "func" in c else [])}))
    for tn, pv in d["paramTypes"].items():
        key = full(d, tn, pv.get("pkg"))
        cur = ptypes.setdefault(key, {"fields": {}, "versions": []})
        for k, w in pv["fields"].items(): cur["fields"].setdefault(k, w)
        if v not in cur["versions"]: cur["versions"].append(v)
# each params type's ops: the methods that take it
for tn, t in types.items():
    for name, ops in t["methods"].items():
        for e in ops:
            if e.get("params") in ptypes:
                ptypes[e["params"]].setdefault("ops", [])
                if e["op"] not in ptypes[e["params"]]["ops"]: ptypes[e["params"]]["ops"].append(e["op"])
ns = sorted({x for d in docs for x in (d.get("namespaces") or d.get("imports") or [])})
out = {"_about": f"SDK vocabulary for {package} ({registry}), generated from the published package of each release in `versions` by tools/vocab (never installed or run). Don't edit by hand.",
       "lang": lang, "registry": registry, "package": package, "provider": provider, "versions": versions, "integrity": integrity, "namespaces": ns,
       "clients": clients, "types": types, "paramTypes": {k: v for k, v in ptypes.items() if v.get("ops")}}
json.dump(out, open(out_path, "w"), separators=(",", ":"), sort_keys=True)
print(out_path, len(types), "types", len(out["paramTypes"]), "params types", provider, versions)
