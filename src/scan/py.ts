import { PROVIDERS, hostOfClass, matchUrl, mentionsRouter, modelProvider, modelRef, providerById, sdkOp, urlVersionOf } from "../providers.js";
import type { ModelSpan, Span, Usage } from "../types.js";
import { normalizePath } from "./js.js";
import { alwaysCounts, inModelCollection, isPairKey, pySettingKind } from "./context.js";
import { candidateKind, collectionName, inCostContext, inDataCollection, inDataTable, inExampleOrTokenizer, inRecordedResponse } from "./shapes.js";
import { lineOf, named, nodesOfType, snippetOf, type Node, type Tree } from "./parser.js";

interface PyCtx {
  file: string;
  source: string;
  tree: Tree;
  /** name → provider, for the imported SDK module (import openai / import anthropic as a) */
  modules: Map<string, string>;
  /** name → provider, for imported client classes (from openai import OpenAI) */
  classes: Map<string, string>;
  /** "name" or "self.name" → provider, for constructed clients */
  clients: Map<string, string>;
  clientHosts: Map<string, "azure" | "bedrock" | "vertex">;
  /** client name → relay host (base_url pointing at a non-provider server) */
  clientProxies: Map<string, string>;
  /** alias → original class name */
  classNames: Map<string, string>;
  /** def make_client(): return Anthropic() → provider */
  factories: Map<string, string>;
  consts: Map<string, string>;
  /** name → base_url, for requests.Session / httpx.Client instances */
  httpClients: Map<string, string>;
  /** names bound to boto3.client("bedrock-runtime") */
  bedrockClients: Set<string>;
  consumed: Set<number>;
}

const HTTP_LIBS = /^(requests|httpx|aiohttp|urllib3)$/;
const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "request", "stream"];

export function analyzePy(file: string, source: string, tree: Tree): Usage[] {
  const ctx: PyCtx = {
    file, source, tree,
    modules: new Map(), classes: new Map(), clients: new Map(), clientHosts: new Map(), clientProxies: new Map(), classNames: new Map(), factories: new Map(),
    consts: new Map(), httpClients: new Map(), bedrockClients: new Set(), consumed: new Set(),
  };
  collectImports(ctx);
  collectConsts(ctx);
  collectClients(ctx);

  const usages: Usage[] = [];
  for (const call of nodesOfType(tree.rootNode, "call")) {
    const fn = call.childForFieldName("function");
    if (!fn) continue;
    const u = sdkCall(ctx, call, fn) ?? httpCall(ctx, call, fn) ?? modelIdCall(ctx, call, fn);
    if (u) usages.push(u);
  }
  usages.push(...versionPins(ctx));
  usages.push(...modelRefs(ctx));
  return usages;
}

function providerForModule(mod: string): string | undefined {
  // A provider's package list may name a dotted import path (google.ads.googleads); the longest match wins
  let best: { id: string; len: number } | undefined;
  for (const p of PROVIDERS)
    for (const pkg of p.packages.py ?? [])
      if (pkg.includes(".") && (mod === pkg || mod.startsWith(pkg + ".")) && (!best || pkg.length > best.len)) best = { id: p.id, len: pkg.length };
  if (best) return best.id;
  // Google's import names differ from their pip package names
  if (/^google\.(genai|generativeai)(\.|$)|^vertexai(\.|$)/.test(mod)) return "google";
  if (mod === "google") return undefined;
  // Import names that differ from pip package names
  if (/^shopify(\.|$)/.test(mod)) return "shopify";
  const top = mod.split(".")[0];
  return PROVIDERS.find((p) => (p.packages.py ?? []).includes(top))?.id;
}

function collectImports(ctx: PyCtx): void {
  for (const imp of nodesOfType(ctx.tree.rootNode, "import_statement")) {
    for (const n of named(imp)) {
      const mod = n.type === "aliased_import" ? n.childForFieldName("name")?.text : n.text;
      const alias = n.type === "aliased_import" ? n.childForFieldName("alias")?.text : n.text.split(".")[0];
      const p = mod && providerForModule(mod);
      if (p && alias) ctx.modules.set(alias, p);
    }
  }
  for (const imp of nodesOfType(ctx.tree.rootNode, "import_from_statement")) {
    const mod = imp.childForFieldName("module_name")?.text;
    // from google import genai / from google import generativeai as genai
    if (mod === "google") {
      for (const n of named(imp).slice(1)) {
        const name = n.type === "aliased_import" ? n.childForFieldName("name")?.text : n.text;
        const alias = n.type === "aliased_import" ? n.childForFieldName("alias")?.text : n.text;
        if (alias && (name === "genai" || name === "generativeai")) ctx.modules.set(alias, "google");
      }
      continue;
    }
    const p = mod && providerForModule(mod);
    if (!p) continue;
    const prov = providerById(p)!;
    for (const n of named(imp).slice(1)) {
      const name = n.type === "aliased_import" ? n.childForFieldName("name")?.text : n.text;
      const alias = n.type === "aliased_import" ? n.childForFieldName("alias")?.text : n.text;
      if (!name || !alias) continue;
      if (prov.clientClasses.includes(name)) {
        ctx.classes.set(alias, p);
        ctx.classNames.set(alias, name);
      }
      // from openai import ChatCompletion (legacy v0) → treat the name as a module-level root
      else if (/^[A-Z]/.test(name)) ctx.modules.set(alias, p);
    }
  }
}

function collectConsts(ctx: PyCtx): void {
  for (let pass = 0; pass < 2; pass++) {
    for (const a of nodesOfType(ctx.tree.rootNode, "assignment")) {
      const left = a.childForFieldName("left");
      if (left?.type !== "identifier") continue;
      const v = resolveString(ctx, a.childForFieldName("right"));
      if (v !== undefined && !v.includes("{?}")) ctx.consts.set(left.text, v);
    }
  }
}

function clientFromExpr(ctx: PyCtx, expr: Node | null): string | undefined {
  if (!expr) return undefined;
  if (expr.type === "await") return clientFromExpr(ctx, named(expr)[0] ?? null);
  if (expr.type === "call") {
    const fn = expr.childForFieldName("function");
    if (!fn) return undefined;
    if (fn.type === "identifier" && ctx.classes.has(fn.text)) return ctx.classes.get(fn.text);
    if (fn.type === "identifier" && ctx.factories.has(fn.text)) return ctx.factories.get(fn.text);
    if (fn.type === "attribute") {
      // openai.OpenAI() / anthropic.Anthropic()
      const obj = fn.childForFieldName("object")?.text;
      const attr = fn.childForFieldName("attribute")?.text;
      const p = obj && ctx.modules.get(obj);
      if (p && attr && providerById(p)!.clientClasses.includes(attr)) return p;
    }
  }
  if ((expr.type === "identifier" || expr.type === "attribute") && ctx.clients.has(expr.text)) return ctx.clients.get(expr.text);
  return undefined;
}

function hostFromExpr(ctx: PyCtx, expr: Node | null): "azure" | "bedrock" | "vertex" | undefined {
  if (!expr) return undefined;
  if (expr.type === "identifier" || expr.type === "attribute") {
    const h = ctx.clientHosts.get(expr.text);
    if (h) return h;
  }
  if (expr.type !== "call") return undefined;
  const fn = expr.childForFieldName("function");
  if (!fn) return undefined;
  // genai.Client(vertexai=True, ...)
  if (kwarg(expr, "vertexai")?.text === "True") return "vertex";
  if (fn.type === "identifier") return hostOfClass(ctx.classNames.get(fn.text) ?? "") ?? ctx.clientHosts.get(`fn:${fn.text}`);
  return hostOfClass(fn.childForFieldName("attribute")?.text ?? "");
}

function collectClients(ctx: PyCtx): void {
  // def make_client(): return Anthropic()
  for (const f of nodesOfType(ctx.tree.rootNode, "function_definition")) {
    const name = f.childForFieldName("name")?.text;
    const body = f.childForFieldName("body");
    if (!name || !body) continue;
    for (const r of nodesOfType(body, "return_statement")) {
      const value = named(r)[0] ?? null;
      const p = clientFromExpr(ctx, value);
      if (p) {
        ctx.factories.set(name, p);
        const h = hostFromExpr(ctx, value);
        if (h) ctx.clientHosts.set(`fn:${name}`, h);
        break;
      }
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    for (const a of nodesOfType(ctx.tree.rootNode, "assignment")) {
      const left = a.childForFieldName("left");
      if (!left) continue;
      const right = a.childForFieldName("right");
      const p = clientFromExpr(ctx, right) ?? typeProvider(ctx, a.childForFieldName("type"));
      if (p && (left.type === "identifier" || left.type === "attribute")) {
        ctx.clients.set(left.text, p);
        const h = hostFromExpr(ctx, right);
        if (h) ctx.clientHosts.set(left.text, h);
        // OpenAI(base_url=os.getenv("BASE", "https://relay.example/v1"))
        const base = right?.type === "call" ? kwarg(right, "base_url") : undefined;
        const url = base ? resolveString(ctx, base) : undefined;
        const host = url ? /^https?:\/\/([^/]+)/.exec(url)?.[1] : undefined;
        if (host && !providerById(p)!.hosts.some((x) => host.endsWith(x)) && !/localhost|127\.0\.0\.1/.test(host)) ctx.clientProxies.set(left.text, host);
      }
      // http sessions: s = requests.Session() / httpx.Client(base_url="...")
      if (right?.type === "call" && left.type !== "pattern_list") {
        const fnText = right.childForFieldName("function")?.text ?? "";
        // bedrock = boto3.client("bedrock-runtime") / session.client(service_name="bedrock-runtime")
        if (/(^|\.)client$/.test(fnText)) {
          const firstArg = named(right.childForFieldName("arguments") ?? right)[0];
          const svc = resolveString(ctx, kwarg(right, "service_name") ?? (firstArg?.type !== "keyword_argument" ? firstArg : undefined));
          if (svc === "bedrock-runtime") ctx.bedrockClients.add(left.text);
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
      if (value?.type !== "call" || !target) continue;
      const p = clientFromExpr(ctx, value);
      const name = target.text.replace(/^as\s+/, "");
      if (p) ctx.clients.set(name, p);
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
      if (name && p) ctx.clients.set(name, p);
    }
  }
}

function typeProvider(ctx: PyCtx, t: Node | null): string | undefined {
  if (!t) return undefined;
  const text = t.text.replace(/["']/g, "");
  for (const [name, p] of ctx.classes) if (new RegExp(`\\b${name}\\b`).test(text)) return p;
  for (const [mod, p] of ctx.modules) if (text.startsWith(mod + ".")) return p;
  return undefined;
}

function attrChain(fn: Node): { root: string; path: string[] } | undefined {
  const path: string[] = [];
  let cur: Node | null = fn;
  while (cur && cur.type === "attribute") {
    const attr = cur.childForFieldName("attribute");
    const obj = cur.childForFieldName("object");
    if (!attr || !obj) return undefined;
    if (obj.type === "identifier" && obj.text === "self") return { root: cur.text, path: path.reverse() };
    path.push(attr.text);
    cur = obj;
  }
  if (!cur || cur.type !== "identifier" || path.length === 0) return undefined;
  return { root: cur.text, path: path.reverse() };
}

function sdkCall(ctx: PyCtx, call: Node, fn: Node): Usage | undefined {
  const chain = attrChain(fn);
  if (!chain) return undefined;
  let providerId = ctx.clients.get(chain.root);
  let callPath = chain.path.join(".");
  let confidence: Usage["confidence"] = "certain";
  if (!providerId && ctx.modules.has(chain.root)) {
    // openai.chat.completions.create (module-level client) or openai.ChatCompletion.create (legacy v0)
    providerId = ctx.modules.get(chain.root);
    // from openai import ChatCompletion → ChatCompletion.create
    if (/^[A-Z]/.test(chain.root)) callPath = `${chain.root}.${callPath}`;
  }
  if (!providerId) {
    const imported = new Set([...ctx.modules.values(), ...ctx.classes.values()]);
    for (const pid of imported) {
      if (Object.prototype.hasOwnProperty.call(providerById(pid)!.sdkOps, callPath)) {
        providerId = pid;
        confidence = "likely";
        break;
      }
    }
  }
  if (!providerId) return undefined;
  const provider = providerById(providerId)!;
  const op = sdkOp(provider, callPath);
  if (!op) return undefined;
  const info = readKwargs(ctx, call);
  const { model, params } = info;
  return {
    provider: provider.id, kind: "sdk", lang: "py", file: ctx.file, line: lineOf(call),
    op, sdkCall: callPath, model, params, confidence, snippet: snippetOf(ctx.source, call),
    modelSpan: info.modelSpan, paramSpans: info.paramSpans,
    host: ctx.clientHosts.get(chain.root) ?? (confidence === "likely" ? fileHost(ctx) : undefined),
    proxy: ctx.clientProxies.get(chain.root),
  };
}

function fileHost(ctx: PyCtx): "azure" | "bedrock" | "vertex" | undefined {
  const names = [...ctx.classes.keys()].map((a) => ctx.classNames.get(a) ?? a);
  if (!names.length) return undefined;
  const hosts = new Set(names.map(hostOfClass));
  return hosts.size === 1 ? [...hosts][0] : undefined;
}

function httpCall(ctx: PyCtx, call: Node, fn: Node): Usage | undefined {
  if (fn.type !== "attribute") return undefined;
  const target = fn.childForFieldName("object")?.text ?? "";
  const methodName = fn.childForFieldName("attribute")?.text ?? "";
  if (!HTTP_METHODS.includes(methodName)) return undefined;
  const isLib = HTTP_LIBS.test(target);
  const base = ctx.httpClients.get(target);
  if (!isLib && base === undefined) return undefined;

  const argList = call.childForFieldName("arguments");
  const positional = argList ? named(argList).filter((a) => a.type !== "keyword_argument") : [];
  let method = methodName.toUpperCase();
  let urlNode: Node | undefined = positional[0] ?? kwarg(call, "url");
  if (methodName === "request" || methodName === "stream") {
    const m = positional[0] && resolveString(ctx, positional[0]);
    if (m) method = m.toUpperCase();
    urlNode = positional[1] ?? kwarg(call, "url");
  }
  let url = urlNode ? resolveString(ctx, urlNode) : undefined;
  if (url === undefined) return undefined;
  if (base && !/^https?:/.test(url)) url = base.replace(/\/+$/, "") + "/" + url.replace(/^\/+/, "");
  const hit = matchUrl(url);
  if (!hit) return undefined;
  const body = kwarg(call, "json");
  const info: ArgInfo = body?.type === "dictionary" ? readDict(ctx, body) : { params: [] };
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
const BEDROCK_OPS: Record<string, string> = {
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
function modelIdCall(ctx: PyCtx, call: Node, fn: Node): Usage | undefined {
  const valueNode = kwarg(call, "modelId") ?? kwarg(call, "model_id") ?? (BEDROCK_METHOD(fn) ? kwarg(call, "model") : undefined);
  if (!valueNode) return undefined;
  const model = resolveString(ctx, valueNode);
  if (!model) return undefined;
  const p = modelProvider(model);
  if (!p) return undefined;
  resolveString(ctx, valueNode, true); // mark the literal as used so it isn't also a model-ref
  const method = fn.type === "attribute" ? fn.childForFieldName("attribute")?.text ?? "" : fn.text;
  const receiver = fn.type === "attribute" ? fn.childForFieldName("object")?.text ?? "" : "";
  const op = BEDROCK_OPS[method];
  return {
    provider: p.id, kind: "sdk", lang: "py", file: ctx.file, line: lineOf(call),
    op, sdkCall: receiver ? `${method}` : fn.text, model, params: readKwargs(ctx, call).params,
    paramSpans: readKwargs(ctx, call).paramSpans, modelSpan: literalSpan(ctx, valueNode),
    confidence: op && ctx.bedrockClients.has(receiver) ? "certain" : "likely",
    snippet: snippetOf(ctx.source, call),
  };
}

function BEDROCK_METHOD(fn: Node): boolean {
  return fn.type === "attribute" && (fn.childForFieldName("attribute")?.text ?? "") in BEDROCK_OPS;
}

function versionPins(ctx: PyCtx): Usage[] {
  const out: Usage[] = [];
  for (const pair of nodesOfType(ctx.tree.rootNode, "pair")) {
    const key = (resolveString(ctx, pair.childForFieldName("key")) ?? "").toLowerCase();
    for (const p of PROVIDERS) {
      if (!p.versionHeaders.includes(key)) continue;
      const v = resolveString(ctx, pair.childForFieldName("value"));
      if (v) out.push({
        provider: p.id, kind: "version-pin", lang: "py", file: ctx.file, line: lineOf(pair),
        apiVersion: `${key}: ${v}`, confidence: "certain", snippet: snippetOf(ctx.source, pair),
      });
    }
  }
  // stripe.api_version = "2024-06-20"
  for (const a of nodesOfType(ctx.tree.rootNode, "assignment")) {
    const left = a.childForFieldName("left");
    if (left?.type !== "attribute") continue;
    const pid = ctx.modules.get(left.childForFieldName("object")?.text ?? "");
    const attr = left.childForFieldName("attribute")?.text ?? "";
    const p = pid ? providerById(pid) : undefined;
    const v = resolveString(ctx, a.childForFieldName("right"));
    if (p?.versionKeys?.includes(attr) && v) out.push({
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
    if (!p?.versionKeys) continue;
    for (const k of p.versionKeys) {
      const vNode = kwarg(call, k);
      const v = vNode ? resolveString(ctx, vNode) : undefined;
      if (v) out.push({
        provider: p.id, kind: "version-pin", lang: "py", file: ctx.file, line: lineOf(call),
        apiVersion: `${k}: ${v}`, confidence: "certain", snippet: snippetOf(ctx.source, call),
      });
    }
  }
  return out;
}

function modelRefs(ctx: PyCtx): Usage[] {
  const out: Usage[] = [];
  const routed = mentionsRouter(ctx.source);
  for (const s of nodesOfType(ctx.tree.rootNode, "string")) {
    if (ctx.consumed.has(s.startIndex)) continue;
    const v = stringValue(s);
    if (v === undefined) continue;
    const ref = modelRef(v, routed);
    if (!ref) continue;
    // A cloud-form ID (Vertex "@", Bedrock "anthropic.") counts anywhere except as a lookup-table key (prices, sizes)
    // A model in a recorded or mocked API response is output, and one in pricing or cost code is an estimate input
    if (inRecordedResponse(s) || inCostContext(s) || inExampleOrTokenizer(s)) continue;
    const ownKind = pySettingKind(s);
    // A model-named list inside a table of capabilities or prices (models: [...] in a compatibility matrix) is data
    const strict = (ownKind === "listed" && inDataTable(s) ? undefined : ownKind) ?? (alwaysCounts(ref.model) && !isPairKey(s, ["parenthesized_expression"]) && !inDataCollection(s) ? (inModelCollection(s, (k) => !!modelRef(k)) ? "listed" : "setting") : undefined);
    // Otherwise a model enum, list, per-provider map or model-shaped call counts if the repo uses the provider
    const kind = strict ?? candidateKind(s, ["string"], (t) => !!modelRef(t, routed));
    if (!kind) continue;
    out.push({
      ...(kind === "listed" ? { listed: true, owner: collectionName(s) } : {}),
      ...(strict ? {} : { weak: true }),
      provider: ref.provider.id, kind: "model-ref", lang: "py", file: ctx.file, line: lineOf(s),
      model: ref.model, confidence: "possible", snippet: snippetOf(ctx.source, s), host: ref.host ?? fileHost(ctx),
      // A prefixed ID ("anthropic/claude-x") isn't rewritten by fix PRs: the replacement has no prefix
      modelSpan: ref.prefixed ? undefined : { start: s.startIndex, end: s.endIndex, kind: "string" },
    });
  }
  return out;
}

interface ArgInfo {
  model?: string;
  params: string[];
  modelSpan?: ModelSpan;
  paramSpans?: Record<string, Span>;
}

function readKwargs(ctx: PyCtx, call: Node): ArgInfo {
  const params: string[] = [];
  const paramSpans: Record<string, Span> = {};
  let model: string | undefined;
  let modelSpan: ModelSpan | undefined;
  const argList = call.childForFieldName("arguments");
  for (const a of argList ? named(argList) : []) {
    if (a.type !== "keyword_argument") continue;
    const k = a.childForFieldName("name")?.text;
    if (!k) continue;
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
function literalSpan(ctx: PyCtx, node: Node | null | undefined): ModelSpan | undefined {
  if (!node) return undefined;
  if (node.type === "string") {
    return named(node).some((p) => p.type === "interpolation") ? undefined : { start: node.startIndex, end: node.endIndex, kind: "string" };
  }
  if (node.type === "boolean_operator") return literalSpan(ctx, node.childForFieldName("right"));
  if (node.type === "parenthesized_expression") return literalSpan(ctx, named(node)[0]);
  if (node.type === "call" && /^(os\.environ\.get|os\.getenv|getenv)$/.test(node.childForFieldName("function")?.text ?? "")) {
    return literalSpan(ctx, named(node.childForFieldName("arguments") ?? node)[1]);
  }
  if (node.type === "identifier") {
    for (const a of nodesOfType(ctx.tree.rootNode, "assignment")) {
      if (a.childForFieldName("left")?.text === node.text) return literalSpan(ctx, a.childForFieldName("right"));
    }
  }
  return undefined;
}

function readDict(ctx: PyCtx, dict: Node): ArgInfo {
  const params: string[] = [];
  const paramSpans: Record<string, Span> = {};
  let model: string | undefined;
  let modelSpan: ModelSpan | undefined;
  for (const pair of named(dict).filter((n) => n.type === "pair")) {
    const k = resolveString(ctx, pair.childForFieldName("key"));
    if (!k) continue;
    params.push(k);
    paramSpans[k] = { start: pair.startIndex, end: pair.endIndex };
    if (k === "model") {
      model = resolveString(ctx, pair.childForFieldName("value"), true);
      modelSpan = literalSpan(ctx, pair.childForFieldName("value"));
    }
  }
  return { model, params, modelSpan, paramSpans: params.length ? paramSpans : undefined };
}

function kwarg(call: Node, name: string): Node | undefined {
  const argList = call.childForFieldName("arguments");
  for (const a of argList ? named(argList) : []) {
    if (a.type === "keyword_argument" && a.childForFieldName("name")?.text === name) return a.childForFieldName("value") ?? undefined;
  }
  return undefined;
}

function stringValue(s: Node): string | undefined {
  if (s.type !== "string") return undefined;
  const parts = named(s);
  if (parts.some((p) => p.type === "interpolation")) return undefined;
  return parts.filter((p) => p.type === "string_content").map((p) => p.text).join("");
}

function resolveString(ctx: PyCtx, node: Node | null | undefined, markConsumed = false): string | undefined {
  if (!node) return undefined;
  switch (node.type) {
    case "string": {
      if (markConsumed) ctx.consumed.add(node.startIndex);
      let out = "";
      for (const p of named(node)) {
        if (p.type === "string_content" || p.type === "escape_sequence") out += p.text;
        else if (p.type === "interpolation") out += resolveString(ctx, named(p)[0], markConsumed) ?? "{?}";
      }
      return out;
    }
    case "concatenated_string":
      return named(node).map((s) => resolveString(ctx, s, markConsumed) ?? "{?}").join("");
    case "identifier":
      if (ctx.consts.has(node.text)) {
        if (markConsumed) markConst(ctx, node.text);
        return ctx.consts.get(node.text);
      }
      return undefined;
    case "binary_operator": {
      const op = node.childForFieldName("operator")?.text;
      if (op !== "+") return undefined;
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

function markConst(ctx: PyCtx, name: string): void {
  for (const a of nodesOfType(ctx.tree.rootNode, "assignment")) {
    if (a.childForFieldName("left")?.text !== name) continue;
    const r = a.childForFieldName("right");
    if (r) for (const s of nodesOfType(r, "string")) ctx.consumed.add(s.startIndex);
    if (r?.type === "string") ctx.consumed.add(r.startIndex);
  }
}
