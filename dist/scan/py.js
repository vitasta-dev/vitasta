import { PROVIDERS, hostOfClass, matchUrl, mentionsRouter, modelProvider, modelRef, providerById, sdkOp, urlVersionOf } from "../providers.js";
import { configuredBase } from "./baseexpr.js";
import { normalizePath } from "./js.js";
import { alwaysCounts, inModelCollection, isPairKey, pySettingKind } from "./context.js";
import { candidateKind, collectionName, inCostContext, inDataCollection, inDataTable, inExampleOrTokenizer, inRecordedResponse } from "./shapes.js";
import { lineOf, named, nodesOfType, snippetOf } from "./parser.js";
const HTTP_LIBS = /^(requests|httpx|aiohttp|urllib3)$/;
const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "request", "stream"];
export function analyzePy(file, source, tree) {
    const ctx = {
        file, source, tree,
        modules: new Map(), classes: new Map(), clients: new Map(), clientAlts: new Map(), clientHosts: new Map(), clientProxies: new Map(), classNames: new Map(), factories: new Map(),
        consts: new Map(), assigns: new Map(), httpClients: new Map(), bedrockClients: new Set(), consumed: new Set(),
    };
    collectImports(ctx);
    collectConsts(ctx);
    collectClients(ctx);
    const usages = [];
    for (const call of nodesOfType(tree.rootNode, "call")) {
        const fn = call.childForFieldName("function");
        if (!fn)
            continue;
        const u = sdkCall(ctx, call, fn) ?? httpCall(ctx, call, fn) ?? modelIdCall(ctx, call, fn);
        if (u)
            usages.push(u);
    }
    usages.push(...versionPins(ctx));
    usages.push(...modelRefs(ctx));
    return usages;
}
function providerForModule(mod) {
    // A provider's package list may name a dotted import path (google.ads.googleads); the longest match wins
    let best;
    for (const p of PROVIDERS)
        for (const pkg of p.packages.py ?? [])
            if (pkg.includes(".") && (mod === pkg || mod.startsWith(pkg + ".")) && (!best || pkg.length > best.len))
                best = { id: p.id, len: pkg.length };
    if (best)
        return best.id;
    // Google's import names differ from their pip package names
    if (/^google\.(genai|generativeai)(\.|$)|^vertexai(\.|$)/.test(mod))
        return "google";
    if (mod === "google")
        return undefined;
    // Import names that differ from pip package names
    if (/^shopify(\.|$)/.test(mod))
        return "shopify";
    const top = mod.split(".")[0];
    return PROVIDERS.find((p) => (p.packages.py ?? []).includes(top))?.id;
}
function collectImports(ctx) {
    for (const imp of nodesOfType(ctx.tree.rootNode, "import_statement")) {
        for (const n of named(imp)) {
            const mod = n.type === "aliased_import" ? n.childForFieldName("name")?.text : n.text;
            const alias = n.type === "aliased_import" ? n.childForFieldName("alias")?.text : n.text.split(".")[0];
            const p = mod && providerForModule(mod);
            if (p && alias)
                ctx.modules.set(alias, p);
        }
    }
    for (const imp of nodesOfType(ctx.tree.rootNode, "import_from_statement")) {
        const mod = imp.childForFieldName("module_name")?.text;
        // from google import genai / from google import generativeai as genai
        if (mod === "google") {
            for (const n of named(imp).slice(1)) {
                const name = n.type === "aliased_import" ? n.childForFieldName("name")?.text : n.text;
                const alias = n.type === "aliased_import" ? n.childForFieldName("alias")?.text : n.text;
                if (alias && (name === "genai" || name === "generativeai"))
                    ctx.modules.set(alias, "google");
            }
            continue;
        }
        const p = mod && providerForModule(mod);
        if (!p)
            continue;
        const prov = providerById(p);
        for (const n of named(imp).slice(1)) {
            const name = n.type === "aliased_import" ? n.childForFieldName("name")?.text : n.text;
            const alias = n.type === "aliased_import" ? n.childForFieldName("alias")?.text : n.text;
            if (!name || !alias)
                continue;
            if (prov.clientClasses.includes(name)) {
                ctx.classes.set(alias, p);
                ctx.classNames.set(alias, name);
            }
            // from openai import ChatCompletion (legacy v0) → treat the name as a module-level root
            else if (/^[A-Z]/.test(name))
                ctx.modules.set(alias, p);
        }
    }
}
function collectConsts(ctx) {
    for (let pass = 0; pass < 2; pass++) {
        for (const a of nodesOfType(ctx.tree.rootNode, "assignment")) {
            const left = a.childForFieldName("left");
            if (left?.type !== "identifier")
                continue;
            const v = resolveString(ctx, a.childForFieldName("right"));
            if (v !== undefined && !v.includes("{?}"))
                ctx.consts.set(left.text, v);
        }
    }
    for (const a of nodesOfType(ctx.tree.rootNode, "assignment")) {
        const left = a.childForFieldName("left");
        if (left?.type !== "identifier")
            continue;
        const v = resolveString(ctx, a.childForFieldName("right"));
        const list = ctx.assigns.get(left.text) ?? [];
        list.push({ start: a.startIndex, fn: functionOf(a), value: v !== undefined && !v.includes("{?}") ? v : undefined });
        ctx.assigns.set(left.text, list);
    }
    for (const list of ctx.assigns.values())
        list.sort((x, y) => x.start - y.start);
}
/** The start of the innermost function (def or lambda) a node is in; -1 at module or class level */
function functionOf(node) {
    for (let p = node.parent; p; p = p.parent)
        if (p.type === "function_definition" || p.type === "lambda")
            return p.startIndex;
    return -1;
}
/**
 * A name's value where it's used. Assigned in the same function: its last assignment before the use (none before,
 * or not a string: unknown). Otherwise a module-level constant, else the file's constant as before.
 */
function valueAt(ctx, node) {
    const name = node.text;
    const list = ctx.assigns.get(name);
    const fn = functionOf(node);
    if (list && fn !== -1) {
        const local = list.filter((a) => a.fn === fn);
        if (local.length) {
            const before = local.filter((a) => a.start < node.startIndex);
            return before.length ? before[before.length - 1].value : undefined;
        }
        const mod = list.filter((a) => a.fn === -1 && a.value !== undefined);
        if (mod.length)
            return mod[mod.length - 1].value;
    }
    return ctx.consts.get(name);
}
function clientFromExpr(ctx, expr) {
    if (!expr)
        return undefined;
    if (expr.type === "await")
        return clientFromExpr(ctx, named(expr)[0] ?? null);
    if (expr.type === "call") {
        const fn = expr.childForFieldName("function");
        if (!fn)
            return undefined;
        if (fn.type === "identifier" && ctx.classes.has(fn.text))
            return ctx.classes.get(fn.text);
        if (fn.type === "identifier" && ctx.factories.has(fn.text))
            return ctx.factories.get(fn.text);
        if (fn.type === "attribute") {
            // openai.OpenAI() / anthropic.Anthropic()
            const obj = fn.childForFieldName("object")?.text;
            const attr = fn.childForFieldName("attribute")?.text;
            const p = obj && ctx.modules.get(obj);
            if (p && attr && providerById(p).clientClasses.includes(attr))
                return p;
        }
    }
    if ((expr.type === "identifier" || expr.type === "attribute") && ctx.clients.has(expr.text))
        return ctx.clients.get(expr.text);
    return undefined;
}
function hostFromExpr(ctx, expr) {
    if (!expr)
        return undefined;
    if (expr.type === "identifier" || expr.type === "attribute") {
        const h = ctx.clientHosts.get(expr.text);
        if (h)
            return h;
    }
    if (expr.type !== "call")
        return undefined;
    const fn = expr.childForFieldName("function");
    if (!fn)
        return undefined;
    // genai.Client(vertexai=True, ...)
    if (kwarg(expr, "vertexai")?.text === "True")
        return "vertex";
    if (fn.type === "identifier")
        return hostOfClass(ctx.classNames.get(fn.text) ?? "") ?? ctx.clientHosts.get(`fn:${fn.text}`);
    return hostOfClass(fn.childForFieldName("attribute")?.text ?? "");
}
function collectClients(ctx) {
    // def make_client(): return Anthropic()
    for (const f of nodesOfType(ctx.tree.rootNode, "function_definition")) {
        const name = f.childForFieldName("name")?.text;
        const body = f.childForFieldName("body");
        if (!name || !body)
            continue;
        for (const r of nodesOfType(body, "return_statement")) {
            const value = named(r)[0] ?? null;
            const p = clientFromExpr(ctx, value);
            if (p) {
                ctx.factories.set(name, p);
                const h = hostFromExpr(ctx, value);
                if (h)
                    ctx.clientHosts.set(`fn:${name}`, h);
                break;
            }
        }
    }
    const proxyVotes = new Map();
    for (let pass = 0; pass < 2; pass++) {
        for (const a of nodesOfType(ctx.tree.rootNode, "assignment")) {
            const left = a.childForFieldName("left");
            if (!left)
                continue;
            const right = a.childForFieldName("right");
            const p = clientFromExpr(ctx, right) ?? typeProvider(ctx, a.childForFieldName("type"));
            if (p && (left.type === "identifier" || left.type === "attribute")) {
                ctx.clients.set(left.text, p);
                ctx.clientAlts.set(left.text, (ctx.clientAlts.get(left.text) ?? new Set()).add(p));
                const h = hostFromExpr(ctx, right);
                if (h)
                    ctx.clientHosts.set(left.text, h);
                // OpenAI(base_url=os.getenv("BASE", "https://relay.example/v1"))
                const base = right?.type === "call" ? kwarg(right, "base_url") : undefined;
                const url = base ? resolveString(ctx, base) : undefined;
                const host = url ? /^https?:\/\/([^/]+)/.exec(url)?.[1] : undefined;
                //
                if (host && !providerById(p).hosts.some((x) => host.endsWith(x)))
                    ctx.clientProxies.set(left.text, host);
                // or a base the app's settings give plus a version path (f"{self.config['gateway_url']}/v1"; src/scan/baseexpr.ts)
                const cfg = base && !host ? configuredBase(base.text, PROVIDERS.flatMap((x) => x.hosts)) : undefined;
                if (cfg)
                    ctx.clientProxies.set(left.text, cfg);
                // what this construction points at: one name built against different servers in a file (c = OpenAI(gateway)
                // in one function, c = OpenAI() in another) isn't known per use, so it gets no proxy
                const to = host && !providerById(p).hosts.some((x) => host.endsWith(x)) ? host : cfg ?? "provider";
                proxyVotes.set(left.text, (proxyVotes.get(left.text) ?? new Set()).add(to));
            }
            // http sessions: s = requests.Session() / httpx.Client(base_url="...")
            if (right?.type === "call" && left.type !== "pattern_list") {
                const fnText = right.childForFieldName("function")?.text ?? "";
                // bedrock = boto3.client("bedrock-runtime") / session.client(service_name="bedrock-runtime")
                if (/(^|\.)client$/.test(fnText)) {
                    const firstArg = named(right.childForFieldName("arguments") ?? right)[0];
                    const svc = resolveString(ctx, kwarg(right, "service_name") ?? (firstArg?.type !== "keyword_argument" ? firstArg : undefined));
                    if (svc === "bedrock-runtime")
                        ctx.bedrockClients.add(left.text);
                }
                if (/^(requests\.Session|httpx\.(Async)?Client|aiohttp\.ClientSession)$/.test(fnText)) {
                    const base = kwarg(right, "base_url");
                    ctx.httpClients.set(left.text, (base && resolveString(ctx, base)) ?? "");
                }
            }
        }
        // with httpx.Client(base_url=...) as c:
        for (const w of nodesOfType(ctx.tree.rootNode, "as_pattern")) {
            const value = named(w)[0];
            const target = w.childForFieldName("alias") ?? named(w)[1];
            if (value?.type !== "call" || !target)
                continue;
            const p = clientFromExpr(ctx, value);
            const name = target.text.replace(/^as\s+/, "");
            if (p)
                ctx.clients.set(name, p);
            const fnText = value.childForFieldName("function")?.text ?? "";
            if (/^(requests\.Session|httpx\.(Async)?Client|aiohttp\.ClientSession)$/.test(fnText)) {
                const base = kwarg(value, "base_url");
                ctx.httpClients.set(name, (base && resolveString(ctx, base)) ?? "");
            }
        }
        // def f(client: OpenAI)
        for (const param of nodesOfType(ctx.tree.rootNode, ["typed_parameter", "typed_default_parameter"])) {
            const name = named(param).find((n) => n.type === "identifier")?.text;
            const p = typeProvider(ctx, param.childForFieldName("type"));
            if (name && p)
                ctx.clients.set(name, p);
        }
    }
    for (const [name, to] of proxyVotes)
        if (to.size > 1)
            ctx.clientProxies.delete(name);
}
function typeProvider(ctx, t) {
    if (!t)
        return undefined;
    const text = t.text.replace(/["']/g, "");
    for (const [name, p] of ctx.classes)
        if (new RegExp(`\\b${name}\\b`).test(text))
            return p;
    for (const [mod, p] of ctx.modules)
        if (text.startsWith(mod + "."))
            return p;
    return undefined;
}
function attrChain(fn) {
    const path = [];
    let cur = fn;
    while (cur && cur.type === "attribute") {
        const attr = cur.childForFieldName("attribute");
        const obj = cur.childForFieldName("object");
        if (!attr || !obj)
            return undefined;
        if (obj.type === "identifier" && obj.text === "self")
            return { root: cur.text, path: path.reverse() };
        path.push(attr.text);
        cur = obj;
    }
    if (!cur || cur.type !== "identifier" || path.length === 0)
        return undefined;
    return { root: cur.text, path: path.reverse() };
}
function sdkCall(ctx, call, fn) {
    const chain = attrChain(fn);
    if (!chain)
        return undefined;
    let providerId = ctx.clients.get(chain.root);
    let callPath = chain.path.join(".");
    let confidence = "certain";
    if (!providerId && ctx.modules.has(chain.root)) {
        // openai.chat.completions.create (module-level client) or openai.ChatCompletion.create (legacy v0)
        providerId = ctx.modules.get(chain.root);
        // from openai import ChatCompletion → ChatCompletion.create
        if (/^[A-Z]/.test(chain.root))
            callPath = `${chain.root}.${callPath}`;
    }
    if (!providerId) {
        const imported = new Set([...ctx.modules.values(), ...ctx.classes.values()]);
        for (const pid of imported) {
            if (Object.prototype.hasOwnProperty.call(providerById(pid).sdkOps, callPath)) {
                providerId = pid;
                confidence = "likely";
                break;
            }
        }
    }
    if (!providerId)
        return undefined;
    // v17: a name bound to clients of several providers: the one whose SDK has this call. Its model may be a name with
    // several values (one per provider), so the literals it reads stay model references of their own
    let chosen = false;
    if (!sdkOp(providerById(providerId), callPath)) {
        const alt = [...(ctx.clientAlts.get(chain.root) ?? [])].filter((pid) => sdkOp(providerById(pid), callPath));
        if (alt.length === 1)
            (providerId = alt[0]), (chosen = true);
    }
    const provider = providerById(providerId);
    const op = sdkOp(provider, callPath);
    if (!op)
        return undefined;
    ctx.noConsume = chosen;
    const before = new Set(ctx.consumed);
    const info = readKwargs(ctx, call);
    ctx.noConsume = false;
    // A model name with several values (one per provider) resolves to one of them, maybe another provider's: then the
    // call has no model, and the literals it read stay model references of their own
    const owner = info.model ? modelRef(info.model)?.provider.id : undefined;
    if (info.model && owner !== providerId && (chosen || owner)) {
        info.model = undefined;
        info.modelSpan = undefined;
        for (const x of [...ctx.consumed])
            if (!before.has(x))
                ctx.consumed.delete(x);
    }
    const { model, params } = info;
    return {
        provider: provider.id, kind: "sdk", lang: "py", file: ctx.file, line: lineOf(call),
        op, sdkCall: callPath, model, params, confidence, snippet: snippetOf(ctx.source, call),
        modelSpan: info.modelSpan, paramSpans: info.paramSpans,
        host: ctx.clientHosts.get(chain.root) ?? (confidence === "likely" ? fileHost(ctx) : undefined),
        proxy: ctx.clientProxies.get(chain.root),
    };
}
function fileHost(ctx) {
    const names = [...ctx.classes.keys()].map((a) => ctx.classNames.get(a) ?? a);
    if (!names.length)
        return undefined;
    const hosts = new Set(names.map(hostOfClass));
    return hosts.size === 1 ? [...hosts][0] : undefined;
}
function httpCall(ctx, call, fn) {
    if (fn.type !== "attribute")
        return undefined;
    const target = fn.childForFieldName("object")?.text ?? "";
    const methodName = fn.childForFieldName("attribute")?.text ?? "";
    if (!HTTP_METHODS.includes(methodName))
        return undefined;
    const isLib = HTTP_LIBS.test(target);
    const base = ctx.httpClients.get(target);
    if (!isLib && base === undefined)
        return undefined;
    const argList = call.childForFieldName("arguments");
    const positional = argList ? named(argList).filter((a) => a.type !== "keyword_argument") : [];
    let method = methodName.toUpperCase();
    let urlNode = positional[0] ?? kwarg(call, "url");
    if (methodName === "request" || methodName === "stream") {
        const m = positional[0] && resolveString(ctx, positional[0]);
        if (m)
            method = m.toUpperCase();
        urlNode = positional[1] ?? kwarg(call, "url");
    }
    let url = urlNode ? resolveString(ctx, urlNode) : undefined;
    if (url === undefined)
        return undefined;
    if (base && !/^https?:/.test(url))
        url = base.replace(/\/+$/, "") + "/" + url.replace(/^\/+/, "");
    const hit = matchUrl(url);
    if (!hit)
        return undefined;
    const body = kwarg(call, "json");
    const info = body?.type === "dictionary" ? readDict(ctx, body) : { params: [] };
    const { model, params } = info;
    return {
        provider: hit.provider.id, kind: "http", lang: "py", file: ctx.file, line: lineOf(call),
        op: `${method} ${normalizePath(hit.path)}`, model, params, confidence: "certain", snippet: snippetOf(ctx.source, call),
        modelSpan: info.modelSpan, paramSpans: info.paramSpans,
        host: url.includes("aiplatform.googleapis.com") ? "vertex" : undefined,
        apiVersion: urlVersionOf(hit.provider, url) ? `url: ${urlVersionOf(hit.provider, url)}` : undefined,
    };
}
/** boto3 bedrock-runtime operations → Bedrock REST operation */
const BEDROCK_OPS = {
    converse: "POST /model/{modelId}/converse",
    converse_stream: "POST /model/{modelId}/converse-stream",
    invoke_model: "POST /model/{modelId}/invoke",
    invoke_model_with_response_stream: "POST /model/{modelId}/invoke-with-response-stream",
};
/**
 * Calls that pass a model ID through a cloud SDK or framework rather than the provider's SDK:
 * boto3 bedrock-runtime converse()/invoke_model(modelId=...), LangChain ChatBedrock(model_id=...),
 * Strands BedrockModel(model_id=...), etc. The model ID decides the provider and host.
 */
function modelIdCall(ctx, call, fn) {
    const valueNode = kwarg(call, "modelId") ?? kwarg(call, "model_id") ?? (BEDROCK_METHOD(fn) ? kwarg(call, "model") : undefined);
    if (!valueNode)
        return undefined;
    const model = resolveString(ctx, valueNode);
    if (!model)
        return undefined;
    const p = modelProvider(model);
    if (!p)
        return undefined;
    resolveString(ctx, valueNode, true); // mark the literal as used so it isn't also a model-ref
    const method = fn.type === "attribute" ? fn.childForFieldName("attribute")?.text ?? "" : fn.text;
    const receiver = fn.type === "attribute" ? fn.childForFieldName("object")?.text ?? "" : "";
    const op = BEDROCK_OPS[method];
    return {
        provider: p.id, kind: "sdk", lang: "py", file: ctx.file, line: lineOf(call),
        op, sdkCall: receiver ? `${method}` : fn.text, model, params: readKwargs(ctx, call).params,
        // A Bedrock runtime method or a Bedrock class (ChatBedrock, BedrockModel) runs the model on Bedrock
        ...(op || hostOfClass(fn.text.split(".").pop() ?? "") === "bedrock" ? { host: "bedrock" } : {}),
        paramSpans: readKwargs(ctx, call).paramSpans, modelSpan: literalSpan(ctx, valueNode),
        confidence: op && ctx.bedrockClients.has(receiver) ? "certain" : "likely",
        snippet: snippetOf(ctx.source, call),
    };
}
function BEDROCK_METHOD(fn) {
    return fn.type === "attribute" && (fn.childForFieldName("attribute")?.text ?? "") in BEDROCK_OPS;
}
function versionPins(ctx) {
    const out = [];
    for (const pair of nodesOfType(ctx.tree.rootNode, "pair")) {
        const key = (resolveString(ctx, pair.childForFieldName("key")) ?? "").toLowerCase();
        for (const p of PROVIDERS) {
            if (!p.versionHeaders.includes(key))
                continue;
            const v = resolveString(ctx, pair.childForFieldName("value"));
            if (v)
                out.push({
                    provider: p.id, kind: "version-pin", lang: "py", file: ctx.file, line: lineOf(pair),
                    apiVersion: `${key}: ${v}`, confidence: "certain", snippet: snippetOf(ctx.source, pair),
                });
        }
    }
    // stripe.api_version = "2024-06-20"
    for (const a of nodesOfType(ctx.tree.rootNode, "assignment")) {
        const left = a.childForFieldName("left");
        if (left?.type !== "attribute")
            continue;
        const pid = ctx.modules.get(left.childForFieldName("object")?.text ?? "");
        const attr = left.childForFieldName("attribute")?.text ?? "";
        const p = pid ? providerById(pid) : undefined;
        const v = resolveString(ctx, a.childForFieldName("right"));
        if (p?.versionKeys?.includes(attr) && v)
            out.push({
                provider: p.id, kind: "version-pin", lang: "py", file: ctx.file, line: lineOf(a),
                apiVersion: `${attr}: ${v}`, confidence: "certain", snippet: snippetOf(ctx.source, a),
            });
    }
    // FacebookAdsApi.init(..., api_version="v21.0") / StripeClient(key, stripe_version=...)
    for (const call of nodesOfType(ctx.tree.rootNode, "call")) {
        const fn = call.childForFieldName("function");
        const root = fn?.text.split(".")[0] ?? "";
        const pid = ctx.classes.get(root) ?? ctx.modules.get(root);
        const p = pid ? providerById(pid) : undefined;
        if (!p?.versionKeys)
            continue;
        for (const k of p.versionKeys) {
            const vNode = kwarg(call, k);
            const v = vNode ? resolveString(ctx, vNode) : undefined;
            if (v)
                out.push({
                    provider: p.id, kind: "version-pin", lang: "py", file: ctx.file, line: lineOf(call),
                    apiVersion: `${k}: ${v}`, confidence: "certain", snippet: snippetOf(ctx.source, call),
                });
        }
    }
    return out;
}
function modelRefs(ctx) {
    const out = [];
    const routed = mentionsRouter(ctx.source);
    for (const s of nodesOfType(ctx.tree.rootNode, "string")) {
        if (ctx.consumed.has(s.startIndex))
            continue;
        const v = stringValue(s);
        if (v === undefined)
            continue;
        const ref = modelRef(v, routed);
        if (!ref)
            continue;
        // A cloud-form ID (Vertex "@", Bedrock "anthropic.") counts anywhere except as a lookup-table key (prices, sizes)
        // A model in a recorded or mocked API response is output, and one in pricing or cost code is an estimate input
        // Recorded output and price/cost tables are still reported, in their own roles (see js.ts)
        if (inExampleOrTokenizer(s))
            continue;
        const recordedOut = inRecordedResponse(s);
        if (recordedOut || inCostContext(s)) {
            out.push({
                ...(recordedOut ? { recorded: true, reason: "recorded response" } : { listed: true, reason: "price or cost table" }), weak: true,
                provider: ref.provider.id, kind: "model-ref", lang: "py", file: ctx.file, line: lineOf(s),
                model: ref.model, confidence: "possible", snippet: snippetOf(ctx.source, s), host: ref.host ?? fileHost(ctx),
            });
            continue;
        }
        const ownKind = pySettingKind(s);
        // A model-named list inside a table of capabilities or prices (models: [...] in a compatibility matrix) is data
        const strict = (ownKind === "listed" && inDataTable(s) ? undefined : ownKind) ?? (alwaysCounts(ref.model) && !isPairKey(s, ["parenthesized_expression"]) && !inDataCollection(s) ? (inModelCollection(s, (k) => !!modelRef(k)) ? "listed" : "setting") : undefined);
        // Otherwise a model enum, list, per-provider map or model-shaped call counts if the repo uses the provider
        //
        const kind = strict ?? candidateKind(s, ["string"], (t) => !!modelRef(t, routed)) ?? "catalog";
        out.push({
            ...(kind === "listed" ? { listed: true, owner: collectionName(s) } : {}),
            ...(kind === "catalog" ? { listed: true, context: "catalog", contextReason: "a model id outside a request or setting (a list, table or text)" } : {}),
            ...(kind === "setting" ? { setting: true } : {}),
            ...(strict ? {} : { weak: true }),
            provider: ref.provider.id, kind: "model-ref", lang: "py", file: ctx.file, line: lineOf(s),
            model: ref.model, confidence: "possible", snippet: snippetOf(ctx.source, s), host: ref.host ?? fileHost(ctx),
            // A prefixed ID ("anthropic/claude-x") isn't rewritten by fix PRs: the replacement has no prefix
            modelSpan: ref.prefixed ? undefined : { start: s.startIndex, end: s.endIndex, kind: "string" },
        });
    }
    return out;
}
function readKwargs(ctx, call) {
    const params = [];
    const paramSpans = {};
    let model;
    let modelSpan;
    const argList = call.childForFieldName("arguments");
    for (const a of argList ? named(argList) : []) {
        // v7: create(**params): the keys params gets earlier in the same function ({…} literal, params["k"] = …)
        // v11: also **build(), **({…} if c else {}), and a wrapper's parameter traced back to its callers
        if (a.type === "dictionary_splat" && named(a)[0]) {
            for (const [k, span] of dictKeysOf(ctx, named(a)[0], call, 3))
                if (!params.includes(k))
                    (params.push(k), (paramSpans[k] = span));
            continue;
        }
        if (a.type !== "keyword_argument")
            continue;
        const k = a.childForFieldName("name")?.text;
        if (!k)
            continue;
        // v10: create(params={…}) (StripeClient and other clients that take the request as one dict): its keys are the params
        const val = a.childForFieldName("value");
        if (k === "params" && val && (val.type === "dictionary" || val.type === "identifier")) {
            const keys = val.type === "dictionary"
                ? (() => { const d = readDict(ctx, val); return d.params.map((p) => [p, d.paramSpans?.[p] ?? { start: a.startIndex, end: a.endIndex }]); })()
                : dictKeysBoundTo(ctx, val, call);
            if (keys.length) {
                for (const [pk, span] of keys)
                    if (!params.includes(pk))
                        (params.push(pk), (paramSpans[pk] = span));
                continue;
            }
        }
        params.push(k);
        paramSpans[k] = { start: a.startIndex, end: a.endIndex };
        if (k === "model") {
            model = resolveString(ctx, a.childForFieldName("value"), true);
            modelSpan = literalSpan(ctx, a.childForFieldName("value"));
        }
    }
    return { model, params, modelSpan, paramSpans: params.length ? paramSpans : undefined };
}
/** Where a string value is written: the literal, a module constant's literal, or the default in os.environ.get(..., "x"). */
function literalSpan(ctx, node) {
    if (!node)
        return undefined;
    if (node.type === "string") {
        return named(node).some((p) => p.type === "interpolation") ? undefined : { start: node.startIndex, end: node.endIndex, kind: "string" };
    }
    if (node.type === "boolean_operator")
        return literalSpan(ctx, node.childForFieldName("right"));
    if (node.type === "parenthesized_expression")
        return literalSpan(ctx, named(node)[0]);
    if (node.type === "call" && /^(os\.environ\.get|os\.getenv|getenv)$/.test(node.childForFieldName("function")?.text ?? "")) {
        return literalSpan(ctx, named(node.childForFieldName("arguments") ?? node)[1]);
    }
    if (node.type === "identifier") {
        for (const a of nodesOfType(ctx.tree.rootNode, "assignment")) {
            if (a.childForFieldName("left")?.text === node.text)
                return literalSpan(ctx, a.childForFieldName("right"));
        }
    }
    return undefined;
}
function readDict(ctx, dict) {
    const params = [];
    const paramSpans = {};
    let model;
    let modelSpan;
    for (const pair of named(dict).filter((n) => n.type === "pair")) {
        const k = resolveString(ctx, pair.childForFieldName("key"));
        if (!k)
            continue;
        params.push(k);
        paramSpans[k] = { start: pair.startIndex, end: pair.endIndex };
        if (k === "model") {
            model = resolveString(ctx, pair.childForFieldName("value"), true);
            modelSpan = literalSpan(ctx, pair.childForFieldName("value"));
        }
    }
    return { model, params, modelSpan, paramSpans: params.length ? paramSpans : undefined };
}
function kwarg(call, name) {
    const argList = call.childForFieldName("arguments");
    for (const a of argList ? named(argList) : []) {
        if (a.type === "keyword_argument" && a.childForFieldName("name")?.text === name)
            return a.childForFieldName("value") ?? undefined;
    }
    return undefined;
}
function stringValue(s) {
    if (s.type !== "string")
        return undefined;
    const parts = named(s);
    if (parts.some((p) => p.type === "interpolation"))
        return undefined;
    return parts.filter((p) => p.type === "string_content").map((p) => p.text).join("");
}
function resolveString(ctx, node, markConsumed = false) {
    if (!node)
        return undefined;
    switch (node.type) {
        case "string": {
            if (markConsumed && !ctx.noConsume)
                ctx.consumed.add(node.startIndex);
            let out = "";
            for (const p of named(node)) {
                if (p.type === "string_content" || p.type === "escape_sequence")
                    out += p.text;
                else if (p.type === "interpolation")
                    out += resolveString(ctx, named(p)[0], markConsumed) ?? "{?}";
            }
            return out;
        }
        case "concatenated_string":
            return named(node).map((s) => resolveString(ctx, s, markConsumed) ?? "{?}").join("");
        case "identifier": {
            if (!ctx.consts.has(node.text))
                return undefined;
            const v = ctx.assigns.size ? valueAt(ctx, node) : ctx.consts.get(node.text);
            if (v !== undefined && markConsumed && !ctx.noConsume)
                markConst(ctx, node.text);
            return v;
        }
        case "binary_operator": {
            const op = node.childForFieldName("operator")?.text;
            if (op !== "+")
                return undefined;
            const l = resolveString(ctx, node.childForFieldName("left"), markConsumed);
            const r = resolveString(ctx, node.childForFieldName("right"), markConsumed);
            return (l ?? "{?}") + (r ?? "{?}");
        }
        case "boolean_operator": {
            const l = resolveString(ctx, node.childForFieldName("left"), markConsumed);
            return l ?? resolveString(ctx, node.childForFieldName("right"), markConsumed);
        }
        case "call": {
            // os.environ.get("X", "default") / os.getenv("X", "default")
            const fn = node.childForFieldName("function")?.text ?? "";
            if (/^(os\.environ\.get|os\.getenv|getenv)$/.test(fn)) {
                const args = named(node.childForFieldName("arguments") ?? node);
                return args[1] ? resolveString(ctx, args[1], markConsumed) : undefined;
            }
            return undefined;
        }
        case "parenthesized_expression":
            return resolveString(ctx, named(node)[0], markConsumed);
        default:
            return undefined;
    }
}
function markConst(ctx, name) {
    for (const a of nodesOfType(ctx.tree.rootNode, "assignment")) {
        if (a.childForFieldName("left")?.text !== name)
            continue;
        const r = a.childForFieldName("right");
        if (r)
            for (const s of nodesOfType(r, "string"))
                ctx.consumed.add(s.startIndex);
        if (r?.type === "string")
            ctx.consumed.add(r.startIndex);
    }
}
/** v7, light data flow: keys a dict name gets in the enclosing function before `at`: `d = {…}`, `d["k"] = …` */
function dictKeysBoundTo(ctx, id, at) {
    let scope = at.parent;
    while (scope && !["function_definition", "module"].includes(scope.type))
        scope = scope.parent;
    if (!scope)
        return [];
    const out = [];
    for (const a of scope.descendantsOfType("assignment")) {
        if (!a || a.startIndex >= at.startIndex)
            continue;
        const left = a.childForFieldName("left");
        const right = a.childForFieldName("right");
        if (left?.text === id.text && right?.type === "dictionary") {
            const d = readDict(ctx, right);
            for (const k of d.params)
                out.push([k, d.paramSpans?.[k] ?? { start: a.startIndex, end: a.endIndex }]);
        }
        else if (left?.type === "subscript" && left.childForFieldName("value")?.text === id.text) {
            const k = resolveString(ctx, left.childForFieldName("subscript"));
            if (k)
                out.push([k, { start: a.startIndex, end: a.endIndex }]);
        }
    }
    return out;
}
/**
 * v11, data flow within a module: the dict keys that can reach `n` (a `**` argument or a `params=` value). Follows a
 * dict literal, a name bound to one (or to a builder call), a call to a module function that returns a dict, the
 * branches of a conditional (`{…} if c else {}`), `{**a, **b}` and `dict(a, k=v)`, and a parameter back to the
 * function's callers. Depth-limited.
 */
function dictKeysOf(ctx, n, at, depth) {
    let node = n;
    while (node?.type === "parenthesized_expression")
        node = named(node)[0] ?? null;
    if (!node || depth < 0)
        return [];
    if (node.type === "dictionary") {
        const d = readDict(ctx, node);
        const out = d.params.map((k) => [k, d.paramSpans?.[k] ?? { start: node.startIndex, end: node.endIndex }]);
        for (const s of named(node).filter((c) => c.type === "dictionary_splat"))
            out.push(...dictKeysOf(ctx, named(s)[0], at, depth - 1));
        return out;
    }
    if (node.type === "conditional_expression")
        return named(node).flatMap((c) => (c.type === "dictionary" || c.type === "parenthesized_expression" || c.type === "call" || c.type === "identifier" ? dictKeysOf(ctx, c, at, depth - 1) : []));
    if (node.type === "identifier") {
        const out = dictKeysBoundTo(ctx, node, at);
        let scope = at.parent;
        while (scope && !["function_definition", "module"].includes(scope.type))
            scope = scope.parent;
        // name = build(…): what build returns
        for (const a of scope?.descendantsOfType("assignment") ?? []) {
            if (!a || a.startIndex >= at.startIndex || a.childForFieldName("left")?.text !== node.text)
                continue;
            const right = a.childForFieldName("right");
            if (right?.type === "call" && depth > 0)
                out.push(...dictKeysOf(ctx, right, a, depth - 1));
        }
        // A parameter: what the function's callers in this module pass in that position
        if (!out.length && scope?.type === "function_definition" && depth > 0) {
            const name = scope.childForFieldName("name")?.text;
            const ps = named(scope.childForFieldName("parameters") ?? scope).map((p) => (p.type === "identifier" ? p.text : p.childForFieldName("name")?.text ?? named(p)[0]?.text));
            const i = ps.filter((p) => p !== "self" && p !== "cls").indexOf(node.text);
            if (name && i >= 0) {
                for (const c of ctx.tree.rootNode.descendantsOfType("call")) {
                    if (!c || (c.childForFieldName("function")?.text ?? "").split(".").pop() !== name)
                        continue;
                    const arg = named(c.childForFieldName("arguments") ?? c).filter((x) => x.type !== "keyword_argument")[i];
                    if (arg)
                        out.push(...dictKeysOf(ctx, arg, c, depth - 1));
                }
            }
        }
        return out;
    }
    if (node.type === "call" && depth > 0) {
        const fn = node.childForFieldName("function");
        const fname = fn?.text.split(".").pop() ?? "";
        // dict(base, k=v): the keyword arguments
        if (fname === "dict")
            return readKwargs(ctx, node).params.map((k) => [k, { start: node.startIndex, end: node.endIndex }]);
        const out = [];
        for (const d of ctx.tree.rootNode.descendantsOfType("function_definition")) {
            if (!d || d.childForFieldName("name")?.text !== fname)
                continue;
            for (const r of d.descendantsOfType("return_statement")) {
                const e = r && named(r)[0];
                if (e)
                    out.push(...dictKeysOf(ctx, e, r, depth - 1));
            }
        }
        return out;
    }
    return [];
}
