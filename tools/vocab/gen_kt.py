# SDK vocabulary from a Maven -sources.jar (Kotlin or Java source, text only, never compiled or run).
# Usage: python3 -I gen_kt.py <sources dir> <group:artifact> <version> -> JSON on stdout
# Generic over JVM SDKs:
# - routes: a function body that sets an HTTP verb (HttpMethod.POST / .method("POST")) and a path
#   (.addPathSegments("v1", "messages", params._pathParam(0)) or a "/v1/..." literal); the route belongs to the
#   function's first parameter type (the params type), so every service method taking that type has the op;
# - resources: zero-argument functions (Kotlin `fun messages(): MessageService`, Java `MessageService messages()`)
#   whose return type holds routed methods (fixpoint);
# - params fields: builder methods named after a body property with @JsonProperty("wire") (Kotlin
#   `private val topK: JsonField<Long>` under @JsonProperty("top_k")), so `builder().topK(5)` maps to top_k;
# - clients: types whose builder()/fromEnv() returns a resource holder.
import json, os, re, sys
root, ga, version = sys.argv[1], sys.argv[2], sys.argv[3]
srcs = {}
for dp, dn, fn in os.walk(root):
    for f in fn:
        if f.endswith((".kt", ".java")):
            srcs[os.path.join(dp, f)] = open(os.path.join(dp, f), encoding="utf-8", errors="replace").read()
def pkg_of(src):
    m = re.search(r"^package\s+([\w.]+)", src, re.M); return m.group(1) if m else ""
# brace matching once per file (strings, chars and comments skipped)
_MATCH = {}
def matches(src):
    k = id(src)
    if k in _MATCH: return _MATCH[k]
    m, stack, i, n = {}, [], 0, len(src)
    while i < n:
        c = src[i]
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            j = src.find("\n", i); i = n if j < 0 else j; continue
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            j = src.find("*/", i + 2); i = n if j < 0 else j + 2; continue
        if c == '"':
            if src.startswith('"""', i):
                j = src.find('"""', i + 3); i = n if j < 0 else j + 3; continue
            j = i + 1
            while j < n and src[j] != '"' and src[j] != "\n":
                j += 2 if src[j] == "\\" else 1
            i = j + 1; continue
        if c == "'" and i + 2 < n and (src[i + 2] == "'" or src[i + 1] == "\\"):
            j = src.find("'", i + 2 if src[i + 1] != "\\" else i + 3); i = n if j < 0 else j + 1; continue
        if c == "{": stack.append(i)
        elif c == "}" and stack: m[stack.pop()] = i
        i += 1
    _MATCH[k] = m
    return m
def span_after(src, i):
    j = src.find("{", i)
    if j < 0: return None
    e = matches(src).get(j)
    return (j, e) if e is not None else None
def body_after(src, i):
    sp = span_after(src, i)
    return src[sp[0] + 1:sp[1]] if sp else ""
# top-level and nested type declarations, with the full name (outer.Inner)
types = {}
decl = re.compile(r"^(\s*)(?:(?:public|internal|private|protected|open|abstract|sealed|data|final|static)\s+)*(interface|class|object|enum class)\s+(\w+)", re.M)
fq_by_simple = {}
for path, src in srcs.items():
    pk = pkg_of(src)
    stack = []
    for m in decl.finditer(src):
        ind = len(m.group(1))
        while stack and stack[-1][0] >= ind: stack.pop()
        name = ".".join([s[1] for s in stack] + [m.group(3)])
        full = f"{pk}.{name}" if pk else name
        stack.append((ind, m.group(3)))
        types[full] = {"path": path, "pkg": pk, "at": m.start(), "kind": m.group(2)}
        fq_by_simple.setdefault(m.group(3), []).append(full)
IMPORTS = {}
for path, src in srcs.items():
    IMPORTS[path] = {m.group(2) or m.group(1).split(".")[-1]: m.group(1) for m in re.finditer(r"^import\s+([\w.]+?)(?:\s+as\s+(\w+))?\s*;?\s*$", src, re.M) if not m.group(1).endswith("*")}
def resolve(simple, ctx_pkg, path=None, owner=None):
    simple = simple.split("<")[0].strip().rstrip("?")
    head = simple.split(".")[0]
    if path and head in IMPORTS.get(path, {}):
        cand = IMPORTS[path][head] + simple[len(head):]
        if cand in types: return cand
    # nested in the enclosing type (Builder inside MessageCreateParams)
    if owner:
        o = owner
        while o:
            if f"{o}.{simple}" in types: return f"{o}.{simple}"
            o = o.rsplit(".", 1)[0] if "." in o else ""
    if simple in ("Unit", "void", "String", "Boolean", "Long", "Int", "Double"): return None
    c = fq_by_simple.get(simple.split(".")[-1], [])
    if "." in simple:
        c2 = [x for x in c if x.endswith("." + simple)]
        if c2: c = c2
    same = [x for x in c if x.startswith(ctx_pkg + ".")]
    return (same or c or [None])[0] if len(same or c) == 1 or same else (c[0] if len(c) == 1 else None)
# each type's own body, once per file: its brace span with the spans of directly nested types cut out
OWN = {}
by_path = {}
for full, t in types.items(): by_path.setdefault(t["path"], []).append(full)
for path, names in by_path.items():
    src = srcs[path]
    spans = []
    for full in names:
        sp = span_after(src, types[full]["at"])
        if sp: spans.append((sp[0], sp[1], full))
    spans.sort()
    for i, (a0, b0, full) in enumerate(spans):
        parts, cur, j = [], a0 + 1, i + 1
        while j < len(spans) and spans[j][0] < b0:
            ca, cb, _ = spans[j]
            if ca >= cur:
                parts.append(src[cur:ca + 1]); cur = cb
            # skip grandchildren: they lie inside this child
            k = j + 1
            while k < len(spans) and spans[k][0] < cb: k += 1
            j = k
        parts.append(src[cur:b0])
        OWN[full] = "".join(parts)
def own_body(full): return OWN.get(full, "")
# routes per params type
route_of = {}
fun_re = re.compile(r"(?:override\s+)?fun\s+(\w+)\s*\(\s*(\w+)\s*:\s*([\w.]+)[^)]*\)\s*(?::\s*([\w.<>?, ]+?))?\s*(?:=|\{)", re.S)
jfun_re = re.compile(r"(?:public\s+)?(?:[\w.<>?, ]+?)\s+(\w+)\s*\(\s*([\w.]+)\s+(\w+)[^)]*\)\s*\{", re.S)
for path, src in srcs.items():
    pk = pkg_of(src)
    for m in fun_re.finditer(src):
        if src[m.end() - 1] == "{": body = body_after(src, m.end() - 1)
        else:
            # an expression body: up to the next declaration or blank line
            rest = src[m.end(): m.end() + 2000]
            cut = min([x for x in (rest.find("\n\n"), rest.find(" fun "), rest.find("\n    override")) if x >= 0] or [len(rest)])
            body = rest[:cut]
        verb = re.search(r"HttpMethod\.(GET|POST|PUT|PATCH|DELETE)\b|\.method\(\s*\"(GET|POST|PUT|PATCH|DELETE)\"", body)
        segs = re.search(r"\.addPathSegments\(([^)]*)\)", body)
        lit = re.search(r"\"(/v\d+/[\w/{}.-]+)\"", body)
        if not verb or not (segs or lit): continue
        if segs:
            parts = []
            for a in re.split(r",\s*", segs.group(1)):
                a = a.strip()
                s = re.fullmatch(r"\"([^\"]*)\"", a)
                parts.append(s.group(1) if s else "{id}")
            route = "/" + "/".join(p for p in parts if p)
        else:
            route = re.sub(r"\{[^}]*\}", "{id}", lit.group(1))
        pt = resolve(m.group(3), pk, path)
        if pt: route_of.setdefault(pt, (verb.group(1) or verb.group(2), route, m.group(1)))
# service methods: every fun / Java method whose first parameter is a routed params type
methods = []
for full, t in types.items():
    body = own_body(full)
    for m in fun_re.finditer(body):
        pt = resolve(m.group(3), t["pkg"], t["path"], full)
        if pt in route_of and m.group(1) == route_of[pt][2]:
            v, rt, _ = route_of[pt]
            methods.append({"recv": full, "name": m.group(1), "http": v, "route": rt, "paramsType": pt, "returns": (m.group(4) or "").strip()})
    for m in jfun_re.finditer(body):
        pt = resolve(m.group(2), t["pkg"], t["path"], full)
        if pt in route_of and m.group(1) == route_of[pt][2]:
            v, rt, _ = route_of[pt]
            methods.append({"recv": full, "name": m.group(1), "http": v, "route": rt, "paramsType": pt, "returns": ""})
routed = {m["recv"] for m in methods}
# resources: zero-arg functions returning a type that holds routed methods (fixpoint over declared returns)
res_types = set(routed)
zero = []
for full, t in types.items():
    body = own_body(full)
    for m in re.finditer(r"fun\s+(\w+)\s*\(\s*\)\s*:\s*([\w.]+)", body): zero.append((full, m.group(1), resolve(m.group(2), t["pkg"], t["path"], full)))
    for m in re.finditer(r"(?:public\s+)?([\w.]+)\s+(\w+)\s*\(\s*\)\s*[;{]", body): zero.append((full, m.group(2), resolve(m.group(1), t["pkg"], t["path"], full)))
changed = True
while changed:
    changed = False
    for owner, name, rt in zero:
        if rt in res_types and owner not in res_types: res_types.add(owner); changed = True
resources = [{"owner": o, "field": n + "()", "type": rt} for o, n, rt in zero if o in res_types and rt in res_types and o != rt]
clients = [{"type": o} for o, n, rt in zero if n in ("build", "fromEnv") and rt in res_types]
# params fields: wire names from @JsonProperty on body properties, keyed by the property name
ptypes = {}
for pt in route_of:
    t = types.get(pt)
    if not t: continue
    src = srcs[t["path"]]
    fields = {}
    for m in re.finditer(r"@JsonProperty\(\"([a-z][a-z0-9_]*)\"\)\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:(?:private|internal|public|override)\s+)*(?:(?:val|var)\s+)?(\w+)\s*:", src):
        fields.setdefault(m.group(2), m.group(1))
    for m in re.finditer(r"@JsonProperty\(\"([a-z][a-z0-9_]*)\"\)\s*(?:@\w+\s*)*fun\s+_(\w+)\s*\(", src):
        fields.setdefault(m.group(2), m.group(1))
    for m in re.finditer(r"@JsonProperty\(\"([a-z][a-z0-9_]*)\"\)[\s\S]{0,120}?(?:private|public|protected)?\s*(?:final\s+)?[\w.<>?, ]+\s+(\w+)\s*[;=]", src):
        fields.setdefault(m.group(2), m.group(1))
    if fields: ptypes[pt] = {"fields": fields}
urls = {}
for src in srcs.values():
    for m in re.finditer(r"\"https://([\w.-]+)", src): urls[m.group(1)] = urls.get(m.group(1), 0) + 1
# default base URL: an https api. literal with a path; its path prefixes routes that don't carry it
bases = [m.group(0)[1:] for src in srcs.values() for m in re.finditer(r"\"https://api\.[\w.-]+(?:/[\w./-]*)?", src)]
base = max(set(bases), key=bases.count) if bases else None
bp = re.sub(r"^https://[^/]+", "", base or "").rstrip("/")
for m in methods:
    if bp and not m["route"].startswith(bp + "/"): m["route"] = bp + m["route"]
out = {"lang": "java", "baseURL": base, "package": ga, "version": version, "urlHosts": urls, "namespaces": sorted({t["pkg"] for t in types.values() if t["pkg"]}),
       "clients": clients, "resources": sorted(resources, key=lambda r: (r["owner"], r["field"])),
       "methods": [{**m, "op": f'{m["http"]} {m["route"]}'} for m in sorted(methods, key=lambda m: (m["recv"], m["name"]))], "paramTypes": ptypes}
print(json.dumps(out))
