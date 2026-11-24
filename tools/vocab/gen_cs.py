# SDK vocabulary from a NuGet package's compiled assembly, read as data with cil.py (never loaded or run).
# Usage: python3 -I gen_cs.py <package dir> <package id> <version> -> JSON on stdout
# Generic over .NET SDKs: a method is routed when it (or its params type, or a same-type helper it calls, or the
# compiler's async/iterator state machine for it) loads a path string and names an HTTP verb (HttpMethod.get_X or a
# "POST"-style literal). Resources: properties and parameterless getters whose type holds routed methods (fixpoint,
# interfaces included). Clients: public types with a public constructor that hold resources or routed methods.
# Wire names: a params/options type's property getter that loads a snake_case literal.
import json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cil import Reader
pkgdir, pid, version = sys.argv[1], sys.argv[2], sys.argv[3]
libs = sorted([os.path.join(dp, f) for dp, dn, fn in os.walk(os.path.join(pkgdir, "lib")) for f in fn if f.endswith(".dll")])
def tfm_rank(p):
    t = p.split(os.sep)[-2]
    m = re.match(r"net(\d+)\.(\d+)$", t)
    return (2, int(m.group(1))) if m else (1, 0) if t.startswith("netstandard2") else (0, 0)
dll = max(libs, key=tfm_rank)
r = Reader(open(dll, "rb").read())
ts = r.types()
by = {t["name"]: t for t in ts}
VERBS = {"get_Post": "POST", "get_Get": "GET", "get_Delete": "DELETE", "get_Put": "PUT", "get_Patch": "PATCH"}
PATHLIKE = re.compile(r"^/?(?:v\d+/)?[a-z][\w{}.-]*(?:/[\w{}.-]+)*$")
def is_path(s): return bool(PATHLIKE.match(s)) and "/" in s.strip("/") or bool(re.match(r"^/[a-z_]+$", s))
def strip_generic(n): return re.sub(r"<.*>$", "", n.split("`")[0])
def unwrap(tn):
    # Task<T>, ValueTask<T>, ClientResult<T>, IAsyncEnumerable<T>, CollectionResult<T> …: the inner type
    m = re.match(r"^[\w.+]+<(.+)>$", tn)
    return m.group(1) if m and re.search(r"(Task|Result|Enumerable|Page|Collection|Response)$", tn.split("<")[0]) else tn
NESTED = {}
for x in ts:
    if "+<" in x["name"]:
        owner, rest = x["name"].split("+<", 1)
        NESTED.setdefault((owner, rest.split(">", 1)[0]), []).append(x)
def nested_for(t, mname):
    return NESTED.get((t["name"], mname), [])
# URL templates ("https://api.x.com/{0}/{1}" with a version literal after it) and per-type endpoint literals
TPL = None
for t in ts:
    for mm in t["methods"]:
        st = r.ldstrs(mm["rva"])
        for k, x in enumerate(st):
            if re.match(r"^https://api\.[\w.-]+/(\{\d\}/?)+$", x):
                ver = next((y for y in st[k + 1:k + 3] if re.match(r"^v\d+(beta\d*)?$", y)), None)
                TPL = (x, ver)
def endpoint_of(t, depth=0):
    if not t or depth > 4: return None
    for mm in t["methods"]:
        if mm["name"] == "get_Endpoint":
            e = next((x for x in r.ldstrs(mm["rva"]) if re.match(r"^[a-z][\w/-]*$", x)), None)
            if e: return e
    return endpoint_of(by.get(t["base"]), depth + 1)
def route_and_verb(t, m):
    strs, calls = list(r.ldstrs(m["rva"])), list(r.calls(m["rva"]))
    for n in nested_for(t, m["name"]):
        for mm in n["methods"]: strs += r.ldstrs(mm["rva"]); calls += r.calls(mm["rva"])
    # same-type helpers it calls (one hop), e.g. CreateCompleteChatRequest
    for owner, name in list(calls):
        if owner == t["name"] and name != m["name"]:
            for mm in t["methods"]:
                if mm["name"] == name: strs += r.ldstrs(mm["rva"]); calls += r.calls(mm["rva"])
    route = None
    p0 = next((p for p in m["params"] if p in by), None)
    if p0:
        pt = by[p0]
        for mm in pt["methods"]:
            if mm["name"] in ("get_Route", "Url"):
                for s in r.ldstrs(mm["rva"]):
                    if is_path(s): route = s; break
            if route: break
    if not route:
        route = next((s for s in strs if is_path(s)), None)
    ep = endpoint_of(t)
    if ep and TPL:
        # the endpoint class's own path, under the template's version, with a method's suffix after it
        if route and route.startswith("/") and not route.strip("/").startswith(ep): route = f"{ep}{route}"
        elif not route and any(n in ("get_Url", "Url") for _, n in calls): route = ep
        if route and TPL[1] and not route.startswith(("/" + TPL[1], TPL[1])): route = f"/{TPL[1]}/{route.lstrip('/')}"
    verb = next((VERBS[n] for o, n in calls if o.endswith("HttpMethod") and n in VERBS), None) or next((s for s in strs if s in ("POST", "GET", "DELETE", "PUT", "PATCH")), None)
    return route, verb, p0
methods = []
for t in ts:
    if not t["public"]: continue
    for m in t["methods"]:
        if not m["public"] or m["name"].startswith(("get_", "set_", ".ctor", "op_")) or m["static"] and not m["params"]: continue
        route, verb, p0 = route_and_verb(t, m)
        if not route or not verb: continue
        rt = re.sub(r"\{[^}]*\}", "{id}", route.split("?")[0])
        methods.append({"recv": t["name"], "name": m["name"], "http": verb, "route": rt, "params": m["params"], "paramsType": p0, "returns": unwrap(m["ret"])})
# interface methods: a public interface method with the same name and params as a routed method of an implementing type
impl = {}
for t in ts:
    if t["interface"]: continue
for t in ts:
    if not t["interface"] or not t["public"]: continue
    for m in t["methods"]:
        for x in methods:
            if x["name"] == m["name"] and x["params"] == m["params"] and x["recv"] != t["name"] and strip_generic(x["recv"]).split(".")[-1].lstrip("I") == t["name"].split(".")[-1].lstrip("I"):
                methods.append({**x, "recv": t["name"]}); break
# a method that only delegates to a routed method of the same name (MessageService.Create → its WithRawResponse
# twin's Create), one or two hops
routed_by = {(m["recv"], m["name"]): m for m in methods}
for _ in range(2):
    for t in ts:
        if not t["public"]: continue
        for m in t["methods"]:
            if not m["public"] or (t["name"], m["name"]) in routed_by or m["name"].startswith(("get_", "set_", ".ctor")): continue
            cs = list(r.calls(m["rva"])) + [c for n in nested_for(t, m["name"]) for mm in n["methods"] for c in r.calls(mm["rva"])]
            hit = next((routed_by[(o, n)] for o, n in cs if n == m["name"] and (o, n) in routed_by), None)
            if hit:
                x = {**hit, "recv": t["name"], "params": m["params"], "returns": unwrap(m["ret"])}
                methods.append(x); routed_by[(t["name"], m["name"])] = x
# interface methods (again, for delegating services): a public interface method with the same name and params as a routed method of an implementing type
impl = {}
for t in ts:
    if t["interface"]: continue
for t in ts:
    if not t["interface"] or not t["public"]: continue
    for m in t["methods"]:
        for x in methods:
            if x["name"] == m["name"] and x["params"] == m["params"] and x["recv"] != t["name"] and strip_generic(x["recv"]).split(".")[-1].lstrip("I") == t["name"].split(".")[-1].lstrip("I"):
                methods.append({**x, "recv": t["name"]}); break
routed = {m["recv"] for m in methods}
res_types = set(routed)
changed = True
while changed:
    changed = False
    for t in ts:
        if t["name"] in res_types or not t["public"]: continue
        if any(strip_generic(p["type"]) in res_types for p in t["props"]) or any(m["public"] and not m["params"] and strip_generic(m["ret"]) in res_types for m in t["methods"] if not m["name"].startswith("get_")):
            res_types.add(t["name"]); changed = True
resources = []
for t in ts:
    if t["name"] not in res_types: continue
    for p in t["props"]:
        if strip_generic(p["type"]) in res_types: resources.append({"owner": t["name"], "field": p["name"], "type": strip_generic(p["type"])})
    for m in t["methods"]:
        if m["public"] and not m["name"].startswith(("get_", "set_")) and strip_generic(m["ret"]) in res_types and m["ret"] != t["name"]:
            resources.append({"owner": t["name"], "field": m["name"] + "()", "type": strip_generic(m["ret"]), "args": m["params"]})
clients = [{"type": t["name"]} for t in ts if t["name"] in res_types and t["public"] and not t["interface"] and any(m["name"] == ".ctor" and m["public"] for m in t["methods"])]
# wire names of params / options types: types passed to routed methods, and types their properties reference (one level)
want = {m["paramsType"] for m in methods if m["paramsType"]} | {p for m in methods for p in m["params"] if p in by}
ATTRS = r.attributes()
ptypes = {}
for tn in sorted(want):
    t = by.get(tn)
    if not t: continue
    fields = {}
    chain, b = [t], by.get(t["base"])
    while b and len(chain) < 5: chain.append(b); b = by.get(b["base"])
    for p in [p for c in chain for p in c["props"]]:
        jn = next((a for o, a in ATTRS.get((0x17, p["id"]), []) if o.endswith(("JsonPropertyNameAttribute", "JsonPropertyAttribute", "DataMemberAttribute")) and a), None)
        if jn: fields[p["name"]] = jn; continue
        for acc in p["accessors"]:
            mm = next((x for x in t["methods"] if x["id"] == acc), None)
            if not mm: continue
            w = next((s for s in r.ldstrs(mm["rva"]) if re.match(r"^[a-z][a-z0-9_]*$", s)), None)
            if w: fields[p["name"]] = w; break
    # serializer-written names: a literal, then WritePropertyName, then the property's getter (OpenAI .NET's
    # JsonModelWriteCore writes "temperature"u8 then Temperature)
    for mm in t["methods"]:
        if not re.search(r"Write|Serialize", mm["name"]): continue
        ev = r.events(mm["rva"])
        used = set(fields.values())
        # strongest: the property's JSON-patch path ("$.temperature") right after its getter in the write condition
        for i, e in enumerate(ev):
            if e[0] == "str" and e[1].startswith("$.") and re.match(r"^[a-z][a-z0-9_]*$", e[1][2:]):
                g = next((x[2][4:] for x in reversed(ev[max(0, i - 3):i]) if x[0] == "call" and x[1] == tn and x[2].startswith("get_") and x[2] != "get_Patch"), None)
                if g and g not in fields and e[1][2:] not in used: fields[g] = e[1][2:]; used.add(e[1][2:])
        # then: a literal, WritePropertyName, and the getter right after it
        for i, e in enumerate(ev):
            if e[0] == "call" and e[2] == "WritePropertyName":
                w = next((x[1] for x in reversed(ev[max(0, i - 3):i]) if x[0] == "str" and re.match(r"^[a-z][a-z0-9_]*$", x[1])), None)
                g = next((x[2][4:] for x in ev[i + 1:i + 3] if x[0] == "call" and x[1] == tn and x[2].startswith("get_") and x[2] != "get_Patch"), None)
                if w and g and g not in fields and w not in used: fields[g] = w; used.add(w)
    if fields: ptypes[tn] = {"fields": fields}
# default base URL: an https literal naming an api. host; its path prefixes routes that don't carry it
bases = [x for t in ts for m in t["methods"] for x in r.ldstrs(m["rva"]) if re.match(r"^https://api\.[\w.-]+(/[\w./-]*)?$", x)]
base = max(set(bases), key=bases.count) if bases else (re.sub(r"/\{\d\}.*$", "", TPL[0]) if TPL else None)
bp = re.sub(r"^https://[^/]+", "", base or "").rstrip("/")
for m in methods:
    rt = m["route"] if m["route"].startswith("/") else "/" + m["route"]
    m["op"] = f'{m["http"]} {rt if (not bp or rt.startswith(bp + "/")) else bp + rt}'
urls = {}
for t in ts:
    for mm in t["methods"]:
        for x in r.ldstrs(mm["rva"]):
            m = re.match(r"^https://([\w.-]+)", x)
            if m: urls[m.group(1)] = urls.get(m.group(1), 0) + 1
out = {"lang": "cs", "baseURL": base, "urlHosts": urls, "package": pid, "version": version, "assembly": os.path.relpath(dll, pkgdir), "namespaces": sorted({t["name"].rsplit(".", 1)[0] for t in ts if t["public"] and "." in t["name"]}),
       "clients": clients, "resources": sorted(resources, key=lambda x: (x["owner"], x["field"])), "methods": sorted(methods, key=lambda m: (m["recv"], m["name"])), "paramTypes": ptypes}
print(json.dumps(out))
