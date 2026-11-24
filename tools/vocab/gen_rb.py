# SDK vocabulary from an unpacked gem (Ruby source, text only, never loaded or run).
# Usage: python3 -I gen_rb.py <gem dir> <gem name> <version> -> JSON on stdout
# Generic over Ruby SDKs:
# - classes by module/class nesting (indentation), full names like OpenAI::Resources::Chat::Completions;
# - resources: instance variables or methods that construct another class with the client (@chat = X.new(client: …),
#   def assistants; @assistants ||= X.new(client: self)), keyed by the reader name (attr_reader or the method);
# - methods: a public def whose body sends a request: `method: :post, path: "chat/completions"` (Stainless) or a
#   verb helper with a path (json_post(path: "/chat/completions"), get(path: "/assistants")); path arrays and
#   interpolations become {id};
# - params: the method's params class (XParams.dump_request(params)) and its `optional :name` / `required :name`
#   fields (Ruby keyword arguments are the wire names);
# - clients: classes whose initialize builds resources; the base URL from a base_url default.
import json, os, re, sys
root, gem, version = sys.argv[1], sys.argv[2], sys.argv[3]
files = {}
for dp, dn, fn in os.walk(os.path.join(root, "lib")):
    for f in fn:
        if f.endswith(".rb"): files[os.path.join(dp, f)] = open(os.path.join(dp, f), encoding="utf-8", errors="replace").read()
classes = {}   # full name -> {"defs": {name: body}, "ivars": {...}}
aliases = {}   # constant alias (OpenAI::Chat) -> its target as written, with the module it's written in
VERB = re.compile(r"method:\s*:(get|post|put|patch|delete)\b|\b(?:json_|multipart_)?(get|post|put|patch|delete)\s*\(\s*path:", re.I)
def parse(path, src):
    lines = src.split("\n")
    stack = []  # (indent, name, kind)
    cur_def = None
    for i, l in enumerate(lines):
        m = re.match(r"^(\s*)(module|class)\s+([A-Z][\w:]*)", l)
        if m:
            ind = len(m.group(1))
            while stack and stack[-1][0] >= ind: stack.pop()
            stack.append((ind, m.group(3), m.group(2)))
            full = "::".join(s[1] for s in stack)
            classes.setdefault(full, {"defs": {}, "path": path, "private": set()})
            cur_def = None
            continue
        if not stack: continue
        full = "::".join(s[1] for s in stack)
        a = re.match(r"^\s*([A-Z]\w*)\s*=\s*(?:::)?([A-Z][\w:]+)\s*$", l)
        if a: aliases[f"{full}::{a.group(1)}"] = (a.group(2), full)
        d = re.match(r"^(\s*)def\s+(?:self\.)?([a-z_]\w*[!?]?)\s*(\(([^)]*)\))?", l)
        if d and len(d.group(1)) > stack[-1][0]:
            # body: lines until the matching `end` at the same indentation
            ind = len(d.group(1)); body = []
            for j in range(i + 1, min(len(lines), i + 400)):
                if re.match(r"^\s{%d}end\b" % ind, lines[j]): break
                body.append(lines[j])
            classes[full]["defs"][d.group(2)] = {"args": d.group(4) or "", "body": "\n".join(body), "line": i + 1}
        if re.match(r"^\s*private\s*$", l): classes[full]["private"].add(i)
for p, s in files.items(): parse(p, s)
def resolve(name, ctx, depth=0):
    name = name.lstrip(":")
    parts = ctx.split("::")
    for k in range(len(parts), -1, -1):
        cand = "::".join(parts[:k] + [name]) if k else name
        if cand in classes: return cand
        # an alias on the way: OpenAI::Chat::CompletionCreateParams with OpenAI::Chat = OpenAI::Models::Chat
        segs = cand.split("::")
        for j in range(len(segs), 0, -1):
            head = "::".join(segs[:j])
            if head in aliases and depth < 4:
                tgt, where = aliases[head]
                base = resolve(tgt, where, depth + 1) or tgt
                r = resolve("::".join([base] + segs[j:]), "", depth + 1)
                if r: return r
    return None
methods, res, ptypes_used = [], [], {}
for full, c in classes.items():
    for name, d in c["defs"].items():
        b = d["body"]
        # resources built with the client
        for m in re.finditer(r"@(\w+)\s*(?:\|\|)?=\s*([A-Z][\w:]*)\.new\(\s*client:", b):
            t = resolve(m.group(2), full)
            if t: res.append({"owner": full, "field": m.group(1), "type": t})
        v = VERB.search(b)
        pm = re.search(r"path:\s*(\"[^\"]*\"|'[^']*'|\[[^\]]*\]|%w\[[^\]]*\])", b)
        if not v or not pm or name.startswith("_") or name in ("initialize", "request"): continue
        raw = pm.group(1)
        if raw.startswith("["):
            lit = re.search(r"\"([^\"]*)\"|'([^']*)'", raw)
            route = (lit.group(1) or lit.group(2)) if lit else None
            route = re.sub(r"%\d*\$?[sd]", "{id}", route or "")
        else:
            route = raw[1:-1]
        route = re.sub(r"#\{[^}]*\}", "{id}", route).split("?")[0]
        if not route: continue
        pt = re.search(r"([A-Z][\w:]*Params)\.dump_request", b)
        ptn = resolve(pt.group(1), full) if pt else None
        methods.append({"recv": full, "name": name, "http": (v.group(1) or v.group(2)).upper(), "route": route if route.startswith("/") else "/" + route, "paramsType": ptn})
        if ptn: ptypes_used[ptn] = True
# param fields: optional/required declarations in the params class (and its nested classes are separate types)
ptypes = {}
for pt in ptypes_used:
    src = files.get(classes[pt]["path"], "")
    body = src  # declarations live in the class body; nested classes are rare in top-level params files
    fields = {}
    for m in re.finditer(r"^\s{4,8}(?:optional|required)\s+:(\w+)", body, re.M): fields.setdefault(m.group(1), m.group(1))
    if fields: ptypes[pt] = {"fields": fields}
# base URL and ops
bases = [m.group(1) for s in files.values() for m in re.finditer(r"\"(https://api\.[\w.-]+(?:/[\w./-]*)?)\"", s)]
base = max(set(bases), key=bases.count) if bases else None
bp = re.sub(r"^https://[^/]+", "", base or "").rstrip("/")
# a separate API version the client joins between the base and the path (ruby-openai: DEFAULT_API_VERSION = "v1")
if not bp:
    vers = [m.group(1) for s2 in files.values() for m in re.finditer(r"(?i)api_version\w*\s*(?:=|:|\|\|=)\s*\"(v\d+(?:beta\d*)?)\"", s2)]
    if vers: bp = "/" + max(set(vers), key=vers.count)
VERSIONED = re.compile(r"^/v\d+(beta\d*)?/")
for m in methods:
    keep = not bp or m["route"].startswith(bp + "/") or bool(VERSIONED.match(m["route"]))
    m["op"] = m["http"] + " " + (m["route"] if keep else bp + m["route"])
routed = {m["recv"] for m in methods}
holders = set(routed)
changed = True
while changed:
    changed = False
    for r in res:
        if r["type"] in holders and r["owner"] not in holders: holders.add(r["owner"]); changed = True
clients = [{"type": c} for c, x in classes.items() if c in holders and "initialize" in x["defs"] and any(r["owner"] == c for r in res) and not any(r["type"] == c for r in res)]
urls = {}
for s in files.values():
    for m in re.finditer(r"\"https://([\w.-]+)", s): urls[m.group(1)] = urls.get(m.group(1), 0) + 1
out = {"lang": "rb", "package": gem, "version": version, "baseURL": base, "urlHosts": urls, "namespaces": sorted({c.split("::")[0] for c in holders}),
       "clients": clients, "resources": [r for r in res if r["owner"] in holders and r["type"] in holders],
       "methods": sorted(methods, key=lambda m: (m["recv"], m["name"])), "paramTypes": ptypes}
print(json.dumps(out))
