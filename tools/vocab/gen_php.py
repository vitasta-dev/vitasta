# SDK vocabulary from a Composer package's source (PHP, text only, never loaded or run).
# Usage: python3 -I gen_php.py <package dir> <vendor/name> <version> -> JSON on stdout
# Generic over PHP SDKs:
# - classes, interfaces and traits by namespace, with `use` imports, extends / implements;
# - resources: zero-argument methods returning a class (`public function chat(): Chat { return new Chat(…); }`),
#   typed public properties (`public MessagesService $messages;`), and a facade's `@method static Ret name()` lines;
#   an interface stands for the classes that implement it;
# - routes: a request built with `method: 'post', path: 'v1/messages'` (named arguments), or through a request
#   helper with a literal path (`Payload::create('chat/completions', …)`), whose verb is read from the helper's own body
#   (`Method::POST`) and which adds /{id} when the helper takes an id; a method delegating to a same-named routed
#   method (a raw-response twin) inherits its route;
# - params: classes whose properties carry #[Required('wire')] / #[Optional('wire')] (or the property name), and
#   docblock array shapes; the method's params class from `XParams::` in its body.
import json, os, re, sys
root, pkg, version = sys.argv[1], sys.argv[2], sys.argv[3]
srcs = {}
for dp, dn, fn in os.walk(root):
    dn[:] = [d for d in dn if d not in ("tests", "test", "Testing", "vendor", ".github")]
    for f in fn:
        if f.endswith(".php"): srcs[os.path.join(dp, f)] = open(os.path.join(dp, f), encoding="utf-8", errors="replace").read()
def braces(src):
    m, st, i, n = {}, [], 0, len(src)
    while i < n:
        c = src[i]
        if c in "'\"":
            q = c; i += 1
            while i < n and src[i] != q: i += 2 if src[i] == "\\" else 1
        elif c == "/" and src[i + 1:i + 2] == "/": i = src.find("\n", i); i = n if i < 0 else i; continue
        elif c == "/" and src[i + 1:i + 2] == "*": j = src.find("*/", i + 2); i = n if j < 0 else j + 2; continue
        elif c == "#" and src[i + 1:i + 2] != "[": i = src.find("\n", i); i = n if i < 0 else i; continue
        elif c == "{": st.append(i)
        elif c == "}" and st: m[st.pop()] = i
        i += 1
    return m
classes = {}
for path, src in srcs.items():
    ns = (re.search(r"^\s*namespace\s+([\w\\]+)\s*;", src, re.M) or [None, ""])[1]
    uses = {}
    for m in re.finditer(r"^\s*use\s+([\w\\]+)(?:\s+as\s+(\w+))?\s*;", src, re.M): uses[m.group(2) or m.group(1).split("\\")[-1]] = m.group(1)
    bm = None
    for m in re.finditer(r"^(?:\s*(?:final|abstract|readonly)\s+)*(class|interface|trait|enum)\s+(\w+)([^{]*)\{", src, re.M):
        bm = bm or braces(src)
        o = src.index("{", m.end() - 1); e = bm.get(o, len(src))
        hdr = m.group(3)
        ext = re.search(r"\bextends\s+([\w\\, ]+?)(?:\bimplements\b|$)", hdr)
        imp = re.search(r"\bimplements\s+([\w\\, ]+)", hdr)
        full = (ns + "\\" if ns else "") + m.group(2)
        doc = src[max(0, m.start() - 4000):m.start()]
        doc = doc[doc.rfind("/**"):] if "/**" in doc else ""
        classes[full] = {"kind": m.group(1), "path": path, "ns": ns, "uses": uses, "body": src[o + 1:e], "doc": doc,
                         "extends": [x.strip() for x in ext.group(1).split(",")] if ext else [], "implements": [x.strip() for x in imp.group(1).split(",")] if imp else []}
def resolve(name, c):
    if not name: return None
    name = name.lstrip("?").strip()
    if name.startswith("\\"): return name[1:] if name[1:] in classes else None
    head = name.split("\\")[0]
    if head in c["uses"]:
        cand = c["uses"][head] + name[len(head):]
        return cand if cand in classes else None
    cand = (c["ns"] + "\\" if c["ns"] else "") + name
    return cand if cand in classes else (name if name in classes else None)
def methods_of(c):
    body = c["body"]; bm = braces(body); out = []
    for m in re.finditer(r"public\s+(?:static\s+)?function\s+(\w+)\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)\s*(?::\s*([?\w\\|]+))?\s*(\{|;)", body):
        b = ""
        if m.group(4) == "{":
            o = m.end() - 1; b = body[o + 1:bm.get(o, o)]
        out.append({"name": m.group(1), "args": m.group(2), "ret": m.group(3) or "", "body": b})
    return out
# request helpers: static methods whose body sets a verb (Method::POST / 'POST'), and whether they take an id
helpers = {}
for full, c in classes.items():
    for m in methods_of(c):
        v = re.search(r"Method::(GET|POST|PUT|PATCH|DELETE)\b|['\"](GET|POST|PUT|PATCH|DELETE)['\"]", m["body"])
        if v and re.search(r"\$resource|\$uri|\$path", m["args"]):
            helpers[(c["path"].split(os.sep)[-1][:-4], m["name"])] = {"verb": v.group(1) or v.group(2), "id": bool(re.search(r"\$id\b", m["args"]))}
routed = []
for full, c in classes.items():
    for m in methods_of(c):
        b = m["body"]
        route = verb = None
        nm = re.search(r"method:\s*['\"](\w+)['\"]", b); pm = re.search(r"path:\s*(?:\[\s*)?['\"]([^'\"]+)['\"]", b)
        if nm and pm: verb, route = nm.group(1).upper(), re.sub(r"%\d*\$?[sd]|\{[^}]*\}", "{id}", pm.group(1))
        else:
            hm = re.search(r"(\w+)::(\w+)\(\s*['\"]([^'\"]+)['\"](\s*,\s*\$\w+)?", b)
            if hm and (hm.group(1), hm.group(2)) in helpers:
                h = helpers[(hm.group(1), hm.group(2))]
                verb, route = h["verb"], hm.group(3) + ("/{id}" if h["id"] and hm.group(4) else "")
        if not route: continue
        pt = re.search(r"(\w+Params)::", b)
        routed.append({"recv": full, "name": m["name"], "http": verb, "route": "/" + route.lstrip("/"), "paramsType": resolve(pt.group(1), c) if pt else None})
# delegation to a same-named routed method (MessagesService::create -> MessagesRawService::create)
by = {(r["recv"], r["name"]): r for r in routed}
for _ in range(2):
    for full, c in classes.items():
        for m in methods_of(c):
            if (full, m["name"]) in by: continue
            if re.search(r"->\w+->" + m["name"] + r"\(|->" + m["name"] + r"\(", m["body"]):
                hit = next((r for (rc, rn), r in by.items() if rn == m["name"] and rc != full and rc.split("\\")[-1].replace("Raw", "") == full.split("\\")[-1].replace("Raw", "")), None)
                if hit:
                    x = {**hit, "recv": full}; routed.append(x); by[(full, m["name"])] = x
# interfaces: an interface's methods route like its implementations'
impls = {}
for full, c in classes.items():
    for i in c["implements"]:
        r = resolve(i, c)
        if r: impls.setdefault(r, []).append(full)
for iface, cs in impls.items():
    for cl in cs:
        for (rc, rn), r in list(by.items()):
            if rc == cl and (iface, rn) not in by:
                x = {**r, "recv": iface}; routed.append(x); by[(iface, rn)] = x
routed_types = {r["recv"] for r in routed}
res = []
for full, c in classes.items():
    for m in methods_of(c):
        if m["args"].strip() == "" and m["ret"]:
            t = resolve(m["ret"].split("|")[0], c)
            if t: res.append({"owner": full, "field": m["name"] + "()", "type": t})
    for p in re.finditer(r"public\s+(?:readonly\s+)?([?\w\\]+)\s+\$(\w+)\s*;", c["body"]):
        t = resolve(p.group(1), c)
        if t: res.append({"owner": full, "field": p.group(2), "type": t})
    for d in re.finditer(r"@method\s+static\s+([\w\\]+)\s+(\w+)\(\s*\)", c["doc"]):
        t = resolve(d.group(1), c)
        # a facade over another package's client: its use-imported type name, kept as written
        ext = None if t else d.group(1)[1:] if d.group(1).startswith("\\") else (c["uses"].get(d.group(1).split("\\")[0], "") + d.group(1)[len(d.group(1).split("\\")[0]):] if d.group(1).split("\\")[0] in c["uses"] else None)
        if t or ext: res.append({"owner": full, "field": d.group(2) + "()", "type": t or ext, "static": True, **({"external": True} if ext else {})})
holders = set(routed_types)
changed = True
while changed:
    changed = False
    for r in res:
        if r["type"] in holders and r["owner"] not in holders: holders.add(r["owner"]); changed = True
facades = [r for r in res if r.get("external")]
res = [r for r in res if r["owner"] in holders and r["type"] in holders] + facades
# makers: any public method (with arguments or not, static or not) returning a client-holding type, so app code like
# OpenAI::client($key), OpenAI::factory()->withApiKey($k)->make() or Anthropic::client() types its result
for full, c in classes.items():
    for m in methods_of(c):
        if not m["ret"]: continue
        t = resolve(m["ret"].split("|")[0], c)
        if t and (t in holders or t.endswith("Factory")) and m["args"].strip():
            res.append({"owner": full, "field": m["name"] + "()", "type": t, "maker": True})
        elif t and t.endswith("Factory"):
            res.append({"owner": full, "field": m["name"] + "()", "type": t, "maker": True})
# a factory's methods returning itself or a holder chain too (withApiKey()->make())
for full, c in classes.items():
    if not full.endswith("Factory"): continue
    for m in methods_of(c):
        t = resolve(m["ret"].split("|")[0], c) if m["ret"] else None
        if m["ret"] in ("self", "static"): t = full
        if t: res.append({"owner": full, "field": m["name"] + "()", "type": t, "maker": True})
targets = {r["type"] for r in res}
clients = [{"type": f, "facade": True} for f in sorted({r["owner"] for r in facades})] + [{"type": c, **({"facade": True} if any(r.get("static") and r["owner"] == c for r in res) else {})} for c in holders if c not in targets and classes[c]["kind"] == "class"]
# params types: attribute-declared properties
ptypes = {}
for full, c in classes.items():
    f = {}
    for a in re.finditer(r"#\[(?:Required|Optional)(?:\(\s*(?:['\"]([a-z][\w]*)['\"])?[^)]*\))?\]\s*(?:#\[[^\]]*\]\s*)*public\s+[?\w\\|]+\s+\$(\w+)", c["body"]):
        f[a.group(2)] = a.group(1) or a.group(2)
    if f: ptypes[full] = {"fields": f}
bases = [m.group(1) for s in srcs.values() for m in re.finditer(r"['\"](?:https://)?(api\.[\w.-]+(?:/[\w./-]*)?)['\"]", s)]
base = max(set(bases), key=bases.count) if bases else None
bp = re.sub(r"^[^/]+", "", base or "").rstrip("/")
VERS = re.compile(r"^/v\d+(beta\d*)?/")
for r in routed:
    keep = not bp or r["route"].startswith(bp + "/") or bool(VERS.match(r["route"]))
    r["op"] = r["http"] + " " + (r["route"] if keep else bp + r["route"])
urls = {}
for s in srcs.values():
    for m in re.finditer(r"['\"](?:https://)?(api\.[\w.-]+)", s): urls[m.group(1)] = urls.get(m.group(1), 0) + 1
out = {"lang": "php", "package": pkg, "version": version, "baseURL": ("https://" + base) if base else None, "urlHosts": urls,
       "namespaces": sorted({classes[c]["ns"] for c in holders if classes[c]["ns"]}), "clients": clients, "resources": res,
       "methods": sorted(routed, key=lambda r: (r["recv"], r["name"])), "paramTypes": ptypes}
print(json.dumps(out))
