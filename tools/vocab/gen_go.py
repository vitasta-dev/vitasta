# SDK vocabulary from a Go module's published source (text only, never built or run).
# Usage: python3 -I gen_go.py <module dir> <module path> <version> -> JSON on stdout
# Generic over Go SDKs: client constructors (func NewX(...) X/*X), resource fields (struct fields whose type has
# routed methods or holds such fields), methods with the HTTP method and route they send (path := "…",
# fmt.Sprintf("…/%s", …), or a package const passed next to http.MethodX), param types and their json wire names,
# and the default base URL. Path parameters become {id}.
import json, os, re, sys
root, modpath, version = sys.argv[1], sys.argv[2], sys.argv[3]
files = {}
for dp, dn, fn in os.walk(root):
    dn[:] = [d for d in dn if d not in ("internal", "examples", "example", "testdata", ".github", "scripts", "cmd")]
    for f in fn:
        if f.endswith(".go") and not f.endswith("_test.go"):
            files[os.path.join(dp, f)] = open(os.path.join(dp, f), encoding="utf-8", errors="replace").read()
def pkg_of(path): 
    rel = os.path.relpath(os.path.dirname(path), root)
    return modpath if rel == "." else modpath + "/" + rel.replace(os.sep, "/")
consts, structs, methods, ctors, bases = {}, {}, [], [], []
for path, src in files.items():
    pk = pkg_of(path)
    for m in re.finditer(r'^\s*(?:const\s+|var\s+)?(\w+)\s*(?:[\w.]+\s*)?=\s*"([^"\n]*)"', src, re.M):
        if m.group(1) not in ("const", "var"): consts[(pk, m.group(1))] = m.group(2)
    for m in re.finditer(r'^type (\w+) struct \{\n(.*?)^\}', src, re.M | re.S):
        fields = []
        for fl in m.group(2).split("\n"):
            fm = re.match(r'\s*(\w+)\s+([\w.*\[\]]+(?:\[[\w.*\[\]]+\])?)\s*(?:`([^`]*)`)?', fl)
            if not fm or fl.strip().startswith("//"): continue
            tag = re.search(r'json:"([^",]*)', fm.group(3) or "")
            fields.append({"name": fm.group(1), "type": fm.group(2).lstrip("*"), **({"wire": tag.group(1)} if tag and tag.group(1) not in ("", "-") else {})})
        structs[(pk, m.group(1))] = fields
    for m in re.finditer(r'^func (New\w*)\(([^)]*)\)\s*\(?\s*(?:\w+\s+)?\*?(\w+)\s*(?:,\s*error)?\)?\s*\{', src, re.M):
        ctors.append({"func": m.group(1), "pkg": pk, "returns": m.group(3)})
    # methods with a body
    for m in re.finditer(r'^func \((\w+) \*?(\w+)\) (\w+)\(([^)]*)\)\s*(\([^)]*\)|[\w.*\[\]]+)?\s*\{\n(.*?)^\}', src, re.M | re.S):
        recv, name, args, res, body = m.group(2), m.group(3), m.group(4), m.group(5) or "", m.group(6)
        if not name[0].isupper(): continue
        hm = re.search(r'http\.Method(\w+)', body)
        route = None
        pm = re.search(r'path\s*:?=\s*[\w.]+\(\s*"([^"]*)"', body) or re.search(r'path\s*:?=\s*"([^"]*)"', body)
        if pm: route = pm.group(1)
        elif hm:
            # the call that carries http.MethodX: a literal or a package const in it
            stmt = body[hm.start(): hm.start() + 400]
            lit = re.search(r'"(/?[\w{}%./-]*/[\w{}%./-]*|/[\w{}%.-]+)"', stmt)
            if lit: route = lit.group(1)
            else:
                # an identifier in the call: a local assigned above (x := y, x := "…"), then a package const
                def resolve(idn, depth=0):
                    if depth > 3: return None
                    if (pk, idn) in consts: return consts[(pk, idn)]
                    for a in re.finditer(r'\b' + idn + r'\s*:?=\s*(?:fmt\.Sprintf\(\s*)?(?:"([^"]*)"|([A-Za-z_]\w*))', body):
                        v = a.group(1) if a.group(1) is not None else resolve(a.group(2), depth + 1)
                        if v: return v
                    return None
                for idn in re.findall(r'\b([A-Za-z_]\w*)\b', stmt[len("http.Method"):]):
                    v = resolve(idn)
                    if v and "/" in v: route = v; break
        params = []
        for a in args.split(","):
            am = re.match(r'\s*\w+\s+(?:\.\.\.)?\*?([\w.]+)', a)
            if am and am.group(1) not in ("context.Context", "option.RequestOption"): params.append(am.group(1))
        rm = re.findall(r'\*?([\w.]+)', res.replace("error", ""))
        methods.append({"recv": recv, "pkg": pk, "name": name, "params": params, "returns": [r for r in rm if r not in ("res", "r", "err", "response")][:1],
                        **({"http": hm.group(1).upper() if hm else "GET", "route": re.sub(r"(?<!/)\{id\}", "", re.sub(r"%[sdv]", "{id}", route).split("?")[0])} if route is not None and hm else {})})
    for m in re.finditer(r'"(https://[^"\s]+)"', src):
        line = src[src.rfind("\n", 0, m.start()) + 1: src.find("\n", m.end())]
        if re.search(r'(?i)base_?url|defaultbase|apiurl|BaseURL', line) and "%" not in m.group(1):
            # the module's own default first: root package, a line saying default
            bases.append((pkg_of(path) == modpath, bool(re.search(r'(?i)default', line)), m.group(1)))
base = max(bases, key=lambda b: (b[0], b[1], sum(1 for x in bases if x[2] == b[2])))[2] if bases else None
basepath = re.sub(r"^https://[^/]+", "", base or "").rstrip("/")
def op_of(m):
    r = m["route"]
    r = r if r.startswith("/") else "/" + r
    full = (basepath + r) if not r.startswith(basepath + "/") or not basepath else r
    return f'{m["http"]} {full}'
routed = [m for m in methods if "route" in m]
for m in routed: m["op"] = op_of(m)
routed_types = {(m["pkg"], m["recv"]) for m in routed}
# resource fields: struct fields whose type is a routed type, or holds routed fields (fixpoint)
res_types = set(routed_types)
changed = True
while changed:
    changed = False
    for (pk, s), fields in structs.items():
        if (pk, s) in res_types: continue
        if any((pk, f["type"]) in res_types for f in fields): res_types.add((pk, s)); changed = True
resources = [{"owner": s, "pkg": pk, "field": f["name"], "type": f["type"]} for (pk, s), fields in structs.items() if (pk, s) in res_types for f in fields if (pk, f["type"]) in res_types]
clients = [c for c in ctors if (c["pkg"], c["returns"]) in res_types]
# param types (and option structs one level down) with wire names
want = {(m["pkg"], p.split(".")[-1]) for m in routed for p in m["params"]}
ptypes = {}
for (pk, t) in want:
    f = structs.get((pk, t))
    if f: ptypes[t] = {"pkg": pk, "fields": {x["name"]: x["wire"] for x in f if "wire" in x}}
urls = {}
for src in files.values():
    for m in re.finditer(r'"https://([\w.-]+)', src): urls[m.group(1)] = urls.get(m.group(1), 0) + 1
out = {"lang": "go", "urlHosts": urls, "package": modpath, "version": version, "imports": sorted({m["pkg"] for m in routed} | {c["pkg"] for c in clients}), "baseURL": base,
       "clients": clients, "resources": sorted(resources, key=lambda r: (r["owner"], r["field"])),
       "methods": sorted([{k: m[k] for k in ("recv", "name", "http", "route", "op", "params", "returns")} for m in routed], key=lambda m: (m["recv"], m["name"])),
       "paramTypes": ptypes}
print(json.dumps(out))
