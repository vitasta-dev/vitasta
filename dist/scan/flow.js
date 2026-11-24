/**
 * One value tracer for every language (item 4/F, generalised from the Go tracer). Where does a value that reaches a
 * provider come from? Two starting points:
 *   setting mode  each request setting another rule found (params.Temperature = anthropic.Float(c.topP),
 *                 .temperature(resolveTemperature(r, cfg)), ChatOptions { Temperature = _temperature }): the value
 *                 is traced back and every source line is reported as the same op and wire name
 *   value mode    a provider URL built from names ("https://graph.facebook.com/" + apiVersion + "/"): the names are
 *                 evaluated back to literals; when that gives a versioned provider URL, the URL line and every line
 *                 the version came through are reported as the version pin
 * The steps are syntax, not SDK knowledge, with a small per-language table (src/scan/flowlang.ts):
 *   fields       x.f / this.f / self.f / $this->f / @f, and an implicit field of the enclosing class: the field's
 *                initializer, constructor and setter assignments, object literals and initializers (T{F: v},
 *                new T { F = v }, T(f=v)), builder calls .f(v)
 *   getters      x.getF() / x.GetF() / x.f(): the method's returns, or the field itself when there's no method body
 *                (Lombok, records, properties)
 *   constants    T.NAME / NAME: static, const, enum and module-level declarations
 *   calls        a function the repo defines: its returns; new T(v) of a one-value type: v
 *   alternatives a ? b : c, a ?? b, a ?: b, a || b, a or b: each side
 *   defaults     config reads (cfg.get(KEY), getOrDefault(k, d), os.getenv("X", d), env("X", d)): the default and
 *                the key's declaration (Options.key("x").defaultValue("v23.0")); parameter defaults; CLI flags
 *                (pflag, argparse) and annotations (@Value("${k:0.7}"), @Option(defaultValue = "…"))
 *   names        a local's assignments above it, a parameter's arguments at the call sites
 * Up to twelve hops (and a work budget per trace); every non-test file of the traced languages is read for this pass.
 */
import { matchUrl, modelRef, urlVersionOf } from "../providers.js";
import { foreignVendorOf, vendorDirs } from "./vendors.js";
import { LANGS } from "./flowlang.js";
const KEYWORD_LITERAL = /^(?:None|True|False|NotImplemented|Ellipsis|null|nil|undefined|true|false|NaN|Infinity|NULL|TRUE|FALSE)$/;
const MAX_HOPS = 12;
const MAX_FRONTIER = 64;
const MAX_WORK = 400;
/** An expression that picks a named constant: Type.NAME or NAME (ALL_CAPS) */
const CHOICE = /(?:^|[^\w.])(?:[A-Z]\w*\.)?[A-Z][A-Z0-9]*_[A-Z0-9_]*\b|(?:^|[^\w.])[A-Z]\w*\.[A-Z][A-Z0-9_]+\b/;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const dirOf = (rel) => rel.split("/").slice(0, -1).join("/");
/** Commas outside brackets and strings */
function topLevelCommas(s) {
    let d = 0, n = 0, q = "";
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (q) {
            if (c === "\\")
                i++;
            else if (c === q)
                q = "";
            continue;
        }
        if (c === '"' || c === "'" || c === "`")
            q = c;
        else if (c === "(" || c === "[" || c === "{")
            d++;
        else if (c === ")" || c === "]" || c === "}")
            d--;
        else if (c === "," && d === 0)
            n++;
    }
    return n;
}
export function flowUsages(files, found, cfgValues) {
    const code = files.filter((f) => LANGS[f.lang] && f.source.length <= 2_000_000);
    if (!code.length)
        return [];
    const byRel = new Map(code.map((f) => [f.rel, f]));
    const syn = (rel) => LANGS[byRel.get(rel).lang];
    const starts = new Map();
    const lineAt = (rel, at) => {
        let st = starts.get(rel);
        if (!st) {
            st = [0];
            const s = byRel.get(rel).source;
            for (let i = 0; i < s.length; i++)
                if (s[i] === "\n")
                    st.push(i + 1);
            starts.set(rel, st);
        }
        let lo = 0, hi = st.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (st[mid] <= at)
                lo = mid;
            else
                hi = mid - 1;
        }
        return lo + 1;
    };
    const offsetOfLine = (rel, line) => {
        lineAt(rel, 0);
        return starts.get(rel)[line - 1] ?? 0;
    };
    const T0 = Date.now();
    const tick = (what) => { if (process.env.VITASTA_FLOW_DEBUG)
        console.error("flow time", what, (Date.now() - T0) / 1000); };
    // declarations, per file
    const fns = [], classes = [];
    for (const f of code) {
        const L = syn(f.rel);
        classes.push(...L.classes(f.source).map((c) => ({ ...c, file: f.rel })));
        fns.push(...L.functions(f.source).map((x) => ({ ...x, file: f.rel })));
    }
    tick("parsed");
    const fnsByFile = new Map(), clsByFile = new Map();
    for (const x of fns)
        fnsByFile.set(x.file, [...(fnsByFile.get(x.file) ?? []), x]);
    for (const c of classes)
        clsByFile.set(c.file, [...(clsByFile.get(c.file) ?? []), c]);
    const innermost = (xs, at) => {
        let best;
        for (const x of xs ?? [])
            if (x.start <= at && at <= x.end && (!best || x.start > best.start))
                best = x;
        return best;
    };
    const clsAt = (rel, at) => innermost(clsByFile.get(rel), at);
    const fnAt = (rel, at) => innermost(fnsByFile.get(rel), at);
    for (const x of fns)
        if (!x.cls)
            x.cls = x.recv?.type ?? clsAt(x.file, x.start - 1)?.name;
    const fnsByName = new Map();
    for (const x of fns)
        fnsByName.set(x.name, [...(fnsByName.get(x.name) ?? []), x]);
    const memo = (fn) => {
        const cache = new Map();
        return (...a) => {
            const k = JSON.stringify(a);
            if (!cache.has(k))
                cache.set(k, fn(...a));
            return cache.get(k);
        };
    };
    /** files that mention a word (for the repo-wide searches) */
    const mentioning = memo((w) => code.filter((f) => f.source.includes(w)));
    const simple = (t) => t.replace(/<.*$/, "").replace(/^[*&?\[\]]+/, "").split(/[.\\:]/).pop();
    /** A class's own name and its ancestors' (extends / implements), by simple name, as far as the repo declares them */
    const ancestorsOf = memo((c) => {
        const out = new Set([simple(c.name)]);
        const todo = [simple(c.name)];
        while (todo.length && out.size < 50) {
            const n = todo.pop();
            for (const k of classes) {
                if (simple(k.name) !== n)
                    continue;
                for (const p of [k.parent, ...(k.supers ?? [])])
                    if (p && !out.has(simple(p))) {
                        out.add(simple(p));
                        todo.push(simple(p));
                    }
            }
        }
        return out;
    });
    /** Classes a file imports statically (Java import static a.b.C.name / a.b.C.*; C# using static a.b.C) */
    const staticImports = memo((rel) => {
        const out = new Set();
        for (const m of byRel.get(rel).source.matchAll(/^[ \t]*(?:import\s+static\s+([\w.]+)\.(?:\w+|\*)\s*;|using\s+static\s+([\w.]+)\s*;)/gm))
            out.add(simple(m[1] ?? m[2]));
        return out;
    });
    /** The class an identifier stands for at a position (receiver, parameter, local, field of the enclosing class) */
    const typeOf = (rel, at, id) => {
        const f = byRel.get(rel);
        const L = syn(rel);
        if (L.self.includes(id))
            return clsAt(rel, at)?.name ?? fnAt(rel, at)?.recv?.type;
        const fn = fnAt(rel, at);
        if (fn?.recv?.name === id)
            return fn.recv.type;
        const p = fn?.params.find((x) => x.name === id);
        if (p?.type)
            return simple(p.type);
        const scope = fn ? f.source.slice(fn.start, at) : f.source.slice(Math.max(0, at - 4000), at);
        const t = L.localType(scope, id);
        if (t)
            return simple(t);
        const c = clsAt(rel, at);
        if (c) {
            const ft = L.fieldType(f.source.slice(c.start, c.end), id);
            if (ft)
                return simple(ft);
        }
        return undefined;
    };
    const classesNamed = (n) => classes.filter((c) => c.name === n || c.name.endsWith(`.${n}`) || c.name.endsWith(`\\${n}`));
    const TESTISH = /(^|\/)(tests?|__tests__|spec|testdata|fixtures?)\/|(Test|Tests|Spec|IT|_test|\.test|\.spec)\.\w+$/;
    const push = (out, rel, at, expr, via) => {
        if (TESTISH.test(rel))
            return;
        out.push({ file: rel, line: lineAt(rel, at), expr: expr.trim(), at, via });
    };
    /** Where a field of a class gets its value, across the repo */
    const fieldSources = memo((type, field, from) => {
        const out = [];
        // Go: an unqualified type is the referencing file's package's own (agent.Client isn't ollama.Client); a qualified
        // one (ollama.Client) is that package's (blind an Ollama client's c.Temperature joined to an
        // Anthropic request through a same-named type in another package)
        const goHome = from && byRel.get(from)?.lang === "go" && type ? (type.includes(".") ? { base: type.split(".")[0] } : { dir: dirOf(from) }) : undefined;
        const inHome = (rel) => !goHome || byRel.get(rel)?.lang !== "go" || (goHome.dir !== undefined ? dirOf(rel) === goHome.dir : dirOf(rel).split("/").pop() === goHome.base);
        const allCands = type ? classesNamed(type.split(".").pop()) : [];
        const cands = goHome ? allCands.filter((c) => inHome(c.file)) : allCands;
        for (const c of cands) {
            const f = byRel.get(c.file);
            const body = f.source.slice(c.start, c.end);
            for (const s of syn(c.file).fieldInits(body, field))
                push(out, c.file, c.start + s.at, s.expr, `${type}.${field} initializer`);
            for (const s of syn(c.file).selfAssigns(body, field))
                push(out, c.file, c.start + s.at, s.expr, `${field} =`);
            for (const s of syn(c.file).annotationDefaults(body, field))
                push(out, c.file, c.start + s.at, s.expr, `${field} annotation default`);
            // @Value("${spring.facebook.app.version}") on the field: the value the application*.properties / .yml gives that key
            if (cfgValues && byRel.get(c.file).lang === "java") {
                for (const m of body.matchAll(new RegExp(`@Value\\(\\s*"\\$\\{([\\w.\\-\\[\\]]+)\\}"\\s*\\)[\\s\\S]{0,120}?\\b${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[;=]`, "g"))) {
                    const v = cfgValues.get(m[1]);
                    if (!v)
                        continue;
                    push(out, c.file, c.start + m.index, JSON.stringify(v.value), `${field} @Value(${m[1]})`);
                    out[out.length - 1].cfg = `${v.file}:${v.line}`;
                }
            }
        }
        for (const f of mentioning(field)) {
            const L = syn(f.rel);
            // object literals / initializers / constructor keyword arguments of the type
            if (type)
                for (const s of L.literals(f.source, type, field))
                    push(out, f.rel, s.at, s.expr, `${type}{${field}: …}`);
            // v.field = …, v.setField(…), builder .field(…)
            for (const s of L.memberAssigns(f.source, field)) {
                // a builder chain counts only when its root is the field's type (or its Builder); an unknown root doesn't
                if (s.recv?.startsWith("#")) {
                    const root = s.recv.slice(1);
                    if (!type || (root !== type && root !== `${type}Builder`))
                        continue;
                }
                else if (type && s.recv) {
                    const rt = typeOf(f.rel, s.at, s.recv);
                    if (!rt || rt.split(".").pop() !== type.split(".").pop())
                        continue;
                    // (Go: the same-named type of another package isn't this one)
                    if (goHome) {
                        const homePkg = goHome.base ?? goHome.dir.split("/").pop();
                        if (rt.includes(".") ? rt.split(".")[0] !== homePkg : !inHome(f.rel))
                            continue;
                    }
                }
                push(out, f.rel, s.at, s.expr, s.how);
            }
        }
        return out;
    });
    /** A getter by name: its returns, or (no body anywhere) the field it reads */
    const getterSources = memo((type, name, field, rel) => {
        const out = [];
        // methods of the receiver's type, or of classes that extend / implement it; with no known type, the same file's
        const fit = (x) => {
            if (!type)
                return x.file === rel;
            // Go satisfies interfaces implicitly: a receiver typed as an interface (no struct of that name) takes any method
            if (byRel.get(x.file).lang === "go" && !classesNamed(type).length)
                return true;
            const c = x.cls ? simple(x.cls) : undefined;
            if (c === type)
                return true;
            const owner = c ? classes.find((k) => k.file === x.file && simple(k.name) === c) : undefined;
            return !!owner && (owner.parent === type || (owner.supers ?? []).includes(type));
        };
        const ms = (fnsByName.get(name) ?? []).filter(fit);
        for (const m of ms) {
            const f = byRel.get(m.file);
            for (const r of syn(m.file).returns(f.source.slice(m.start, m.end)))
                push(out, m.file, m.start + r.at, r.expr, `${name}()`);
        }
        if (!ms.length && type)
            out.push(...fieldSources(type, field));
        return out;
    });
    /** A constant: static / const / enum / module-level declarations, in the named class or the file's scope */
    const constSources = memo((rel, owner, name) => {
        const out = [];
        const scopes = owner ? classesNamed(owner).map((c) => ({ rel: c.file, from: c.start, to: c.end })) : [{ rel, from: 0, to: byRel.get(rel).source.length }, ...code.filter((x) => x.rel !== rel && x.rel.split("/").slice(0, -1).join("/") === rel.split("/").slice(0, -1).join("/")).map((x) => ({ rel: x.rel, from: 0, to: x.source.length }))];
        for (const sc of scopes) {
            const f = byRel.get(sc.rel);
            if (!f.source.includes(name))
                continue;
            for (const d of syn(sc.rel).constDecls(f.source.slice(sc.from, sc.to), name))
                push(out, sc.rel, sc.from + d.at, d.expr, `${owner ? owner + "." : ""}${name}`);
        }
        return out;
    });
    /** A name: assignments above it in its function (or file), a parameter's call-site arguments and default */
    const nameSources = (rel, at, id, ctx) => {
        if (KEYWORD_LITERAL.test(id))
            return [];
        const out = [];
        const f = byRel.get(rel);
        const L = syn(rel);
        const fn = fnAt(rel, at);
        const from = fn ? fn.start : Math.max(0, at - 20000);
        for (const a of L.localAssigns(f.source.slice(from, at), id))
            push(out, rel, from + a.at, a.expr, `${id} =`);
        const p = fn?.params.find((x) => x.name === id);
        if (fn && p) {
            if (p.def) {
                // at the parameter's own text in the signature (the def line), not the body's first line
                const head = f.source.slice(Math.max(0, fn.start - 2000), fn.start);
                const k = head.lastIndexOf(p.def);
                push(out, rel, k >= 0 ? fn.start - head.length + k : fn.start, p.def, `${id} default`);
            }
            const idx = fn.params.indexOf(p);
            // entered through a known call: that call's argument, not every call site's
            const viaCall = ctx && ctx.file === rel && ctx.start === fn.start ? ctx : undefined;
            if (viaCall) {
                const a = viaCall.named.get(id) ?? viaCall.args[idx];
                const before = out.length;
                if (a && a.text.trim())
                    push(out, viaCall.from, a.at + (a.text.length - a.text.trimStart().length), a.text, `${fn.name}(…) call`);
                if (viaCall.outer)
                    for (const y of out.slice(before))
                        y.ctx = viaCall.outer;
            }
            // which calls are this function's (Review: one class per provider, each with its own
            // private buildTextGenerationRequestBody): never another class's declaration of the same name; a self call
            // ($this->f, this.f, self.f, self::f) only from this class or one that extends it; and, when several classes
            // define the name, no call on another receiver (the provider is chosen at run time)
            const owner = fn.cls ? simple(fn.cls) : undefined;
            const several = owner ? (fnsByName.get(fn.name) ?? []).filter((x) => x.cls && simple(x.cls) !== owner).length > 0 : false;
            const callOk = (gRel, at) => {
                const before = byRel.get(gRel).source.slice(Math.max(0, at - 60), at);
                if (/\b(?:function|def|func|fn|fun|sub)\s+(?:&\s*)?$|(?:public|private|protected|static|internal|override|async|abstract|final)\s+(?:[\w<>\[\]?]+\s+)?$/.test(before))
                    return false;
                // a module-level function called from another file (blind an Ollama tool's own generate(…,
                // temperature=0.1) isn't the Claude module's generate): the caller doesn't define its own function of that
                // name, and when several modules define it, the caller imports it from this one
                // a module-level function called on a receiver (model.generate(…, temperature=1.0) on a transformers model):
                // only when the receiver is that module itself (router.generate after import router / import x.router as r,
                // a Go package name); any other object's method of the same name isn't this function
                if (!fn.cls) {
                    const recv = /([A-Za-z_$][\w$]*)\s*\.\s*$/.exec(before)?.[1];
                    if (recv && !/^(?:this|self|static|parent|super)$/.test(recv)) {
                        const stem = rel.split("/").pop().replace(/\.\w+$/, "");
                        const pkg = rel.split("/").slice(-2, -1)[0];
                        const caller = byRel.get(gRel).source;
                        const alias = new RegExp(String.raw `^\s*(?:import\s+[\w.]*\b${esc(stem)}\s+as\s+${esc(recv)}\b|from\s+[\w.]+\s+import\s+[^\n]*\b${esc(stem)}\s+as\s+${esc(recv)}\b|import\s+\*\s+as\s+${esc(recv)}\s+from\s+["'][^"']*${esc(stem)}["'])`, "m").test(caller);
                        if (recv !== stem && recv !== pkg && !alias)
                            return false;
                    }
                }
                if (!fn.cls && gRel !== rel && !/[.:>]\s*$/.test(before)) {
                    if ((fnsByName.get(fn.name) ?? []).some((x) => x.file === gRel && !x.cls))
                        return false;
                    const defs = (fnsByName.get(fn.name) ?? []).filter((x) => !x.cls);
                    if (new Set(defs.map((x) => x.file)).size > 1) {
                        const stem = rel.split("/").pop().replace(/\.\w+$/, "");
                        const mod = rel.replace(/\.\w+$/, "").replace(/\//g, ".");
                        const caller = byRel.get(gRel).source;
                        const imports = caller.split("\n").filter((x) => /^\s*(?:from\s+\S+\s+import\b|import\b|const\s+\{[^}]*\}\s*=\s*require\(|use\s|require)/.test(x));
                        if (!imports.some((x) => (x.includes(stem) || x.includes(mod)) && new RegExp(`\\b${fn.name}\\b`).test(x)))
                            return false;
                    }
                }
                if (!owner)
                    return true;
                const self = /(?:\$this\s*->|\bthis\s*\.|\bself\s*(?:\.|::)|\bstatic\s*::|\bparent\s*::|\bsuper\s*\.)\s*$/.test(before);
                const here = clsAt(gRel, at);
                const hereName = here ? simple(here.name) : undefined;
                if (self)
                    return !!here && (hereName === owner || ancestorsOf(here).has(owner));
                const recv = /([$\w]+)\s*(?:->|\.|::)\s*$/.exec(before)?.[1];
                if (recv && several)
                    return recv === owner;
                return true;
            };
            if (!viaCall)
                for (const g of mentioning(fn.name)) {
                    // (and the name it's imported under: from llm.claude import generate as claude_generate)
                    const stem = rel.split("/").pop().replace(/\.\w+$/, "");
                    const aliases = fn.cls ? [] : [...g.source.matchAll(new RegExp(String.raw `^\s*from\s+[\w.]*\b${esc(stem)}\s+import\s+[^\n]*\b${esc(fn.name)}\s+as\s+(\w+)|\bimport\s*\{[^}]*\b${esc(fn.name)}\s+as\s+(\w+)[^}]*\}\s*from\s*["'][^"']*${esc(stem)}["']`, "gm"))].map((m) => m[1] ?? m[2]);
                    const calls = [...syn(g.rel).callArgs(g.source, fn.name).map((c) => ({ c, alias: false })), ...aliases.flatMap((a) => syn(g.rel).callArgs(g.source, a).map((c) => ({ c, alias: true })))];
                    for (const { c, alias } of calls) {
                        if (g.rel === rel && c.at >= fn.start - 300 && c.at <= fn.start)
                            continue;
                        if (!alias && !callOk(g.rel, c.at))
                            continue;
                        const a = c.named.get(id) ?? c.args[idx];
                        if (a && a.text.trim())
                            push(out, g.rel, a.at + (a.text.length - a.text.trimStart().length), a.text, `${fn.name}(…) call`);
                    }
                }
        }
        // CLI flags bound to the name, in its file and (Go, where a package's files share their globals) the other files
        // of its package; a sibling Python / JS script's own argparse or commander flag isn't in scope
        const dir = rel.split("/").slice(0, -1).join("/");
        const shared = byRel.get(rel)?.lang === "go";
        for (const g of code) {
            if ((shared ? g.rel.split("/").slice(0, -1).join("/") !== dir : g.rel !== rel) || !g.source.includes(id))
                continue;
            for (const fl of syn(g.rel).flagDefaults(g.source, id))
                push(out, g.rel, fl.at, fl.expr, `${fl.flag} flag default`);
        }
        if (!out.length) {
            // an implicit field of the enclosing class (Java / C# / Kotlin _temperature, temperature)
            const c = clsAt(rel, at);
            if (c && L.implicitFields)
                out.push(...fieldSources(simple(c.name), id));
            if (!out.length)
                out.push(...constSources(rel, undefined, id));
        }
        return out;
    };
    /** One step back from an expression (memoised: URL parts and settings share chains) */
    const stepCache = new Map();
    const step = (src) => {
        const k = `${src.file}|${src.line}|${src.expr}|${src.ctx ? `${src.ctx.file}@${src.ctx.start}@${src.ctx.args[0]?.at ?? -1}` : ""}`;
        const hit = stepCache.get(k);
        if (hit)
            return hit;
        const r = step1(src);
        // what a step finds inside the function a call entered keeps that call's context
        if (src.ctx) {
            const f = fnAt(src.ctx.file, src.ctx.start + 1);
            for (const x of r)
                if (!x.ctx && f && x.file === src.ctx.file && x.at >= f.start && x.at <= f.end)
                    x.ctx = src.ctx;
        }
        if (process.env.VITASTA_FLOW_STEP && src.expr.includes(process.env.VITASTA_FLOW_STEP))
            console.error("step", src.file.split("/").pop(), src.line, JSON.stringify(src.expr.slice(0, 80)), "->", r.map((x) => `${x.via}@${x.file.split("/").pop()}:${x.line} ${JSON.stringify(x.expr.slice(0, 50))}`));
        stepCache.set(k, r);
        return r;
    };
    const step1 = (src) => {
        const L = syn(src.file);
        let e = L.clean(src.expr);
        if (!e)
            return [];
        const lit = L.literal(e);
        if (lit !== undefined)
            return [];
        if (/^(?:float|int|str|bool|double|string|number|boolean|decimal|long|short|byte|char|any|object|Optional\[.*\]|float32|float64|int32|int64)$/.test(e))
            return [];
        const alts = L.alternatives(e);
        if (alts.length > 1)
            return alts.map((a) => ({ ...src, expr: a, via: "one side" })).flatMap((s) => step(s).length ? step(s) : L.literal(L.clean(s.expr)) !== undefined ? [{ ...s }] : []);
        // a function literal / lambda: what it returns
        if (/^(?:func|function)\s*\(|^\([^)]*\)\s*(?::\s*\w+\s*)?=>|^lambda\b/.test(e)) {
            const out = [];
            const arrow = /=>\s*(?!\{)([\s\S]+)$/.exec(e) ?? /^lambda[^:]*:\s*([\s\S]+)$/.exec(e);
            if (arrow)
                out.push({ ...src, expr: arrow[1], via: "returned by a function literal" });
            const base = byRel.get(src.file).source.indexOf(e.slice(0, 40), Math.max(0, src.at - 5));
            for (const r of L.returns(e))
                push(out, src.file, (base < 0 ? src.at : base) + r.at, r.expr, "returned by a function literal");
            return out;
        }
        e = L.unwrap(e);
        // Go: a pointer read (*temp, a flag.Float64's value) is the variable it points through
        if (byRel.get(src.file).lang === "go")
            e = e.replace(/^\*\s*(?=[A-Za-z_])/, "");
        // a fully qualified name (com.acme.llm.Defaults.PROVIDER): its package prefix says nothing about the value
        const fq = /^(?:[a-z_][\w]*\.){2,}([A-Z][\w]*(?:\.[\w]+)+)$/.exec(e);
        if (fq && byRel.get(src.file).lang !== "py" && byRel.get(src.file).lang !== "go")
            e = fq[1];
        const cfg = L.configRead(e);
        if (cfg) {
            const out = [];
            if (cfg.def)
                out.push({ ...src, expr: cfg.def, via: "config default" });
            // env.getProperty("spring.facebook.app.version"): the value the application*.properties / .yml gives that key
            const lk = cfgValues && /^["']([\w.\-\[\]]+)["']$/.exec(cfg.key ?? "")?.[1];
            const lv = lk ? cfgValues.get(lk) : undefined;
            if (lv)
                out.push({ ...src, expr: JSON.stringify(lv.value), via: `property ${lk}`, cfg: `${lv.file}:${lv.line}` });
            if (cfg.key && /^[A-Za-z_][\w.]*$/.test(cfg.key)) {
                const parts = cfg.key.split(".");
                out.push(...constSources(src.file, parts.length > 1 ? parts[parts.length - 2] : undefined, parts[parts.length - 1]));
            }
            return out;
        }
        const dv = /\.(?:defaultValue|default|withDefault|orElse)\(\s*([^()]+?)\s*\)/.exec(e);
        if (dv)
            return [{ ...src, expr: dv[1], via: "declared default" }];
        const nw = L.construct(e);
        if (nw)
            return [{ ...src, expr: nw, via: "constructed value" }];
        // an accessor on a named constant (CloudApiVersion.DEFAULT.version()): the constant's value carries it
        const acc = /^((?:[A-Z]\w*\.)+[A-Z][\w]*)\s*\.\s*[a-z]\w*\s*\(\s*\)$/.exec(e);
        if (acc)
            return [{ ...src, expr: acc[1], via: "accessor of a constant" }];
        const g = L.getter(e);
        if (g)
            return getterSources(g.recv ? typeOf(src.file, src.at, g.recv) ?? (/^[A-Z]/.test(g.recv) ? g.recv : undefined) : clsAt(src.file, src.at)?.name, g.method, g.field, src.file);
        // a chain of fields (cfg.OpenAI.Model): each hop's declared type, as far as the repo declares it, then the last field
        const chain = !L.member(e) && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_]\w*){2,4}$/.exec(e.trim());
        if (chain) {
            const parts = e.trim().split(".");
            let t = typeOf(src.file, src.at, parts[0]);
            for (const seg of parts.slice(1, -1)) {
                const owner = t ? classesNamed(t)[0] : undefined;
                t = owner ? L.fieldType(byRel.get(owner.file).source.slice(owner.start, owner.end), seg) : undefined;
                if (t)
                    t = simple(t);
            }
            if (t)
                return fieldSources(t, parts[parts.length - 1], src.file);
        }
        const m = L.member(e);
        if (m) {
            if (/^[A-Z][A-Z0-9_]*$/.test(m.field) || /^[A-Z]/.test(m.recv)) {
                const c = constSources(src.file, m.recv, m.field);
                if (c.length)
                    return c;
            }
            // (a collection or untyped value, array $options / dict / Map / mixed, has no fields to look up: its keys come
            // from whoever passes it, below)
            const t0 = typeOf(src.file, src.at, m.recv);
            const t = (t0 && !/^(?:\??(?:array|iterable|mixed|object|dict|Dict|list|List|map|Map|Record|any|Any|Hash|hash|JSON|json)(?:<.*>|\[.*\])?)$/.test(t0) ? t0 : undefined) ?? (/^[A-Z]/.test(m.recv) ? m.recv : undefined);
            if (t || L.self.includes(m.recv))
                return fieldSources(t ?? clsAt(src.file, src.at)?.name, m.field, src.file);
            // the receiver's type isn't known: only assignments to the same name in the same file (r.temperature = …),
            // never every x.temperature in the repo
            const f = byRel.get(src.file);
            const out = [];
            for (const a of L.memberAssigns(f.source, m.field))
                if (a.recv === m.recv)
                    push(out, src.file, a.at, a.expr, a.how);
            // a field of a parameter (options.temperature): that field of each call's argument ({ temperature: 0.5 }), or
            // the same field of a name it passes on
            const fn = fnAt(src.file, src.at);
            const p = fn?.params.find((x) => x.name === m.recv);
            if (fn && p && !out.length) {
                const idx = fn.params.indexOf(p);
                const viaCall = src.ctx && src.ctx.file === src.file && src.ctx.start === fn.start ? src.ctx : undefined;
                const sites = viaCall ? [{ rel: viaCall.from, a: viaCall.named.get(m.recv) ?? viaCall.args[idx] }] : mentioning(fn.name).flatMap((g) => syn(g.rel).callArgs(g.source, fn.name).filter((c) => !(g.rel === src.file && c.at >= fn.start - 300 && c.at <= fn.start)).map((c) => ({ rel: g.rel, a: c.named.get(m.recv) ?? c.args[idx] })));
                for (const { rel, a } of sites.slice(0, 64)) {
                    if (!a || !a.text.trim())
                        continue;
                    const t = a.text.trim(), lead = a.at + (a.text.length - a.text.trimStart().length);
                    // an object, dict or array literal: { temperature: t }, {"temperature": t}, ['temperature' => $t], array(…)
                    if (/^(?:\{|\[|array\s*\()/.test(t)) {
                        const k = new RegExp(`(?:^|[,{\\[(\\s])["']?${m.field}["']?\\s*(?::|=>)\\s*([^,}\\]\\n]+)`).exec(t);
                        if (k)
                            push(out, rel, lead + k.index + k[0].indexOf(k[1]), k[1], `${fn.name}(…) call: ${m.field}`);
                    }
                    else if (/^[A-Za-z_$][\w$.]*$/.test(t) && !/^(?:undefined|null|nil|None|true|false|this|self)$/.test(t))
                        push(out, rel, lead, `${t}.${m.field}`, `${fn.name}(…) call`);
                }
            }
            return out;
        }
        const call = /^([A-Za-z_]\w*)\s*\((.*)\)$/s.exec(e);
        if (call) {
            const out = [];
            // a call without a receiver is the enclosing class's (or file's) function when there is one
            const argc = call[2].trim() ? topLevelCommas(call[2]) + 1 : 0;
            // a declaration that can't take this many arguments isn't this call's (unless it has a rest parameter)
            const fits = (y) => y.params.length >= argc || y.params.some((p) => /\.\.\.|^\*/.test(p.name) || /\.\.\./.test(p.type ?? ""));
            const all = (fnsByName.get(call[1]) ?? []).filter(fits);
            const here = clsAt(src.file, src.at);
            const same = all.filter((y) => (here && y.file === src.file && y.cls === here.name) || y.file === src.file);
            // in a class language, a call without a receiver is the class's own, an ancestor's, or a static import's
            // method; never a method of an unrelated class elsewhere in the repo
            const lang = byRel.get(src.file).lang;
            const classy = lang === "java" || lang === "cs" || lang === "php";
            const reach = (y) => {
                if (!classy)
                    return true;
                if (!y.cls)
                    return true;
                const c = simple(y.cls);
                if (here && ancestorsOf(here).has(c))
                    return true;
                return staticImports(src.file).has(c);
            };
            const defs = same.length ? same : all.filter(reach);
            // the call's own arguments, for the callee's parameters (a pass-through helper like defaultValue(a, b))
            const here0 = byRel.get(src.file).source;
            const base = here0.indexOf(e, Math.max(0, src.at - 5));
            const own = base >= 0 ? L.callArgs(e, call[1]).find((c) => c.at === 0 || e.slice(0, c.at).trim() === "") : undefined;
            for (const x of defs) {
                const f = byRel.get(x.file);
                const ctx = own && defs.length === 1 ? { from: src.file, outer: src.ctx, file: x.file, start: x.start, args: own.args.map((a) => ({ text: a.text, at: base + a.at })), named: new Map([...own.named].map(([n, a]) => [n, { text: a.text, at: base + a.at }])) } : undefined;
                for (const r of L.returns(f.source.slice(x.start, x.end))) {
                    const before = out.length;
                    push(out, x.file, x.start + r.at, r.expr, `${call[1]}() returns`);
                    if (ctx)
                        for (const y of out.slice(before))
                            y.ctx = ctx;
                }
            }
            // no function of that name: a variable holding a function (temperature := func() float32 { … }; temperature())
            if (!defs.length && !call[2].trim())
                return nameSources(src.file, src.at, call[1]);
            return out;
        }
        // a keyword literal (None, True, null, nil, undefined …) ends the trace: it's a value, never a name to look up
        //
        if (KEYWORD_LITERAL.test(e))
            return [];
        if (/^[A-Za-z_$@][\w$]*$/.test(e))
            return nameSources(src.file, src.at, e.replace(/^[@$]/, ""), src.ctx);
        return [];
    };
    /** Trace back from a starting expression; every source line, and whether a literal was reached on its path */
    const traceCache = new Map();
    const trace = (start, budget = MAX_WORK) => {
        const ck = `${start.file}|${start.line}|${start.expr}|${budget}`;
        const cached = traceCache.get(ck);
        if (cached)
            return cached;
        const r = trace1(start, budget);
        traceCache.set(ck, r);
        return r;
    };
    const trace1 = (start, budget) => {
        const seen = new Set();
        const srcs = [];
        const lits = [];
        let frontier = [{ s: start, path: [] }];
        let work = 0;
        for (let hop = 0; hop < MAX_HOPS && frontier.length; hop++) {
            const next = [];
            for (const { s, path } of frontier.slice(0, Math.max(MAX_FRONTIER, budget >> 2))) {
                if (++work > budget)
                    break;
                const L = syn(s.file);
                const l = L.literal(L.clean(s.expr));
                if (l !== undefined && path.length) {
                    lits.push({ lit: l, path });
                    continue;
                }
                for (const x of step(s)) {
                    const k = `${x.file}|${x.line}|${x.expr}`;
                    if (seen.has(k))
                        continue;
                    seen.add(k);
                    x.chain = [...path, x].map((y) => `${y.via} (${y.file}:${y.line})`).join(" ← ");
                    x.path = path;
                    srcs.push(x);
                    const lx = syn(x.file).literal(syn(x.file).clean(x.expr));
                    if (lx !== undefined)
                        lits.push({ lit: lx, path: [...path, x] });
                    else
                        next.push({ s: x, path: [...path, x] });
                }
            }
            frontier = next;
        }
        return { srcs, lits };
    };
    /** The function around a point sends to another server: a local model server (Ollama /api/generate, /api/chat,
     *  localhost:11434), Hugging Face inference, or another provider's host. Only inside a function: a config class's
     *  property default (Temperature { get; set; } = 0.7f) in a file that also names other providers is still the value
     *  a request reads (dev-key check, 24 Nov) */
    const ELSEWHERE = /localhost:11434|127\.0\.0\.1:11434|\/api\/(?:generate|chat)\b|api-inference\.huggingface\.co|huggingface\.co\/(?:api|models)|router\.huggingface\.co|\bollama\b/i;
    const sendsElsewhere = (file, at, provider) => {
        const f = byRel.get(file);
        if (!f)
            return false;
        const fn = fnAt(file, at);
        if (!fn)
            return false;
        const text = f.source.slice(fn.start, fn.end);
        if (ELSEWHERE.test(text))
            return true;
        for (const m of text.matchAll(/["'`](https?:\/\/[^"'`\s]+)["'`]/g)) {
            const h = matchUrl(m[1]);
            if (h && h.provider.id !== provider)
                return true;
        }
        return false;
    };
    /** The receiver of a member write on this line has a provider set, in the same function, to another provider */
    const otherProviderSet = (y, provider) => {
        const text = snip(y.file, y.line);
        const recv = /([A-Za-z_$][\w$]*)\s*(?:\.|->)\s*(?:set[A-Z]\w*\s*\(|\w+\s*=[^=])/.exec(text)?.[1];
        if (!recv || /^(?:this|self)$/.test(recv))
            return false;
        const fn = fnAt(y.file, y.at);
        if (!fn)
            return false;
        const body = byRel.get(y.file).source.slice(fn.start, fn.end);
        const re = new RegExp(`(?<![\\w$])${recv.replace(/\$/g, "\\$")}\\s*(?:\\.|->)\\s*(?:set)?\\w*[Pp]rovider\\s*(?:\\(|=(?!=))\\s*([^;\\n]+)`, "g");
        for (const m of body.matchAll(re)) {
            let e = m[1].trim().replace(/\)\s*$/, "");
            if (!e)
                continue;
            const at = fn.start + m.index + m[0].length - m[1].length;
            const lits = trace({ file: y.file, line: lineAt(y.file, at), expr: e, at, via: "provider" }).lits.map((l) => l.lit);
            const L = syn(y.file);
            const own = L.literal(L.clean(e));
            if (own !== undefined)
                lits.push(own);
            const p = provider.toLowerCase();
            if (lits.length && lits.every((l) => !l.toLowerCase().includes(p) && !(p === "anthropic" && /claude/i.test(l))))
                return true;
        }
        return false;
    };
    const out = [];
    const vdirs = vendorDirs(code.map((f) => f.rel));
    const have = new Set(found.flatMap((u) => [u.line, ...(u.alsoLines ?? [])].flatMap((l) => [...(u.params ?? []), u.apiVersion ?? ""].map((p) => `${u.file}|${l}|${p}`))));
    const snip = (rel, line) => (byRel.get(rel).source.split("\n")[line - 1] ?? "").trim().slice(0, 200);
    /** A catch-and-retry in the function around a setting that drops it when the API rejects the request */
    const retryHandled = memo((rel, line, param) => {
        const fn = fnAt(rel, offsetOfLine(rel, line) + snip(rel, line).length);
        if (!fn)
            return undefined;
        const src = byRel.get(rel).source;
        const body = src.slice(fn.start, fn.end);
        const word = param.replace(/_/g, "_?");
        const writes = new RegExp(`${word}\\w*\\s*(?:,[^=\\n]*)?=(?!=)|(?:delete|remove|pop|unset|without)\\b[^\\n]*${word}`, "i");
        const chains = (t) => new Set([...t.matchAll(/([A-Za-z_$][\w$]*(?:\s*(?:\.|->)\s*[A-Za-z_$][\w$]*){2,})\s*\(/g)].map((m) => m[1].replace(/\s+/g, "")));
        for (const m of body.matchAll(/\bif\s*\(?\s*err\b[^{\n]*\{|\bcatch\s*(?:\([^)]*\))?\s*\{|\bexcept\b[^:\n]*:|\brescue\b[^\n]*\n|\.catch\s*\(/g)) {
            const branch = body.slice(m.index, m.index + 800);
            if (!writes.test(branch))
                continue;
            const before = chains(body.slice(0, m.index));
            if (![...chains(branch)].some((c) => before.has(c)))
                continue;
            return `handled: retried without ${param} when the API rejects it (${rel}:${lineAt(rel, fn.start + m.index)})`;
        }
        return undefined;
    });
    for (const s of found) {
        if (!s.params?.length || (s.kind !== "sdk" && s.kind !== "http") || !byRel.has(s.file) || s.handled)
            continue;
        const h = s.params.map((p) => retryHandled(s.file, s.line, p)).find(Boolean);
        if (h)
            Object.assign(s, { handled: h, reason: s.reason ? `${s.reason}; ${h}` : h });
    }
    // setting mode
    for (const s of found) {
        if (!s.params || s.params.length !== 1 || !s.op || (s.kind !== "sdk" && s.kind !== "http") || !byRel.has(s.file) || s.inTest)
            continue;
        const L = syn(s.file);
        const text = snip(s.file, s.line);
        const v = L.settingValue(text, s.params[0]);
        if (!v)
            continue;
        const lineOff = offsetOfLine(s.file, s.line);
        const at = lineOff + Math.max(0, byRel.get(s.file).source.slice(lineOff).indexOf(v));
        const { srcs } = trace({ file: s.file, line: s.line, expr: v, at, via: "the setting" });
        // Reported: the lines that hold the value (a literal: a default, a constant, a flag default) and the lines that
        // feed the setting directly (the first hop: a request type's literal, the field it reads). The lines in between
        // (getters, pass-through arguments, returns) are alsoLines of the value's line, where a fix still sees them.
        for (const x of srcs) {
            const path = x.path ?? [];
            // a value read in another vendor's directory (providers/cohere/…) doesn't feed this provider's request
            if ([x, ...path].some((y) => foreignVendorOf(y.file, s.provider, vdirs)))
                continue;
            // the same object gets a provider next to the setting, and that provider is another one (robot defaults with
            // provider = DEFAULT_CHAT_PROVIDER = "dashscope"): the setting is for that provider's requests
            if ([x, ...path].some((y) => otherProviderSet(y, s.provider)))
                continue;
            // a value set in a function (or Go file) that sends to another server itself (an Ollama tool posting to
            // localhost:11434/api/generate, a Hugging Face job, another provider's host) is that server's setting, not
            // this request's
            if (x.file !== s.file && sendsElsewhere(x.file, x.at, s.provider))
                continue;
            // a declaration, not a value: a type (temperature?: number, Optional[float]), a TS interface / type member, or a
            // function signature line (async generateWithTools(opts: Opts))
            {
                const isVal = syn(x.file).literal(syn(x.file).clean(x.expr)) !== undefined;
                const lineText = snip(x.file, x.line);
                if (!isVal && (/^\s*(?:number|string|boolean|bool|float|float32|float64|double|int|long|decimal|any|unknown|undefined|null|None|Optional\[[^\]]+\]|\*?float(?:32|64)?)(?:\s*\|\s*(?:number|string|undefined|null|None|float))*\s*;?\s*$/.test(x.expr)
                    || /^\s*(?:readonly\s+)?["']?\w+["']?\??\s*:\s*[\w<>\[\]|. ]+[;,]?\s*$/.test(lineText)
                    || /^\s*(?:(?:export|public|private|protected|static|async|override)\s+)*(?:function\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(?::\s*[^={]+)?\s*\{?\s*$/.test(lineText) && !/=/.test(lineText.replace(/=>/g, ""))))
                    continue;
            }
            // a field set to the enclosing function's own parameter (an option setter's c.Temperature = &t, a setter
            // setTemperature(t) { this.temperature = t }): it copies its caller's value, not a default
            if (/ =$/.test(x.via) && !path.length) {
                const fx = fnAt(x.file, x.at);
                const name = x.expr.trim().replace(/^[&*]\s*/, "");
                if (fx && /^[A-Za-z_$][\w$]*$/.test(name) && fx.params.some((p) => p.name.replace(/^[*&$]+/, "") === name))
                    continue;
                // (a Go closure inside the setter: the setter's own parameter, one function out)
                if (fx && /^[A-Za-z_$][\w$]*$/.test(name)) {
                    const outer = fnAt(x.file, Math.max(0, fx.start - 1));
                    if (outer && outer !== fx && outer.end >= fx.end && outer.params.some((p) => p.name.replace(/^[*&$]+/, "") === name))
                        continue;
                }
            }
            const isValue = syn(x.file).literal(syn(x.file).clean(x.expr)) !== undefined;
            if (!isValue && (path.length > 0 || /returns?\b|returned/.test(x.via)))
                continue;
            // a local copied from a property or config read (var temperature = _config.Temperature) isn't where the value
            // is set; tracing goes on to the literal or default (api-v16)
            if (!isValue && / =$/.test(x.via) && /^[@$]?[A-Za-z_][\w$]*(?:\s*(?:\.|->|::|\?\.)\s*[A-Za-z_]\w*)+$/.test(x.expr.trim()))
                continue;
            const k = `${x.file}|${x.line}|${s.params[0]}|${s.provider}|${s.op}`;
            if (have.has(`${x.file}|${x.line}|${s.params[0]}`) || have.has(k) || (x.file === s.file && x.line === s.line))
                continue;
            have.add(k);
            // (and the request line it feeds, when that's in the same file: a fix, and a reader, see both)
            const also = [...new Set([...path.filter((y) => y.file === x.file && y.line !== x.line).map((y) => y.line), ...(s.file === x.file && s.line !== x.line ? [s.line] : [])])].sort((a, b) => a - b);
            // a model setting traced to a literal (a Go struct tag's envDefault, a config default): the literal is the model
            const modelLit = s.params[0] === "model" && isValue ? syn(x.file).literal(syn(x.file).clean(x.expr)) : undefined;
            const mref = modelLit ? modelRef(modelLit) : undefined;
            out.push({
                ...(mref && /annotation default/.test(x.via) ? { model: mref.model, setting: true, modelSpan: { start: x.at, end: x.at + x.expr.trim().length, kind: "string" } } : {}),
                provider: s.provider, kind: s.kind, lang: byRel.get(x.file).lang, file: x.file, line: x.line, op: s.op, params: [...s.params], confidence: s.confidence === "possible" ? "possible" : "likely",
                snippet: snip(x.file, x.line), reason: `${s.params[0]} reaches ${s.op} (${s.file}:${s.line}) through ${x.chain ?? x.via}${s.handled ? `; ${s.handled}` : ""}`,
                ...(s.handled ? { handled: s.handled } : {}),
                sink: { file: s.file, line: s.line },
                ...(also.length ? { alsoLines: also } : {}),
                // (a request whose provider the call doesn't show: so is where its value is set)
                ...(s.context === "provider-unresolved" ? { context: s.context, contextReason: s.contextReason } : {}),
            });
        }
    }
    tick("setting mode");
    // value mode: provider URLs built from names
    const isTestFile = (rel) => /(^|\/)(tests?|__tests__|spec|testdata|fixtures?)\/|(Test|Tests|Spec|_test|\.test|\.spec)\.\w+$/.test(rel);
    const versionish = (x) => /^v\d+(?:\.\d+)?(?:beta\d*)?$|^\d{4}-\d{2}(?:-\d{2})?$/.test(x);
    for (const f of code) {
        if (isTestFile(f.rel))
            continue;
        const L = syn(f.rel);
        for (const u of L.urlBuilds(f.source)) {
            const line = lineAt(f.rel, u.at);
            if (found.some((x) => x.file === f.rel && x.line === line && x.apiVersion))
                continue;
            // each name part, traced to literals; the URL is the parts joined (first literal per part)
            let value = "";
            const via = [];
            let ok = true;
            let verLine = line;
            let verPath = [];
            let verPaths = [];
            let verIdx = -1;
            let verAlts = [];
            const partVals = [];
            for (const p of u.parts) {
                if (p.lit !== undefined) {
                    value += p.lit;
                    partVals.push(p.lit);
                    continue;
                }
                // a part named like a version takes the first version-shaped literal (and a bigger budget: there are few);
                // others the first URL-shaped or any
                const wantVer = /version|ver\b/i.test(p.expr);
                const r = trace({ file: f.rel, line, expr: p.expr, at: u.at, via: "URL part" }, wantVer ? 2000 : MAX_WORK);
                const first = (wantVer ? r.lits.find((x) => versionish(x.lit)) : r.lits.find((x) => /^https?:\/\//.test(x.lit) || versionish(x.lit))) ?? (wantVer ? undefined : r.lits[0]);
                if (process.env.VITASTA_FLOW_DEBUG)
                    console.error("flow part", f.rel, line, p.expr, "->", JSON.stringify(r.lits.map((x) => x.lit)), r.srcs.slice(0, 6).map((x) => `${x.via}@${x.file}:${x.line} ${x.expr.slice(0, 50)}`));
                if (!first) {
                    ok = false;
                    break;
                }
                if (/^v\d+(?:\.\d+)?$|^\d{4}-\d{2}(?:-\d{2})?$/.test(first.lit)) {
                    const pos = f.source.indexOf(p.expr, u.at);
                    if (pos >= 0)
                        verLine = lineAt(f.rel, pos);
                    verPath = first.path;
                    verIdx = partVals.length;
                    verAlts = r.lits.filter((x) => versionish(x.lit) && x.lit !== first.lit);
                    // other lines that pick one of the constants on that path (a second factory choosing the same DEFAULT): the
                    // traversal reached them too, but joined the path already walked
                    const names = new Set(first.path.flatMap((x) => [...x.expr.matchAll(/\b[A-Z]\w*\.[A-Z][A-Z0-9_]+\b|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g)].map((m) => m[0])));
                    verPaths = [...r.lits.filter((x) => x.lit === first.lit).map((x) => x.path), r.srcs.filter((x) => [...names].some((n) => x.expr.includes(n)))];
                }
                value += first.lit;
                partVals.push(first.lit);
                via.push(...first.path);
            }
            if (!ok && !value)
                continue;
            const hit = matchUrl(value);
            const ver = hit ? urlVersionOf(hit.provider, value) : undefined;
            if (!hit || !ver || !via.length)
                continue;
            const emit = (apiVersion, rel, l, why, also = [], alsoAt = []) => {
                if (have.has(`${rel}|${l}|${apiVersion}`))
                    return;
                have.add(`${rel}|${l}|${apiVersion}`);
                const al = [...new Set(also.filter((x) => x !== l))].sort((a, b) => a - b);
                out.push({ provider: hit.provider.id, kind: "version-pin", lang: byRel.get(rel).lang, file: rel, line: l, apiVersion, confidence: "likely", snippet: snip(rel, l), reason: why, ...(al.length ? { alsoLines: al } : {}), ...(alsoAt.length ? { alsoAt } : {}) });
            };
            const report = (val, vv, path) => {
                const apiVersion = `url: ${vv}`;
                const chain = path.map((x) => `${x.via} (${x.file}:${x.line})`).join(" ← ");
                // a Spring property the value was read from: its file and line go with the finding
                const cfgAt = [...new Set(path.map((x) => x.cfg).filter((x) => !!x))];
                // the URL line, and the line that holds the version (the end of its chain); the lines between are alsoLines
                emit(apiVersion, f.rel, verLine, `the URL is ${val.slice(0, 90)}; the version comes through ${chain || "a name"}`, line !== verLine ? [line] : [], cfgAt);
                const end = path[path.length - 1];
                if (end)
                    emit(apiVersion, end.file, end.line, `${vv} reaches ${hit.provider.id} (${f.rel}:${verLine}) through ${chain}`, path.filter((x) => x.file === end.file).map((x) => x.line), cfgAt);
            };
            report(value, ver, verPath);
            // another version the same name can be (a configured one and a literal fallback: v != null ? v : "v23.0"): each is reported
            for (const alt of verAlts) {
                if (verIdx < 0)
                    break;
                const v2 = partVals.map((x, i) => (i === verIdx ? alt.lit : x)).join("");
                const h2 = matchUrl(v2);
                const ver2 = h2 ? urlVersionOf(h2.provider, v2) : undefined;
                if (h2 && ver2 && h2.provider.id === hit.provider.id)
                    report(v2, ver2, alt.path);
            }
            const end = verPath[verPath.length - 1];
            // the places that choose the version by name (CloudApiVersion.DEFAULT, LATEST = V25_0): a fix changes them too
            for (const x of [...new Set(verPaths.flat())])
                if (x !== end && CHOICE.test(x.expr))
                    emit(`url: ${ver}`, x.file, x.line, `${ver} is chosen here (${x.expr.slice(0, 60)}) for ${hit.provider.id} (${f.rel}:${verLine})`);
        }
    }
    tick("value mode");
    // header mode: an API-meaning header (OpenAI-Beta: assistants=v2) sent by a request whose URL can be traced. The
    // URL names in the header's function (url / uri / endpoint / path) are traced to literal paths; their operations
    // go on the usage (requestOps), so a record that means "uses this API" matches only when one of them is that API's
    // (or none could be found)
    for (const u of found) {
        if (u.kind !== "version-pin" || !u.apiVersion || !/^[a-z0-9-]+: /.test(u.apiVersion) || /^(?:url|const|setter|default): /.test(u.apiVersion) || !byRel.has(u.file))
            continue;
        const f = byRel.get(u.file);
        const at = offsetOfLine(u.file, u.line);
        const fn = fnAt(u.file, at);
        // no function around it (a one-line constructor, file-level setup): the file's own operations and paths decide
        const fileOps = () => {
            const ops = new Set(found.filter((x) => x !== u && x.file === u.file && x.provider === u.provider && x.op && x.kind !== "version-pin").map((x) => x.op));
            for (const m of f.source.matchAll(/["'`](?:\/?(v\d+)\/|\/)([a-z][a-z_]*)(?:\/[^"'`\s]*)?["'`]/g))
                ops.add(`* /${m[1] ?? "v1"}/${m[2]}`);
            // and a versioned path inside a template whose host is a variable ($"{baseUrl}/v1/assistants")
            for (const m of f.source.matchAll(/\}\/(v\d+)\/([a-z][a-z_]*)/g))
                ops.add(`* /${m[1]}/${m[2]}`);
            if (ops.size)
                u.requestOps = [...ops].sort();
            else
                u.headerOnly = true;
        };
        if (!fn) {
            fileOps();
            continue;
        }
        const body = f.source.slice(fn.start, fn.end);
        const L = syn(u.file);
        const paths = new Set();
        for (const m of body.matchAll(/(?<![\w$.])((?:url|uri|endpoint|path|requestUrl|fullUrl)\w*)\s*(?::\s*[\w<>]+\s*)?=(?![=>])\s*/gi)) {
            const expr = L.clean(valueOfLine(body, m.index + m[0].length));
            // each + part is traced to literals; path-shaped and URL-shaped ones are kept
            for (const part of expr.split(/\s*\+\s*/)) {
                const lit = L.literal(L.clean(part));
                const lits = lit !== undefined ? [lit] : trace({ file: u.file, line: lineAt(u.file, fn.start + m.index), expr: part, at: fn.start + m.index, via: "request URL part" }).lits.map((x) => x.lit);
                for (const l of lits) {
                    const pth = /^https?:\/\/[^/]+(\/[^?#\s]*)?/.exec(l)?.[1] ?? (/^\/[\w{}.\/-]+$/.test(l) ? l : undefined);
                    if (pth && pth !== "/")
                        paths.add(pth.replace(/\/$/, ""));
                }
            }
        }
        if (!paths.size) {
            // no request URL in the header's function (a header set on a client: ->withHttpHeader('OpenAI-Beta', …)): the
            // operations of the same provider's calls in the file are where it goes; with none known, it's only possible
            //
            // and the API paths the file names (a repository per endpoint: "/v1/vector_stores", "v1/files/{id}"); nothing
            // saying which API it's for: a record that names its operations needs one of them (test sets: the header on
            // vector-store requests isn't an Assistants call)
            fileOps();
            continue;
        }
        // full paths when a base path (…/v1) was found, else the base path + each relative path
        const bases = [...paths].filter((x) => /^\/v\d+$/.test(x));
        const rel = [...paths].filter((x) => !/^\/v\d+$/.test(x));
        const ops = rel.map((x) => `* ${/^\/v\d+\//.test(x) || !bases.length ? x : bases[0] + x}`);
        if (ops.length)
            u.requestOps = [...new Set(ops)].sort();
    }
    // const-use mode: a version pin that is a constant of a class (DefaultShopifyApiVersion.DefaultVersion =
    // "2026-07") is used wherever the code names it (C.NAME), or makes the class whose property returns it (new C());
    // each such line is a place the default version is used
    // lines that already have a pin of that version (a URL built from the constant): not repeated
    const bare = (v) => v.replace(/^[\w-]+: /, "");
    const pinnedAt = new Set([...found, ...out].filter((x) => x.kind === "version-pin" && x.apiVersion).flatMap((x) => [x.line, ...(x.alsoLines ?? [])].map((l) => `${x.file}|${l}|${bare(x.apiVersion)}`)));
    for (const u of [...found, ...out]) {
        if (u.kind !== "version-pin" || !u.apiVersion || !byRel.has(u.file) || u.inTest || u.constUse)
            continue;
        const at = offsetOfLine(u.file, u.line);
        const decl = /\b(?:const|static|final|readonly)\b[^=\n;]*?\b([A-Za-z_]\w*)\s*=\s*["']/.exec(snip(u.file, u.line));
        const c = decl ? clsAt(u.file, at + 1) : undefined;
        if (!decl || !c)
            continue;
        const C = simple(c.name), NAME = decl[1];
        const body = byRel.get(u.file).source.slice(c.start, c.end);
        // a property / getter of the class that returns the constant (public string Version => DefaultVersion)
        const exposes = new RegExp(`\\b\\w+\\s*(?:=>|\\{\\s*get\\s*(?:=>|\\{\\s*return))\\s*(?:${esc(C)}\\.)?${esc(NAME)}\\b`).test(body);
        const refs = new RegExp(`(?<![\\w.])${esc(C)}\\.${esc(NAME)}\\b${exposes ? `|\\bnew\\s+${esc(C)}\\s*\\(` : ""}`, "g");
        const seenLines = new Set();
        // Only files that see this C:
        // the same namespace / package or one inside it, a using / import of it, or the name written fully; in a language
        // without namespaces, when several files declare C, the same directory
        const nsOf = (rel) => /^[ \t]*(?:namespace|package)\s+([\w.]+)/m.exec(byRel.get(rel).source)?.[1];
        const declNs = nsOf(u.file);
        const sameNamed = classes.filter((k) => simple(k.name) === C).map((k) => k.file);
        const sees = (rel) => {
            if (rel === u.file || new Set(sameNamed).size <= 1)
                return true;
            const src = byRel.get(rel).source;
            if (declNs) {
                const ns = nsOf(rel);
                if (ns && (ns === declNs || ns.startsWith(declNs + ".")))
                    return true;
                if (new RegExp(`^[ \\t]*(?:using|import)\\s+(?:static\\s+)?${declNs.replace(/\./g, "\\.")}(?:\\.${C}|\\.\\*)?\\s*;`, "m").test(src))
                    return true;
                return src.includes(`${declNs}.${C}.`);
            }
            return new Set(sameNamed).size <= 1 || rel.split("/").slice(0, -1).join("/") === u.file.split("/").slice(0, -1).join("/");
        };
        for (const g of mentioning(C)) {
            if (TESTISH.test(g.rel) || !sees(g.rel))
                continue;
            for (const m of g.source.matchAll(refs)) {
                const l = lineAt(g.rel, m.index);
                const k = `${g.rel}|${l}`;
                if ((g.rel === u.file && l === u.line) || seenLines.has(k) || have.has(`${g.rel}|${l}|${u.apiVersion}`) || pinnedAt.has(`${g.rel}|${l}|${bare(u.apiVersion)}`))
                    continue;
                seenLines.add(k);
                have.add(`${g.rel}|${l}|${u.apiVersion}`);
                out.push({
                    provider: u.provider, kind: "version-pin", lang: byRel.get(g.rel).lang, file: g.rel, line: l, apiVersion: u.apiVersion, confidence: u.confidence,
                    snippet: snip(g.rel, l), reason: `uses ${C}.${NAME} (${u.apiVersion.replace(/^\w+: /, "")}, ${u.file}:${u.line})`, constUse: true,
                });
            }
        }
    }
    // a property that falls back to the constant (APIVersion => _v ?? C.NAME): a subclass's base.APIVersion /
    // super.APIVersion / parent::APIVersion uses it too
    for (const u of out.filter((x) => x.constUse)) {
        const prop = /\b([A-Za-z_]\w*)\s*(?:=>|\{\s*get\b)/.exec(snip(u.file, u.line))?.[1];
        const owner = prop ? clsAt(u.file, offsetOfLine(u.file, u.line) + 1) : undefined;
        if (!prop || !owner)
            continue;
        const B = simple(owner.name);
        for (const k of classes) {
            if (!(k.parent && simple(k.parent) === B) && !(k.supers ?? []).some((x) => simple(x) === B))
                continue;
            if (TESTISH.test(k.file))
                continue;
            const src = byRel.get(k.file).source;
            for (const m of src.slice(k.start, k.end).matchAll(new RegExp(`\\b(?:base|super|parent)\\s*(?:\\.|::)\\s*${esc(prop)}\\b`, "g"))) {
                const l = lineAt(k.file, k.start + m.index);
                if (have.has(`${k.file}|${l}|${u.apiVersion}`) || pinnedAt.has(`${k.file}|${l}|${bare(u.apiVersion)}`))
                    continue;
                have.add(`${k.file}|${l}|${u.apiVersion}`);
                out.push({
                    provider: u.provider, kind: "version-pin", lang: byRel.get(k.file).lang, file: k.file, line: l, apiVersion: u.apiVersion, confidence: u.confidence,
                    snippet: snip(k.file, l), reason: `falls back to ${B}.${prop}, which ${u.reason}`, constUse: true,
                });
            }
        }
    }
    return out;
}
/** The value text after a position: up to the end of its statement (`;` or a line end at depth 0) */
function valueOfLine(src, from) {
    let d = 0, i = from, q;
    for (; i < Math.min(src.length, from + 1000); i++) {
        const ch = src[i];
        if (q) {
            if (ch === "\\")
                i++;
            else if (ch === q)
                q = undefined;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === "`")
            q = ch;
        else if (ch === "(" || ch === "[" || ch === "{")
            d++;
        else if (ch === ")" || ch === "]" || ch === "}") {
            if (d === 0)
                break;
            d--;
        }
        else if ((ch === ";" || ch === "\n") && d === 0)
            break;
    }
    return src.slice(from, i);
}
export { esc };
