import { createRequire } from "node:module";
import { PROVIDERS, matchUrl, modelProvider, providerById, sdkOp, urlVersionOf } from "../providers.js";
import { normalizePath } from "./js.js";
import { alwaysCounts, javaSetting } from "./context.js";
import { candidateKind } from "./shapes.js";
import { lineOf, named, nodesOfType, snippetOf } from "./parser.js";
const require = createRequire(import.meta.url);
/** Java SDK constants (Model.CLAUDE_SONNET_4_5, ChatModel.GPT_4O) → model ID, built from the SDKs' own source */
const JAVA_MODELS = require("../data/java-model-constants.json");
/** Types and builders that hold or make an SDK client */
const CLIENT_TYPES = {
    AnthropicClient: "anthropic", AnthropicClientAsync: "anthropic",
    AnthropicOkHttpClient: "anthropic", AnthropicOkHttpClientAsync: "anthropic",
    OpenAIClient: "openai", OpenAIClientAsync: "openai",
    OpenAIOkHttpClient: "openai", OpenAIOkHttpClientAsync: "openai",
};
const CALL_NAMES = new Set(["create", "createStreaming", "stream", "parse", "list", "retrieve", "countTokens", "generate", "delete", "update"]);
const IMPORT_PROVIDERS = [
    [/^com\.anthropic\./, "anthropic"],
    [/^com\.openai\./, "openai"],
    [/^com\.google\.genai\./, "google"],
];
export function analyzeJava(file, source, tree) {
    const ctx = { file, source, tree, providers: new Set(), clients: new Map(), consts: new Map(), inits: new Map(), consumed: new Set() };
    for (const imp of nodesOfType(tree.rootNode, "import_declaration")) {
        const name = imp.text.replace(/^import\s+(static\s+)?/, "").replace(/;$/, "").trim();
        for (const [re, p] of IMPORT_PROVIDERS)
            if (re.test(name))
                ctx.providers.add(p);
    }
    collectDeclarations(ctx);
    const usages = [];
    for (const call of nodesOfType(tree.rootNode, "method_invocation")) {
        const u = sdkCall(ctx, call) ?? modelIdSetter(ctx, call) ?? httpCall(ctx, call) ?? versionPin(ctx, call);
        if (u)
            usages.push(u);
    }
    // Apache HttpClient: new HttpPost(url) / new HttpGet("https://…")
    for (const c of nodesOfType(tree.rootNode, "object_creation_expression")) {
        const t = c.childForFieldName("type")?.text ?? "";
        const m = /^(?:[\w.]+\.)?Http(Post|Get|Put|Delete|Patch)$/.exec(t);
        if (!m)
            continue;
        const u = httpCall(ctx, c, m[1].toUpperCase());
        if (u)
            usages.push(u);
    }
    usages.push(...modelRefs(ctx));
    return usages;
}
// ---------- declarations ----------
function simpleType(t) {
    return (t?.text ?? "").replace(/<.*$/, "").split(".").pop() ?? "";
}
/** Root of a chain like AnthropicOkHttpClient.builder().apiKey(k).build() */
function chainRoot(n) {
    let cur = n;
    while (cur.type === "method_invocation" && cur.childForFieldName("object"))
        cur = cur.childForFieldName("object");
    return cur;
}
function clientFromInit(ctx, init) {
    if (!init)
        return undefined;
    if (init.type === "identifier")
        return ctx.clients.get(init.text);
    if (init.type === "method_invocation" || init.type === "object_creation_expression") {
        const root = init.type === "method_invocation" ? chainRoot(init) : init.childForFieldName("type");
        if (root && CLIENT_TYPES[root.text])
            return CLIENT_TYPES[root.text];
        if (root?.type === "identifier" && ctx.clients.has(root.text) && init.type === "method_invocation") {
            // client.withOptions(...) / client.async() keep the provider
            const name = init.childForFieldName("name")?.text ?? "";
            if (/^(withOptions|async|sync|withRawResponse)$/.test(name))
                return ctx.clients.get(root.text);
        }
    }
    return undefined;
}
function collectDeclarations(ctx) {
    const root = ctx.tree.rootNode;
    for (let pass = 0; pass < 2; pass++) {
        for (const decl of nodesOfType(root, ["local_variable_declaration", "field_declaration"])) {
            const type = simpleType(decl.childForFieldName("type"));
            for (const v of nodesOfType(decl, "variable_declarator")) {
                const name = v.childForFieldName("name")?.text;
                const value = v.childForFieldName("value");
                if (!name)
                    continue;
                if (value)
                    ctx.inits.set(name, value);
                const p = CLIENT_TYPES[type] ?? clientFromInit(ctx, value);
                if (p) {
                    ctx.clients.set(name, p);
                    if (decl.type === "field_declaration")
                        ctx.clients.set(`this.${name}`, p);
                }
                if (type === "String" && value) {
                    const s = resolveString(ctx, value);
                    if (s !== undefined && !s.includes("{?}"))
                        ctx.consts.set(name, s);
                }
            }
        }
        for (const param of nodesOfType(root, "formal_parameter")) {
            const p = CLIENT_TYPES[simpleType(param.childForFieldName("type"))];
            const name = param.childForFieldName("name")?.text;
            if (p && name)
                ctx.clients.set(name, p);
        }
        // this.client = AnthropicOkHttpClient.fromEnv();
        for (const a of nodesOfType(root, "assignment_expression")) {
            const left = a.childForFieldName("left");
            const p = clientFromInit(ctx, a.childForFieldName("right"));
            if (left && p) {
                ctx.clients.set(left.text, p);
                ctx.clients.set(left.text.replace(/^this\./, ""), p);
            }
        }
    }
}
// ---------- SDK calls ----------
/** client.messages().create(params) → root "client", path ["messages", "create"] */
function callChain(call) {
    const path = [];
    let cur = call;
    while (cur && cur.type === "method_invocation") {
        path.push(cur.childForFieldName("name")?.text ?? "");
        cur = cur.childForFieldName("object");
    }
    if (!cur)
        return undefined;
    const root = cur.type === "field_access" && cur.childForFieldName("object")?.type === "this" ? cur.text : cur.text;
    return { root, path: path.reverse() };
}
function sdkCall(ctx, call) {
    const name = call.childForFieldName("name")?.text ?? "";
    if (!CALL_NAMES.has(name))
        return undefined;
    const chain = callChain(call);
    if (!chain)
        return undefined;
    const providerId = ctx.clients.get(chain.root) ?? ctx.clients.get(chain.root.replace(/^this\./, ""));
    if (!providerId)
        return undefined;
    const provider = providerById(providerId);
    const path = chain.path
        .filter((p) => !/^(async|sync|withRawResponse|withOptions)$/.test(p))
        .map((p) => (p === "createStreaming" ? "create" : p));
    const callPath = path.join(".");
    const op = sdkOp(provider, callPath);
    if (!op)
        return undefined;
    const arg = named(call.childForFieldName("arguments") ?? call)[0];
    const { model, params, modelSpan, paramSpans } = readParams(ctx, arg);
    return {
        provider: provider.id, kind: "sdk", lang: "java", file: ctx.file, line: lineOf(call),
        op, sdkCall: callPath, model, params, confidence: "certain", snippet: snippetOf(ctx.source, call),
        modelSpan, paramSpans,
    };
}
function readParams(ctx, arg, depth = 0) {
    if (!arg || depth > 3)
        return { params: [] };
    if (arg.type === "identifier" && ctx.inits.has(arg.text))
        return readParams(ctx, ctx.inits.get(arg.text), depth + 1);
    if (arg.type !== "method_invocation")
        return { params: [] };
    const params = [];
    const paramSpans = {};
    let model;
    let modelSpan;
    let cur = arg;
    while (cur && cur.type === "method_invocation") {
        const setter = cur.childForFieldName("name")?.text ?? "";
        const value = named(cur.childForFieldName("arguments") ?? cur)[0];
        const obj = cur.childForFieldName("object");
        if (!["build", "builder"].includes(setter)) {
            params.push(snake(setter));
            // ".temperature(0.2)" including the line break before it: from the end of the previous link to the end of this one
            if (obj)
                paramSpans[snake(setter)] = { start: obj.endIndex, end: cur.endIndex };
            if (setter === "model" && value) {
                model = resolveModel(ctx, value);
                modelSpan = modelSpanOf(ctx, value);
            }
        }
        cur = obj;
    }
    return { model, params: params.reverse(), modelSpan, paramSpans: params.length ? paramSpans : undefined };
}
/** Model.CLAUDE_X → a java-const span; "claude-x" or Model.of("claude-x") → the string; a String constant → its literal */
function modelSpanOf(ctx, v) {
    if (v.type === "field_access")
        return { start: v.startIndex, end: v.endIndex, kind: "java-const" };
    if (v.type === "string_literal" && !v.text.startsWith('"""'))
        return { start: v.startIndex, end: v.endIndex, kind: "string" };
    if (v.type === "method_invocation" && v.childForFieldName("name")?.text === "of") {
        const inner = named(v.childForFieldName("arguments") ?? v)[0];
        return inner ? modelSpanOf(ctx, inner) : undefined;
    }
    if (v.type === "method_invocation" && v.childForFieldName("name")?.text === "asString") {
        const obj = v.childForFieldName("object");
        return obj ? modelSpanOf(ctx, obj) : undefined;
    }
    if (v.type === "identifier") {
        const init = ctx.inits.get(v.text);
        return init ? modelSpanOf(ctx, init) : undefined;
    }
    return undefined;
}
/** "Model.CLAUDE_SONNET_4_5", "ChatModel.GPT_4O", Model.of("..."), "claude-..." or a String constant */
function resolveModel(ctx, v) {
    if (v.type === "field_access") {
        const cls = v.childForFieldName("object")?.text.split(".").pop() ?? "";
        const field = v.childForFieldName("field")?.text ?? "";
        for (const prov of ["anthropic", "openai"]) {
            const table = JAVA_MODELS[prov];
            if (typeof table === "object" && table[cls]?.[field])
                return table[cls][field];
        }
        return undefined;
    }
    if (v.type === "method_invocation" && v.childForFieldName("name")?.text === "of") {
        const inner = named(v.childForFieldName("arguments") ?? v)[0];
        return inner ? resolveString(ctx, inner, true) : undefined;
    }
    // Model.CLAUDE_3_HAIKU_20240307.asString()
    if (v.type === "method_invocation" && v.childForFieldName("name")?.text === "asString") {
        const obj = v.childForFieldName("object");
        return obj ? resolveModel(ctx, obj) : undefined;
    }
    return resolveString(ctx, v, true);
}
function snake(s) {
    return s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
}
/** Bedrock / LangChain4j / Spring AI style: .modelId("us.anthropic.claude-...") or .modelName("gpt-4o") */
function modelIdSetter(ctx, call) {
    const name = call.childForFieldName("name")?.text ?? "";
    if (name !== "modelId" && name !== "modelName" && name !== "model")
        return undefined;
    const v = named(call.childForFieldName("arguments") ?? call)[0];
    if (!v)
        return undefined;
    const model = resolveModel(ctx, v);
    const p = model ? modelProvider(model) : undefined;
    if (!model || !p)
        return undefined;
    // A .model(...) inside params passed to an SDK call is already covered by that call
    if (name === "model" && ctx.providers.has(p.id))
        return undefined;
    const root = chainRoot(call).text;
    return {
        provider: p.id, kind: "sdk", lang: "java", file: ctx.file, line: nameLine(call),
        sdkCall: `${root}.${name}`, model, confidence: "likely", snippet: snippetOf(ctx.source, call), modelSpan: modelSpanOf(ctx, v),
    };
}
/** In a multi-line builder chain, report the line of this method's name, not the chain's first line */
function nameLine(call) {
    const n = call.childForFieldName("name");
    return n ? lineOf(n) : lineOf(call);
}
// ---------- HTTP, headers, loose model IDs ----------
// Calls whose first argument is a request URL: URI / builders, and Spring RestTemplate's request methods
const URL_TAKERS = /^(create|uri|url|baseUrl|newBuilder|exchange|postForObject|postForEntity|postForLocation|getForObject|getForEntity|patchForObject|put|delete|execute)$/;
const NAME_METHOD = { postForObject: "POST", postForEntity: "POST", postForLocation: "POST", getForObject: "GET", getForEntity: "GET", patchForObject: "PATCH", put: "PUT", delete: "DELETE" };
function httpCall(ctx, call, fixedMethod) {
    const name = fixedMethod ? "new" : call.childForFieldName("name")?.text ?? "";
    if (!fixedMethod && !URL_TAKERS.test(name))
        return undefined;
    // (put / delete / execute are common names: only on a receiver that looks like a REST client)
    if (/^(put|delete|execute)$/.test(name) && !/rest|template|client|http/i.test(call.childForFieldName("object")?.text ?? ""))
        return undefined;
    const arg = named(call.childForFieldName("arguments") ?? call)[0];
    const url = arg ? resolveString(ctx, arg) : undefined;
    if (!url)
        return undefined;
    const hit = matchUrl(url);
    if (!hit)
        return undefined;
    if (arg)
        for (const s of nodesOfType(arg, "string_literal"))
            ctx.consumed.add(s.startIndex);
    if (arg?.type === "string_literal")
        ctx.consumed.add(arg.startIndex);
    // Look at the whole statement for the HTTP method: .POST(...), .post(), "POST"
    let stmt = call;
    while (stmt && !/statement|declaration/.test(stmt.type))
        stmt = stmt.parent;
    const text = stmt?.text ?? call.text;
    const hm = /\bHttpMethod\.(POST|PUT|DELETE|PATCH|GET)\b/.exec(call.text);
    const method = fixedMethod ?? NAME_METHOD[name] ?? hm?.[1] ?? (/\.(POST|post)\s*\(|"POST"/.test(text) ? "POST" : /\.(PUT|put)\s*\(/.test(text) ? "PUT" : /\.(DELETE|delete)\s*\(/.test(text) ? "DELETE" : name === "baseUrl" ? "*" : "GET");
    return {
        provider: hit.provider.id, kind: "http", lang: "java", file: ctx.file, line: lineOf(call),
        op: `${method} ${normalizePath(hit.path)}`, confidence: "certain", snippet: snippetOf(ctx.source, call),
        host: url.includes("aiplatform.googleapis.com") ? "vertex" : undefined,
        apiVersion: urlVersionOf(hit.provider, url) ? `url: ${urlVersionOf(hit.provider, url)}` : undefined,
    };
}
function versionPin(ctx, call) {
    const name = call.childForFieldName("name")?.text ?? "";
    // (Spring HttpHeaders.set / add too: the key must be a provider's version header, so other set(k, v) calls don't count)
    if (!/^(header|addHeader|putHeader|setHeader|defaultHeader|putAdditionalHeader|set|add)$/.test(name))
        return undefined;
    const [k, v] = named(call.childForFieldName("arguments") ?? call);
    const key = k ? resolveString(ctx, k)?.toLowerCase() : undefined;
    const val = v ? resolveString(ctx, v) : undefined;
    if (!key || !val)
        return undefined;
    const p = PROVIDERS.find((pr) => pr.versionHeaders.includes(key));
    if (!p)
        return undefined;
    return {
        provider: p.id, kind: "version-pin", lang: "java", file: ctx.file, line: nameLine(call),
        apiVersion: `${key}: ${val}`, confidence: "certain", snippet: snippetOf(ctx.source, call),
    };
}
function modelRefs(ctx) {
    const out = [];
    for (const s of nodesOfType(ctx.tree.rootNode, "string_literal")) {
        if (ctx.consumed.has(s.startIndex))
            continue;
        const raw = stringValue(s);
        // a config placeholder's default (@Value("${llm.model:gpt-4o}")): the model when nothing sets the key; a key that
        // names a model makes it a setting
        const ph = raw !== undefined ? /^\$\{([\w.\-\[\]]+):-?([^{}$]+)\}$/.exec(raw.trim()) : null;
        const v = ph ? ph[2].trim() : raw;
        const p = v !== undefined ? modelProvider(v) : undefined;
        if (!p || !v)
            continue;
        // a model id given to a provider-named constructor or factory (new AnthropicGenerator("claude-…", …),
        // OpenAiChatModel.of("gpt-4o")) is that client's model
        const callee = s.parent?.type === "argument_list" ? s.parent.parent : undefined;
        const calleeName = callee ? (callee.childForFieldName("type")?.text ?? callee.childForFieldName("object")?.text ?? callee.childForFieldName("name")?.text ?? "") : "";
        const provCall = !!callee && /^(?:object_creation_expression|method_invocation)$/.test(callee.type) && /anthropic|claude|openai|gpt|gemini|mistral|cohere|bedrock|vertex/i.test(calleeName) && s.parent.namedChildren[0]?.id === s.id;
        const strict = alwaysCounts(v) || javaSetting(s) || (!!ph && /model/i.test(ph[1])) || provCall;
        // Otherwise a model enum, array or model-shaped call counts if the repo uses the provider
        //
        const cand = strict ? undefined : candidateKind(s, ["string_literal"], (t) => !!modelProvider(t)) ?? "catalog";
        out.push({
            ...(cand === "listed" ? { listed: true } : {}), ...(strict ? {} : { weak: true }),
            ...(cand === "catalog" ? { listed: true, context: "catalog", contextReason: "a model id outside a request or setting (a list, table or text)" } : {}),
            provider: p.id, kind: "model-ref", lang: "java", file: ctx.file, line: lineOf(s), model: v, confidence: "possible", snippet: snippetOf(ctx.source, s), modelSpan: { start: s.startIndex, end: s.endIndex, kind: "string" },
        });
    }
    // static final Model DEFAULT = Model.CLAUDE_3_HAIKU_20240307;
    for (const f of nodesOfType(ctx.tree.rootNode, "field_access")) {
        if (f.parent?.type === "argument_list" && f.parent.parent?.childForFieldName("name")?.text === "model")
            continue;
        const m = resolveModel(ctx, f);
        const p = m ? modelProvider(m) : undefined;
        if (p && m)
            out.push({ provider: p.id, kind: "model-ref", lang: "java", file: ctx.file, line: lineOf(f), model: m, confidence: "possible", snippet: snippetOf(ctx.source, f), modelSpan: { start: f.startIndex, end: f.endIndex, kind: "java-const" } });
    }
    return out;
}
function stringValue(s) {
    const t = s.text;
    if (t.startsWith('"""'))
        return undefined;
    return t.replace(/^"|"$/g, "").replace(/\\"/g, '"');
}
function resolveString(ctx, n, markConsumed = false) {
    if (!n)
        return undefined;
    switch (n.type) {
        case "string_literal":
            if (markConsumed)
                ctx.consumed.add(n.startIndex);
            return stringValue(n);
        case "identifier": {
            // a local of the enclosing method first, its nearest declaration above (String url = "https://…"; final String
            // runUrl = String.format(…)): one name is a different local in each method
            let fn = n.parent;
            while (fn && !/^(?:method_declaration|constructor_declaration|lambda_expression)$/.test(fn.type))
                fn = fn.parent;
            let best;
            if (fn)
                for (const d of nodesOfType(fn, "variable_declarator")) {
                    if (d.childForFieldName("name")?.text !== n.text || d.startIndex >= n.startIndex)
                        continue;
                    if (!best || d.startIndex > best.startIndex)
                        best = d;
                }
            const v = best?.childForFieldName("value");
            if (v && v.startIndex !== n.startIndex)
                return resolveString(ctx, v, markConsumed);
            return ctx.consts.get(n.text);
        }
        case "binary_expression": {
            if (n.childForFieldName("operator")?.text !== "+")
                return undefined;
            const l = resolveString(ctx, n.childForFieldName("left"), markConsumed);
            const r = resolveString(ctx, n.childForFieldName("right"), markConsumed);
            return (l ?? "{?}") + (r ?? "{?}");
        }
        case "parenthesized_expression":
            return resolveString(ctx, named(n)[0], markConsumed);
        case "method_invocation": {
            // System.getenv().getOrDefault("X", "default") / Optional.ofNullable(...).orElse("default")
            const name = n.childForFieldName("name")?.text;
            const args = named(n.childForFieldName("arguments") ?? n);
            if (name === "getOrDefault" && args[1])
                return resolveString(ctx, args[1], markConsumed);
            if (name === "orElse" && args[0])
                return resolveString(ctx, args[0], markConsumed);
            // String.format("https://…/threads/%s/runs", id) / "https://…/%s".formatted(id): the format, %s / %d as {?}
            const fmt = name === "format" && /^(?:String|java\.lang\.String)$/.test(n.childForFieldName("object")?.text ?? "") ? args[0] : name === "formatted" ? n.childForFieldName("object") : undefined;
            if (fmt) {
                const s = resolveString(ctx, fmt, markConsumed);
                return s?.replace(/%(?:\d+\$)?[-#+ 0,(]*\d*(?:\.\d+)?[sdfxXc]/g, "{?}");
            }
            return undefined;
        }
        default:
            return undefined;
    }
}
