import { dirname, resolve } from "node:path";
import { PROVIDERS, hostOfClass, matchUrl, mentionsRouter, modelProvider, modelRef, providerById, sdkOp, urlVersionOf, type ProviderDef } from "../providers.js";
import type { ModelSpan, Span, Usage } from "../types.js";
import { alwaysCounts, inModelCollection, isPairKey, jsSettingKind } from "./context.js";
import { candidateKind, collectionName, inCostContext, inDataCollection, inDataTable, inExampleOrTokenizer, inRecordedResponse } from "./shapes.js";
import { lineOf, named, nodesOfType, snippetOf, type Node, type Tree } from "./parser.js";

/** Clients exported from a module: absolute path without extension → exported name → provider id. */
export type ExportedClients = Map<string, Map<string, string>>;

interface FileCtx {
  file: string;
  abs: string;
  lang: "ts" | "js";
  source: string;
  tree: Tree;
  /** identifier → provider id, for names bound to the SDK module or its client classes */
  sdkNames: Map<string, { provider: string; kind: "module" | "class" }>;
  /** "name" or "this.name" → provider id, for names holding a constructed client */
  clients: Map<string, string>;
  /** client name → relay host, for clients pointed at a non-provider server */
  clientProxies: Map<string, string>;
  /** client name → cloud host, for clients built from AzureOpenAI / AnthropicBedrock / AnthropicVertex */
  clientHosts: Map<string, "azure" | "bedrock" | "vertex">;
  /** function name → provider id, for helpers that return a new client (createClient()) */
  factories: Map<string, string>;
  /** imported class name → original exported name (to tell AzureOpenAI from OpenAI) */
  classNames: Map<string, string>;
  /** identifier → string value, for simple string constants */
  consts: Map<string, string>;
  /** identifier → base URL, for axios.create / got.extend instances */
  httpInstances: Map<string, string>;
  /** start offsets of string nodes already used by a call, so model-ref doesn't double count */
  consumed: Set<number>;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "request"];

export function stripExt(p: string): string {
  return p.replace(/\.(d\.)?(m|c)?(t|j)sx?$/, "");
}

/** Pass 1: find clients this file exports, so other files that import them are tracked too. */
export function collectExports(file: string, abs: string, lang: "ts" | "js", source: string, tree: Tree, exported: ExportedClients): void {
  const ctx = makeCtx(file, abs, lang, source, tree, exported);
  const names = new Map<string, string>();
  for (const exp of nodesOfType(tree.rootNode, "export_statement")) {
    for (const decl of nodesOfType(exp, "variable_declarator")) {
      const n = decl.childForFieldName("name");
      if (n && ctx.clients.has(n.text)) names.set(n.text, ctx.clients.get(n.text)!);
    }
    // export default client;  /  export { client }
    const value = exp.childForFieldName("value") ?? exp.childForFieldName("declaration");
    if (value?.type === "identifier" && ctx.clients.has(value.text)) names.set("default", ctx.clients.get(value.text)!);
    for (const spec of nodesOfType(exp, "export_specifier")) {
      const n = spec.childForFieldName("name");
      const alias = spec.childForFieldName("alias");
      if (n && ctx.clients.has(n.text)) names.set(alias?.text ?? n.text, ctx.clients.get(n.text)!);
    }
  }
  // module.exports = client / exports.client = client
  for (const a of nodesOfType(tree.rootNode, "assignment_expression")) {
    const left = a.childForFieldName("left");
    const right = a.childForFieldName("right");
    if (!left || !right || !ctx.clients.has(right.text)) continue;
    if (left.text === "module.exports") names.set("default", ctx.clients.get(right.text)!);
    else if (left.text.startsWith("exports.") || left.text.startsWith("module.exports.")) names.set(left.text.split(".").pop()!, ctx.clients.get(right.text)!);
  }
  if (names.size) exported.set(stripExt(abs), names);
}

/** Pass 2: find every API usage in the file. */
export function analyzeJs(file: string, abs: string, lang: "ts" | "js", source: string, tree: Tree, exported: ExportedClients): Usage[] {
  const ctx = makeCtx(file, abs, lang, source, tree, exported);
  const usages: Usage[] = [];
  const hasSdk = ctx.sdkNames.size > 0 || ctx.clients.size > 0;

  for (const call of nodesOfType(tree.rootNode, "call_expression")) {
    const fn = call.childForFieldName("function");
    if (!fn) continue;
    const sdk = hasSdk ? sdkCall(ctx, call, fn) : undefined;
    if (sdk) {
      usages.push(sdk);
      continue;
    }
    const http = httpCall(ctx, call, fn);
    if (http) usages.push(http);
  }

  usages.push(...modelIdObjects(ctx));
  usages.push(...versionPins(ctx));
  usages.push(...modelRefs(ctx));
  return usages;
}

/** AWS SDK v3 bedrock-runtime commands → Bedrock REST operation */
const BEDROCK_COMMANDS: Record<string, string> = {
  ConverseCommand: "POST /model/{modelId}/converse",
  ConverseStreamCommand: "POST /model/{modelId}/converse-stream",
  InvokeModelCommand: "POST /model/{modelId}/invoke",
  InvokeModelWithResponseStreamCommand: "POST /model/{modelId}/invoke-with-response-stream",
};

/**
 * Model IDs passed through a cloud SDK or framework: new ConverseCommand({ modelId }),
 * new ChatBedrockConverse({ model_id }), bedrock({ modelId }), etc.
 */
function modelIdObjects(ctx: FileCtx): Usage[] {
  const out: Usage[] = [];
  for (const obj of nodesOfType(ctx.tree.rootNode, "object")) {
    const valueNode = objectProp(obj, ["modelId", "model_id"]);
    if (!valueNode) continue;
    const model = resolveString(ctx, valueNode);
    const p = model ? modelProvider(model) : undefined;
    if (!model || !p) continue;
    resolveString(ctx, valueNode, true);
    // The call or `new` this object is an argument of
    const args = obj.parent;
    const owner = args?.type === "arguments" ? args.parent : undefined;
    const ctor = owner?.childForFieldName(owner.type === "new_expression" ? "constructor" : "function")?.text ?? "";
    const cls = ctor.split(".").pop() ?? "";
    const op = BEDROCK_COMMANDS[cls];
    const info = readBody(ctx, obj);
    out.push({
      provider: p.id, kind: "sdk", lang: ctx.lang, file: ctx.file, line: lineOf(owner ?? obj),
      op, sdkCall: cls || undefined, model, params: info.params,
      // A Bedrock runtime command or a Bedrock class runs the model on Bedrock
      ...(op || hostOfClass(cls) === "bedrock" ? { host: "bedrock" as const } : {}),
      paramSpans: spansOf(info).paramSpans, modelSpan: literalSpan(ctx, valueNode),
      confidence: op ? "certain" : "likely", snippet: snippetOf(ctx.source, owner ?? obj),
    });
  }
  return out;
}

function makeCtx(file: string, abs: string, lang: "ts" | "js", source: string, tree: Tree, exported: ExportedClients): FileCtx {
  const ctx: FileCtx = {
    file, abs, lang, source, tree,
    sdkNames: new Map(), clients: new Map(), clientProxies: new Map(), clientHosts: new Map(), factories: new Map(), classNames: new Map(),
    consts: new Map(), httpInstances: new Map(), consumed: new Set(),
  };
  collectConsts(ctx);
  collectImports(ctx, exported);
  collectClients(ctx);
  collectHttpInstances(ctx);
  return ctx;
}

// ---------- bindings ----------

function packageProvider(spec: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => (p.packages.ts ?? []).some((name) => spec === name || spec.startsWith(name + "/")));
}

function collectImports(ctx: FileCtx, exported: ExportedClients): void {
  const root = ctx.tree.rootNode;
  for (const imp of nodesOfType(root, "import_statement")) {
    const src = imp.childForFieldName("source");
    if (!src) continue;
    const spec = unquote(src.text);
    const clause = named(imp).find((n) => n.type === "import_clause");
    const p = packageProvider(spec);
    if (p && clause) {
      for (const part of named(clause)) {
        if (part.type === "identifier") ctx.sdkNames.set(part.text, { provider: p.id, kind: "class" });
        else if (part.type === "namespace_import") {
          const id = named(part).find((n) => n.type === "identifier");
          if (id) ctx.sdkNames.set(id.text, { provider: p.id, kind: "module" });
        } else if (part.type === "named_imports") {
          for (const s of named(part).filter((n) => n.type === "import_specifier")) {
            const name = s.childForFieldName("name")?.text;
            const alias = s.childForFieldName("alias")?.text ?? name;
            if (name && alias && p.clientClasses.includes(name)) {
              ctx.sdkNames.set(alias, { provider: p.id, kind: "class" });
              ctx.classNames.set(alias, name);
            }
          }
        }
      }
    } else if (clause && spec.startsWith(".")) {
      importExportedClients(ctx, spec, clause, exported);
    }
  }
  // const OpenAI = require("openai")  /  const { OpenAI } = require("openai")  /  const client = require("./client")
  for (const decl of nodesOfType(root, "variable_declarator")) {
    const value = unwrap(decl.childForFieldName("value"));
    const nameNode = decl.childForFieldName("name");
    if (!value || !nameNode || value.type !== "call_expression") continue;
    if (value.childForFieldName("function")?.text !== "require") continue;
    const arg = named(value.childForFieldName("arguments") ?? value)[0];
    if (!arg || arg.type !== "string") continue;
    const spec = unquote(arg.text);
    const p = packageProvider(spec);
    if (p) {
      if (nameNode.type === "identifier") ctx.sdkNames.set(nameNode.text, { provider: p.id, kind: "class" });
      else if (nameNode.type === "object_pattern") {
        for (const prop of named(nameNode)) {
          const local = prop.type === "pair_pattern" ? prop.childForFieldName("value")?.text : prop.text;
          const orig = prop.type === "pair_pattern" ? prop.childForFieldName("key")?.text : prop.text;
          if (local && orig && p.clientClasses.includes(orig)) {
            ctx.sdkNames.set(local, { provider: p.id, kind: "class" });
            ctx.classNames.set(local, orig);
          }
        }
      }
    } else if (spec.startsWith(".")) {
      const target = exported.get(stripExt(resolve(dirname(ctx.abs), spec))) ?? exported.get(resolve(dirname(ctx.abs), spec, "index"));
      if (!target) continue;
      if (nameNode.type === "identifier" && target.has("default")) ctx.clients.set(nameNode.text, target.get("default")!);
      if (nameNode.type === "object_pattern") {
        for (const prop of named(nameNode)) {
          const orig = prop.type === "pair_pattern" ? prop.childForFieldName("key")?.text : prop.text;
          const local = prop.type === "pair_pattern" ? prop.childForFieldName("value")?.text : prop.text;
          if (orig && local && target.has(orig)) ctx.clients.set(local, target.get(orig)!);
        }
      }
    }
  }
}

function importExportedClients(ctx: FileCtx, spec: string, clause: Node, exported: ExportedClients): void {
  const base = resolve(dirname(ctx.abs), spec);
  const target = exported.get(stripExt(base)) ?? exported.get(resolve(base, "index"));
  if (!target) return;
  for (const part of named(clause)) {
    if (part.type === "identifier" && target.has("default")) ctx.clients.set(part.text, target.get("default")!);
    if (part.type === "named_imports") {
      for (const s of named(part).filter((n) => n.type === "import_specifier")) {
        const name = s.childForFieldName("name")?.text;
        const alias = s.childForFieldName("alias")?.text ?? name;
        if (name && alias && target.has(name)) ctx.clients.set(alias, target.get(name)!);
      }
    }
  }
}

/** Is this expression a constructed client? Returns the provider id. */
function clientFromExpr(ctx: FileCtx, expr: Node | null): string | undefined {
  const e = unwrap(expr);
  if (!e) return undefined;
  if (e.type === "new_expression" || e.type === "call_expression") {
    const ctor = e.childForFieldName(e.type === "new_expression" ? "constructor" : "function");
    if (!ctor) return undefined;
    if (ctor.type === "identifier") {
      const b = ctx.sdkNames.get(ctor.text);
      if (b) return b.provider;
      if (e.type === "call_expression" && ctx.factories.has(ctor.text)) return ctx.factories.get(ctor.text);
    }
    if (ctor.type === "member_expression") {
      // new openai.OpenAI() where openai is the module namespace
      const obj = ctor.childForFieldName("object");
      const prop = ctor.childForFieldName("property")?.text;
      const b = obj && ctx.sdkNames.get(obj.text);
      const p = b && providerById(b.provider);
      if (p && prop && p.clientClasses.includes(prop)) return p.id;
    }
  }
  if (e.type === "identifier" && ctx.clients.has(e.text)) return ctx.clients.get(e.text);
  return undefined;
}

function typeProvider(ctx: FileCtx, typeNode: Node | null): string | undefined {
  if (!typeNode) return undefined;
  for (const t of nodesOfType(typeNode, ["type_identifier", "identifier"])) {
    const b = ctx.sdkNames.get(t.text);
    if (b) return b.provider;
  }
  // openai.OpenAI style nested types
  const text = typeNode.text.replace(/^:\s*/, "");
  for (const [name, b] of ctx.sdkNames) if (text.startsWith(name + ".")) return b.provider;
  return undefined;
}

/** Which cloud host does this constructor expression point at, if any? */
function hostFromExpr(ctx: FileCtx, expr: Node | null): "azure" | "bedrock" | "vertex" | undefined {
  const e = unwrap(expr);
  if (!e) return undefined;
  if (e.type === "identifier") return ctx.clientHosts.get(e.text);
  if (e.type !== "new_expression" && e.type !== "call_expression") return undefined;
  const ctor = e.childForFieldName(e.type === "new_expression" ? "constructor" : "function");
  if (!ctor) return undefined;
  // new GoogleGenAI({ vertexai: true })
  const opts = named(e.childForFieldName("arguments") ?? e).find((a) => a.type === "object");
  if (opts && objectProp(opts, ["vertexai"])?.text === "true") return "vertex";
  if (ctor.type === "identifier") return hostOfClass(ctx.classNames.get(ctor.text) ?? ctor.text) ?? ctx.clientHosts.get(`fn:${ctor.text}`);
  return hostOfClass(ctor.childForFieldName("property")?.text ?? "");
}

function setClient(ctx: FileCtx, key: string, provider: string, expr: Node | null): void {
  ctx.clients.set(key, provider);
  const host = hostFromExpr(ctx, expr);
  if (host) ctx.clientHosts.set(key, host);
  const proxy = proxyFromExpr(ctx, provider, expr);
  if (proxy) ctx.clientProxies.set(key, proxy);
}

/** new OpenAI({ baseURL: "https://relay.example/v1" }): a server that isn't the provider's own */
function proxyFromExpr(ctx: FileCtx, provider: string, expr: Node | null): string | undefined {
  const e = unwrap(expr);
  if (!e || (e.type !== "new_expression" && e.type !== "call_expression")) return undefined;
  const opts = named(e.childForFieldName("arguments") ?? e).find((a) => a.type === "object");
  const url = opts && resolveString(ctx, objectProp(opts, ["baseURL", "baseUrl", "base_url", "endpoint"]) ?? null);
  const host = url ? /^https?:\/\/([^/]+)/.exec(url)?.[1] : undefined;
  const own = providerById(provider)?.hosts ?? [];
  return host && !own.some((h) => host.endsWith(h)) && !/localhost|127\.0\.0\.1/.test(host) ? host : undefined;
}

/** Helpers that build a client: function createClient() { return new Anthropic() } / const make = () => new OpenAI() */
function collectFactories(ctx: FileCtx): void {
  const root = ctx.tree.rootNode;
  const consider = (name: string | undefined, body: Node | null) => {
    if (!name || !body) return;
    const returned = body.type === "statement_block" ? nodesOfType(body, "return_statement").map((r) => named(r)[0] ?? null) : [body];
    for (const r of returned) {
      const p = clientFromExpr(ctx, r);
      if (p) {
        ctx.factories.set(name, p);
        const host = hostFromExpr(ctx, r);
        if (host) ctx.clientHosts.set(`fn:${name}`, host);
        return;
      }
    }
  };
  for (const f of nodesOfType(root, "function_declaration")) consider(f.childForFieldName("name")?.text, f.childForFieldName("body"));
  for (const d of nodesOfType(root, "variable_declarator")) {
    const v = unwrap(d.childForFieldName("value"));
    if (v && (v.type === "arrow_function" || v.type === "function_expression" || v.type === "function")) {
      consider(d.childForFieldName("name")?.text, v.childForFieldName("body"));
    }
  }
}

function collectClients(ctx: FileCtx): void {
  const root = ctx.tree.rootNode;
  collectFactories(ctx);
  // Repeat to follow simple aliases: const a = new OpenAI(); const b = a;
  for (let pass = 0; pass < 2; pass++) {
    for (const decl of nodesOfType(root, "variable_declarator")) {
      const n = decl.childForFieldName("name");
      if (n?.type !== "identifier") continue;
      const value = decl.childForFieldName("value");
      const p = clientFromExpr(ctx, value) ?? typeProvider(ctx, decl.childForFieldName("type"));
      if (p) setClient(ctx, n.text, p, value);
    }
    for (const a of nodesOfType(root, "assignment_expression")) {
      const left = a.childForFieldName("left");
      const right = a.childForFieldName("right");
      const p = clientFromExpr(ctx, right);
      if (left && p && (left.type === "identifier" || isThisMember(left))) setClient(ctx, left.text, p, right);
    }
    for (const f of nodesOfType(root, ["public_field_definition", "field_definition"])) {
      const n = f.childForFieldName("name") ?? f.childForFieldName("property");
      const value = f.childForFieldName("value");
      const p = clientFromExpr(ctx, value) ?? typeProvider(ctx, f.childForFieldName("type"));
      if (n && p) setClient(ctx, "this." + n.text, p, value);
    }
    // function f(client: OpenAI) / constructor(private client: Anthropic)
    for (const param of nodesOfType(root, ["required_parameter", "optional_parameter"])) {
      const pat = param.childForFieldName("pattern");
      const p = typeProvider(ctx, param.childForFieldName("type"));
      if (!pat || !p) continue;
      ctx.clients.set(pat.text, p);
      if (named(param).some((c) => c.type === "accessibility_modifier")) ctx.clients.set("this." + pat.text, p);
    }
  }
}

function isThisMember(n: Node): boolean {
  return n.type === "member_expression" && n.childForFieldName("object")?.type === "this";
}

function collectConsts(ctx: FileCtx): void {
  for (let pass = 0; pass < 2; pass++) {
    for (const decl of nodesOfType(ctx.tree.rootNode, "variable_declarator")) {
      const n = decl.childForFieldName("name");
      if (n?.type !== "identifier") continue;
      const v = resolveString(ctx, decl.childForFieldName("value"));
      if (v !== undefined && !v.includes("{?}")) ctx.consts.set(n.text, v);
    }
  }
}

function collectHttpInstances(ctx: FileCtx): void {
  for (const decl of nodesOfType(ctx.tree.rootNode, "variable_declarator")) {
    const n = decl.childForFieldName("name");
    const v = unwrap(decl.childForFieldName("value"));
    if (n?.type !== "identifier" || v?.type !== "call_expression") continue;
    const fn = v.childForFieldName("function")?.text;
    if (!fn || !/^(axios\.create|got\.extend|ky\.create|ky\.extend)$/.test(fn)) continue;
    const opts = named(v.childForFieldName("arguments") ?? v).find((a) => a.type === "object");
    const base = opts && objectProp(opts, ["baseURL", "prefixUrl", "prefix"]);
    const url = resolveString(ctx, base ?? null);
    if (url) ctx.httpInstances.set(n.text, url);
  }
}

// ---------- calls ----------

/** Flatten a.b.c(...) into root + path. Unwraps await, parens, non-null and casts. */
function memberChain(fn: Node): { root: Node; path: string[] } | undefined {
  const path: string[] = [];
  let cur: Node | null = unwrap(fn);
  while (cur && cur.type === "member_expression") {
    const prop = cur.childForFieldName("property");
    if (!prop) return undefined;
    const obj = unwrap(cur.childForFieldName("object"));
    if (obj?.type === "this") {
      return { root: cur, path: path.reverse() };
    }
    path.push(prop.text);
    cur = obj;
  }
  if (!cur || path.length === 0) return undefined;
  return { root: cur, path: path.reverse() };
}

function sdkCall(ctx: FileCtx, call: Node, fn: Node): Usage | undefined {
  const chain = memberChain(fn);
  if (!chain) return undefined;
  const rootKey = chain.root.text;
  let providerId = ctx.clients.get(rootKey);
  let confidence: Usage["confidence"] = "certain";
  const callPath = chain.path.join(".");
  if (!providerId) {
    // Fallback: the file imports an SDK and the call path is a known SDK operation on an unknown receiver
    // (e.g. a client passed in without a type). Only counts if the path matches exactly.
    const imported = new Set([...ctx.sdkNames.values()].map((b) => b.provider));
    for (const pid of imported) {
      const p = providerById(pid)!;
      if (Object.prototype.hasOwnProperty.call(p.sdkOps, callPath)) {
        providerId = pid;
        confidence = "likely";
        break;
      }
    }
  }
  if (!providerId) return undefined;
  const provider = providerById(providerId)!;
  const args = named(call.childForFieldName("arguments") ?? call);
  // Route-string clients: octokit.request("GET /repos/{owner}/{repo}", …), client.request("POST /v1/…")
  const route = /^(request|graphql|paginate)$/.test(callPath.split(".").pop() ?? "") && args[0] ? resolveString(ctx, args[0]) : undefined;
  const routeOp = route && /^(GET|POST|PUT|PATCH|DELETE|HEAD) \/\S*$/.test(route) ? normalizeRoute(route) : undefined;
  const op = routeOp ?? sdkOp(provider, callPath);
  if (!op) return undefined;
  const body = args.find((a) => a.type === "object");
  const info: BodyInfo = body ? readBody(ctx, body) : { params: [] };
  const { model, params } = info;
  return {
    provider: provider.id, kind: "sdk", lang: ctx.lang, file: ctx.file, line: lineOf(call),
    op, sdkCall: callPath, model, params, confidence, snippet: snippetOf(ctx.source, call), ...spansOf(info),
    host: ctx.clientHosts.get(rootKey) ?? (confidence === "likely" ? fileHost(ctx) : undefined),
    proxy: ctx.clientProxies.get(rootKey),
  };
}

/** If every SDK class this file imports targets the same cloud host (e.g. only AzureOpenAI), that host. */
function fileHost(ctx: FileCtx): "azure" | "bedrock" | "vertex" | undefined {
  const classes = [...ctx.sdkNames.entries()].filter(([, b]) => b.kind === "class").map(([local]) => ctx.classNames.get(local) ?? local);
  if (!classes.length) return undefined;
  const hosts = new Set(classes.map(hostOfClass));
  return hosts.size === 1 ? [...hosts][0] : undefined;
}

function httpCall(ctx: FileCtx, call: Node, fn: Node): Usage | undefined {
  const args = named(call.childForFieldName("arguments") ?? call);
  let method: string | undefined;
  let urlNode: Node | undefined;
  let optsNode: Node | undefined;
  let bodyNode: Node | undefined;
  let base = "";

  const fnText = unwrap(fn)?.text ?? "";
  if (fnText === "fetch" || fnText === "globalThis.fetch" || fnText === "window.fetch" || fnText === "undici.request" || fnText === "request") {
    urlNode = args[0];
    optsNode = args[1]?.type === "object" ? args[1] : undefined;
  } else if (fnText === "axios" || fnText === "got" || fnText === "ky") {
    if (args[0]?.type === "object") {
      optsNode = args[0];
      urlNode = objectProp(args[0], ["url"]);
    } else {
      urlNode = args[0];
      optsNode = args[1]?.type === "object" ? args[1] : undefined;
    }
  } else {
    const m = /^([\w$.]+)\.(\w+)$/.exec(fnText);
    if (!m || !HTTP_METHODS.includes(m[2].toLowerCase())) return undefined;
    const target = m[1];
    if (ctx.httpInstances.has(target)) base = ctx.httpInstances.get(target)!;
    else if (!/^(axios|got|ky|superagent|needle|undici)$/.test(target)) return undefined;
    method = m[2].toUpperCase();
    urlNode = args[0];
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      bodyNode = args[1];
      optsNode = args[2]?.type === "object" ? args[2] : undefined;
    } else {
      optsNode = args[1]?.type === "object" ? args[1] : undefined;
    }
  }

  let url = urlNode ? resolveString(ctx, urlNode) : undefined;
  if (url === undefined) return undefined;
  if (base && !/^https?:/.test(url)) url = joinUrl(base, url);
  const hit = matchUrl(url);
  if (!hit) return undefined;

  if (optsNode) {
    const m = objectProp(optsNode, ["method"]);
    const mv = m && resolveString(ctx, m);
    if (mv) method = mv.toUpperCase();
    bodyNode ??= objectProp(optsNode, ["body", "data", "json"]);
  }
  const bodyObj = bodyNode && findObject(bodyNode);
  const info: BodyInfo = bodyObj ? readBody(ctx, bodyObj) : { params: [] };
  const { model, params } = info;
  method ??= bodyNode ? "POST" : "GET";
  const confidence = url.includes("{?}") && !url.includes(hit.provider.hosts[0]) ? "possible" : "certain";
  return {
    provider: hit.provider.id, kind: "http", lang: ctx.lang, file: ctx.file, line: lineOf(call),
    op: `${method} ${normalizePath(hit.path)}`, model, params, confidence, snippet: snippetOf(ctx.source, call), ...spansOf(info),
    host: url.includes("aiplatform.googleapis.com") ? "vertex" : undefined,
    apiVersion: urlVersionOf(hit.provider, url) ? `url: ${urlVersionOf(hit.provider, url)}` : undefined,
  };
}

function versionPins(ctx: FileCtx): Usage[] {
  const out: Usage[] = [];
  for (const pair of nodesOfType(ctx.tree.rootNode, "pair")) {
    const key = unquote(pair.childForFieldName("key")?.text ?? "").toLowerCase();
    for (const p of PROVIDERS) {
      if (!p.versionHeaders.includes(key)) continue;
      const v = resolveString(ctx, pair.childForFieldName("value"));
      if (!v) continue;
      out.push({
        provider: p.id, kind: "version-pin", lang: ctx.lang, file: ctx.file, line: lineOf(pair),
        apiVersion: `${key}: ${v}`, confidence: "certain", snippet: snippetOf(ctx.source, pair),
      });
    }
    // new Stripe(key, { apiVersion: "2024-06-20" }), shopifyApi({ apiVersion: ApiVersion.July25 }):
    // only when the object goes straight into that provider's own client, so Azure's apiVersion etc. don't count
    const obj = pair.parent;
    const owner = obj?.parent?.type === "arguments" ? obj.parent.parent : undefined;
    const ctor = owner?.childForFieldName(owner.type === "new_expression" ? "constructor" : "function");
    const binding = ctor ? ctx.sdkNames.get(ctor.text.split(".")[0]) : undefined;
    const p = binding && providerById(binding.provider);
    const rawKey = unquote(pair.childForFieldName("key")?.text ?? "");
    if (p?.versionKeys?.includes(rawKey)) {
      const vNode = pair.childForFieldName("value");
      const v = resolveString(ctx, vNode) ?? (vNode && p.versionConst?.(vNode.text));
      if (v) out.push({
        provider: p.id, kind: "version-pin", lang: ctx.lang, file: ctx.file, line: lineOf(pair),
        apiVersion: `${rawKey}: ${v}`, confidence: "certain", snippet: snippetOf(ctx.source, pair),
      });
    }
  }
  return out;
}

function modelRefs(ctx: FileCtx): Usage[] {
  const out: Usage[] = [];
  const routed = mentionsRouter(ctx.source);
  for (const s of nodesOfType(ctx.tree.rootNode, ["string", "template_string"])) {
    if (ctx.consumed.has(s.startIndex)) continue;
    const v = unquote(s.text);
    const ref = modelRef(v, routed);
    if (!ref) continue;
    // Only model settings count: DEFAULT_MODEL = "…", { model: "…" }, MODELS = [...], anthropic("…")
    // A cloud-form ID (Vertex "@", Bedrock "anthropic.") counts anywhere except as a lookup-table key (prices, sizes)
    // A model in a recorded or mocked API response is output, and one in pricing or cost code is an estimate input
    // Recorded output and price/cost tables are still reported, in their own roles (founder, 19 Nov: replacement
    // in all files): recorded is info and never edited, a price table is a catalog entry the fix never renames
    if (inExampleOrTokenizer(s)) continue;
    const recordedOut = inRecordedResponse(s);
    if (recordedOut || inCostContext(s)) {
      out.push({
        ...(recordedOut ? { recorded: true, reason: "recorded response" } : { listed: true, reason: "price or cost table" }), weak: true,
        provider: ref.provider.id, kind: "model-ref", lang: ctx.lang, file: ctx.file, line: lineOf(s),
        model: ref.model, confidence: "possible", snippet: snippetOf(ctx.source, s), host: ref.host ?? fileHost(ctx),
      });
      continue;
    }
    const ownKind = jsSettingKind(s);
    // A model-named list inside a table of capabilities or prices (models: [...] in a compatibility matrix) is data
    const strict = (ownKind === "listed" && inDataTable(s) ? undefined : ownKind) ?? (alwaysCounts(ref.model) && !isPairKey(s, ["parenthesized_expression"]) && !inDataCollection(s) ? (inModelCollection(s, (k) => !!modelRef(k)) ? "listed" : "setting") : undefined);
    // Otherwise a model enum, list, per-provider map or model-shaped call counts if the repo uses the provider
    const kind = strict ?? candidateKind(s, ["string", "template_string"], (t) => !!modelRef(t, routed));
    if (!kind) continue;
    const editable = !ref.prefixed && (s.type === "string" || !named(s).some((c) => c.type === "template_substitution"));
    out.push({
      ...(kind === "listed" ? { listed: true, owner: collectionName(s) } : {}),
      ...(kind === "setting" ? { setting: true } : {}),
      ...(strict ? {} : { weak: true }),
      provider: ref.provider.id, kind: "model-ref", lang: ctx.lang, file: ctx.file, line: lineOf(s),
      model: ref.model, confidence: "possible", snippet: snippetOf(ctx.source, s), host: ref.host ?? fileHost(ctx),
      modelSpan: editable ? { start: s.startIndex, end: s.endIndex, kind: "string" } : undefined,
    });
  }
  return out;
}

// ---------- values ----------

interface BodyInfo {
  model?: string;
  params: string[];
  modelSpan?: ModelSpan;
  paramSpans?: Record<string, Span>;
}

function readBody(ctx: FileCtx, obj: Node): BodyInfo {
  const params: string[] = [];
  const paramSpans: Record<string, Span> = {};
  let model: string | undefined;
  let modelSpan: ModelSpan | undefined;
  for (const child of named(obj)) {
    if (child.type === "pair") {
      const k = unquote(child.childForFieldName("key")?.text ?? "");
      params.push(k);
      paramSpans[k] = { start: child.startIndex, end: child.endIndex };
      if (k === "model") {
        const vNode = child.childForFieldName("value");
        model = resolveString(ctx, vNode, true);
        modelSpan = literalSpan(ctx, vNode);
      }
    } else if (child.type === "shorthand_property_identifier") {
      params.push(child.text);
      paramSpans[child.text] = { start: child.startIndex, end: child.endIndex };
      if (child.text === "model") {
        model = ctx.consts.get("model");
        modelSpan = literalSpan(ctx, child);
      }
    }
  }
  return { model, params, modelSpan, paramSpans };
}

/**
 * Where the text of a string value is written, following simple constants in the same file:
 * "claude-x" → that literal; MODEL → the literal in `const MODEL = "claude-x"`; env || "claude-x" → the fallback.
 * Only plain literals (no ${} substitutions) can be edited safely.
 */
function literalSpan(ctx: FileCtx, node: Node | null | undefined): ModelSpan | undefined {
  const n = unwrap(node ?? null);
  if (!n) return undefined;
  if (n.type === "string" || (n.type === "template_string" && !named(n).some((c) => c.type === "template_substitution"))) {
    return { start: n.startIndex, end: n.endIndex, kind: "string" };
  }
  if (n.type === "binary_expression" && ["||", "??"].includes(n.childForFieldName("operator")?.text ?? "")) {
    return literalSpan(ctx, n.childForFieldName("right"));
  }
  if (n.type === "identifier" || n.type === "shorthand_property_identifier") {
    for (const decl of nodesOfType(ctx.tree.rootNode, "variable_declarator")) {
      if (decl.childForFieldName("name")?.text === n.text) return literalSpan(ctx, decl.childForFieldName("value"));
    }
  }
  return undefined;
}

function spansOf(b: BodyInfo): Pick<Usage, "modelSpan" | "paramSpans"> {
  return { modelSpan: b.modelSpan, paramSpans: b.paramSpans && Object.keys(b.paramSpans).length ? b.paramSpans : undefined };
}

/** Best-effort string value of an expression. Unknown parts become "{?}". */
export function resolveString(ctx: FileCtx, node: Node | null | undefined, markConsumed = false): string | undefined {
  const n = unwrap(node ?? null);
  if (!n) return undefined;
  switch (n.type) {
    case "string":
      if (markConsumed) ctx.consumed.add(n.startIndex);
      return unquote(n.text);
    case "template_string": {
      if (markConsumed) ctx.consumed.add(n.startIndex);
      let out = "";
      for (const c of n.children) {
        if (!c) continue;
        if (c.type === "string_fragment" || c.type === "escape_sequence") out += c.text;
        else if (c.type === "template_substitution") {
          const inner = named(c)[0];
          out += resolveString(ctx, inner) ?? "{?}";
        }
      }
      return out;
    }
    case "identifier":
      if (ctx.consts.has(n.text)) {
        markConstConsumed(ctx, n.text, markConsumed);
        return ctx.consts.get(n.text);
      }
      return undefined;
    case "binary_expression": {
      const op = n.childForFieldName("operator")?.text;
      const l = resolveString(ctx, n.childForFieldName("left"), markConsumed);
      const r = resolveString(ctx, n.childForFieldName("right"), markConsumed);
      if (op === "+") return (l ?? "{?}") + (r ?? "{?}");
      if (op === "||" || op === "??") return l ?? r;
      return undefined;
    }
    case "member_expression": {
      // process.env.X
      if (n.text.startsWith("process.env.")) return undefined;
      return undefined;
    }
    default:
      return undefined;
  }
}

function markConstConsumed(ctx: FileCtx, name: string, mark: boolean): void {
  if (!mark) return;
  for (const decl of nodesOfType(ctx.tree.rootNode, "variable_declarator")) {
    if (decl.childForFieldName("name")?.text !== name) continue;
    const v = unwrap(decl.childForFieldName("value"));
    if (v) for (const s of nodesOfType(v, ["string", "template_string"])) ctx.consumed.add(s.startIndex);
    if (v && (v.type === "string" || v.type === "template_string")) ctx.consumed.add(v.startIndex);
  }
}

function objectProp(obj: Node, keys: string[]): Node | undefined {
  for (const c of named(obj)) {
    if (c.type === "pair") {
      const k = unquote(c.childForFieldName("key")?.text ?? "");
      if (keys.includes(k)) return c.childForFieldName("value") ?? undefined;
    }
  }
  return undefined;
}

/** body: JSON.stringify({...}) or a literal object */
function findObject(n: Node): Node | undefined {
  const u = unwrap(n);
  if (!u) return undefined;
  if (u.type === "object") return u;
  if (u.type === "call_expression" && u.childForFieldName("function")?.text === "JSON.stringify") {
    return named(u.childForFieldName("arguments") ?? u).find((a) => a.type === "object");
  }
  return undefined;
}

function unwrap(n: Node | null | undefined): Node | null {
  let cur = n ?? null;
  while (cur && ["await_expression", "parenthesized_expression", "non_null_expression", "as_expression", "satisfies_expression", "type_assertion"].includes(cur.type)) {
    cur = named(cur)[0] ?? null;
  }
  return cur;
}

function unquote(s: string): string {
  return s.replace(/^[`'"]|[`'"]$/g, "");
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

/** "GET /repos/{owner}/{repo}?per_page=5" → "GET /repos/{owner}/{repo}" */
function normalizeRoute(route: string): string {
  const [method, path] = route.split(" ");
  return `${method} ${normalizePath(path.split("?")[0])}`;
}

/** /v1/models/{?} → /v1/models/{id} so it lines up with spec paths */
export function normalizePath(path: string): string {
  return path.replace(/\{\?\}/g, "{id}").replace(/\/+$/, "") || "/";
}
