import { dirname, resolve } from "node:path";
import { PROVIDERS, looksLikeSdkPath, hostOfClass, matchUrl, mentionsRouter, modelProvider, modelRef, providerById, sdkOp, urlVersionOf, type ProviderDef } from "../providers.js";
import type { ModelSpan, Span, Usage } from "../types.js";
import { alwaysCounts, inModelCollection, isPairKey, jsSettingKind } from "./context.js";
import { candidateKind, collectionName, inCostContext, inDataCollection, inDataTable, inExampleOrTokenizer, inRecordedResponse } from "./shapes.js";
import { lineOf, named, nodesOfType, snippetOf, type Node, type Tree } from "./parser.js";

/** Clients exported from a module: absolute path without extension → exported name → provider id. */
export type ExportedClients = Map<string, Map<string, string>>;

interface FileCtx {
  /** v8: usages found by data flow (params written away from the call), added after the pass */
  flowUsages: Usage[];
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
  // a factory the module exports (export function getOpenAI() { return new OpenAI() }): its callers elsewhere hold a
  // client of that provider too, as fn:<name>
  for (const exp of nodesOfType(tree.rootNode, "export_statement")) {
    const decl = exp.childForFieldName("declaration");
    const own = decl?.type === "function_declaration" ? [decl.childForFieldName("name")?.text] : decl ? nodesOfType(decl, "variable_declarator").map((d) => d.childForFieldName("name")?.text) : [];
    for (const n of own) if (n && ctx.factories.has(n)) names.set(`fn:${n}`, ctx.factories.get(n)!);
    const value = exp.childForFieldName("value");
    if (value?.type === "identifier" && ctx.factories.has(value.text)) names.set("fn:default", ctx.factories.get(value.text)!);
    if (/^export\s+default\s+function\s+(\w+)/.test(exp.text)) {
      const n = /^export\s+default\s+function\s+(\w+)/.exec(exp.text)![1];
      if (ctx.factories.has(n)) names.set("fn:default", ctx.factories.get(n)!);
    }
    for (const spec of nodesOfType(exp, "export_specifier")) {
      const n = spec.childForFieldName("name")?.text;
      const alias = spec.childForFieldName("alias")?.text ?? n;
      if (n && alias && ctx.factories.has(n)) names.set(`fn:${alias}`, ctx.factories.get(n)!);
    }
  }
  if (names.size) exported.set(stripExt(abs), names);
}

/** Pass 2: find every API usage in the file. */
export function analyzeJs(file: string, abs: string, lang: "ts" | "js", source: string, tree: Tree, exported: ExportedClients): Usage[] {
  const ctx = makeCtx(file, abs, lang, source, tree, exported);
  const usages: Usage[] = [];
  // v8: or a receiver named after a provider whose ops follow a naming rule (`stripe.paymentIntents.create` on a client
  // another module exports)
  const hasSdk = ctx.sdkNames.size > 0 || ctx.clients.size > 0 || PROVIDERS.some((p) => (p.opFor || Object.keys(p.sdkOps).length) && new RegExp(`\\b_*${p.id}(Client)?\\.\\w+\\.\\w+`, "i").test(source));

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
  usages.push(...ctx.flowUsages);
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
    flowUsages: [],
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
          if (orig && local && target.has(`fn:${orig}`)) ctx.factories.set(local, target.get(`fn:${orig}`)!);
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
    if (part.type === "identifier" && target.has("fn:default")) ctx.factories.set(part.text, target.get("fn:default")!);
    if (part.type === "named_imports") {
      for (const s of named(part).filter((n) => n.type === "import_specifier")) {
        const name = s.childForFieldName("name")?.text;
        const alias = s.childForFieldName("alias")?.text ?? name;
        if (name && alias && target.has(name)) ctx.clients.set(alias, target.get(name)!);
        if (name && alias && target.has(`fn:${name}`)) ctx.factories.set(alias, target.get(`fn:${name}`)!);
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
  //
  return host && !own.some((h) => host.endsWith(h)) ? host : undefined;
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
    // v8: providers whose ops come from a naming rule (Stripe's resources), on a receiver named after the provider
    // (`stripe.paymentIntents.create`, `this._stripe.…`, a client exported by another module)
    if (!providerId && chain.path.length >= 2) {
      const rootName = rootKey.split(".").pop()!.replace(/^_+/, "").toLowerCase();
      for (const p of PROVIDERS) {
        // A naming rule accepts any a.b.c(), so the receiver itself must name the provider
        if (!p.opFor || !(rootName === p.id || rootName === `${p.id}client`) || !looksLikeSdkPath(callPath)) continue;
        if (sdkOp(p, callPath)) {
          providerId = p.id;
          confidence = "likely";
          break;
        }
      }
    }
    // v12: providers with an op table (OpenAI's beta.threads.runs.stream …): an imported SDK or a receiver named after
    // the provider (`openai.beta…` from another module), matched by the table's prefixes
    if (!providerId && chain.path.length >= 2) {
      const rootName = rootKey.split(".").pop()!.replace(/^_+/, "").toLowerCase();
      for (const p of PROVIDERS) {
        if (p.opFor || !Object.keys(p.sdkOps).length) continue;
        if (!(imported.has(p.id) || rootName === p.id || rootName === `${p.id}client`)) continue;
        if (Object.keys(p.sdkOps).some((k) => callPath === k || callPath.startsWith(k + ".")) && sdkOp(p, callPath)) {
          providerId = p.id;
          confidence = "likely";
          break;
        }
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
  // v7: create(params) where `const params = { … }` earlier in the same function: the object's keys are the call's
  const first = args[0]?.type === "object" ? args[0] : args[0]?.type === "identifier" ? objectBoundTo(args[0], call) : undefined;
  const body = first ?? args.find((a) => a.type === "object");
  const info: BodyInfo = body ? readBody(ctx, body) : { params: [] };
  // v11: keys set on the request after it's built (params.k = …, params['k'] = …), before the call
  if (args[0]?.type === "identifier") {
    for (const [k, span] of keysAssignedTo(ctx, args[0], call)) {
      if (info.params.includes(k)) continue;
      info.params.push(k);
      info.paramSpans = { ...(info.paramSpans ?? {}), [k]: span };
    }
  }
  const { model, params } = info;
  // v8: objects that reach the call through other functions in this file (a builder's return value, a wrapper's
  // parameter): each is reported where it's written, so a fix edits the object
  if (!body && args[0]) {
    for (const o of objectsReaching(args[0], call, FLOW_DEPTH)) {
      const more = readBody(ctx, o);
      // One usage per key, on the key's own line: a finding points at what a fix changes
      for (const k of more.params) {
        const span = more.paramSpans?.[k];
        const line = span ? ctx.source.slice(0, span.start).split("\n").length : lineOf(o);
        // One object shared by several calls of the same operation: one usage per key
        if (ctx.flowUsages.some((x) => x.line === line && x.op === op && x.params?.[0] === k)) continue;
        ctx.flowUsages.push({
          provider: provider.id, kind: "sdk", lang: ctx.lang, file: ctx.file, line, op, sdkCall: callPath, params: [k],
          confidence: "possible", snippet: (ctx.source.split("\n")[line - 1] ?? "").trim().slice(0, 200), reason: "params built elsewhere and passed to this call",
          ...(span ? { paramSpans: { [k]: span } } : {}),
        });
      }
    }
  }
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
    // Recorded output and price/cost tables are still reported, in their own roles (replacement
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
    //
    const kind = strict ?? candidateKind(s, ["string", "template_string"], (t) => !!modelRef(t, routed)) ?? "catalog";
    const editable = !ref.prefixed && (s.type === "string" || !named(s).some((c) => c.type === "template_substitution"));
    out.push({
      ...(kind === "listed" ? { listed: true, owner: collectionName(s) } : {}),
      ...(kind === "catalog" ? { listed: true, context: "catalog" as const, contextReason: "a model id outside a request or setting (a list, table or text)" } : {}),
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
    } else if (child.type === "spread_element") {
      // v12: ...spreadIfDefined('temperature', t), ...maybe("top_p", p): a helper that adds the key it's given
      const sc = unwrap(named(child)[0]);
      const k0 = sc?.type === "call_expression" ? named(sc.childForFieldName("arguments") ?? sc)[0] : undefined;
      if (k0?.type === "string" && /^[A-Za-z_]\w*$/.test(unquote(k0.text)) && !params.includes(unquote(k0.text))) {
        params.push(unquote(k0.text));
        paramSpans[unquote(k0.text)] = { start: child.startIndex, end: child.endIndex };
      }
      // { ...base }: base's own keys, when it's an object written earlier in the same function (v7); and
      // { ...(cond ? { k: v } : {}) }, { ...(cond && { k: v }) }: the keys either branch adds (v9)
      for (const inner of spreadObjects(named(child)[0], obj)) {
        if (inner.id === obj.id) continue;
        const more = readBody(ctx, inner);
        for (const k of more.params) if (!params.includes(k)) (params.push(k), more.paramSpans?.[k] && (paramSpans[k] = more.paramSpans[k]));
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

/**
 * v7, light data flow: the object literal a name is bound to (`const params = { … }`, `let opts = { … }`) in the same
 * function, before `at`. Only plain declarations: a name reassigned or built up elsewhere isn't followed.
 */
function objectBoundTo(id: Node, at: Node): Node | undefined {
  let scope: Node | null = at.parent;
  while (scope && !["statement_block", "program"].includes(scope.type)) scope = scope.parent;
  for (let block: Node | null = scope; block; block = block.parent) {
    if (!["statement_block", "program"].includes(block.type)) continue;
    let found: Node | undefined;
    for (const d of block.descendantsOfType("variable_declarator")) {
      if (!d || d.startIndex >= at.startIndex) continue;
      if (d.childForFieldName("name")?.text !== id.text) continue;
      const v = d.childForFieldName("value");
      if (v?.type === "object") found = v;
    }
    if (found) return found;
    if (block.type === "program") break;
  }
  return undefined;
}

const FLOW_DEPTH = 4;
const FUNCTION_TYPES = ["function_declaration", "method_definition", "arrow_function", "function_expression", "function"];

/** The function a node is in, and its name (a method's, a declaration's, or the variable an arrow is assigned to) */
function enclosingFunction(n: Node): { fn: Node; name?: string } | undefined {
  for (let p: Node | null = n.parent; p; p = p.parent) {
    if (!FUNCTION_TYPES.includes(p.type)) continue;
    const own = p.childForFieldName("name")?.text;
    const decl = p.parent?.type === "variable_declarator" ? p.parent.childForFieldName("name")?.text : undefined;
    const pair = p.parent?.type === "pair" ? p.parent.childForFieldName("key")?.text : undefined;
    return { fn: p, name: own ?? decl ?? pair };
  }
  return undefined;
}

/** Position of `name` among a function's parameters, or -1 */
function paramIndex(fn: Node, name: string): number {
  const params = fn.childForFieldName("parameters");
  if (!params) return fn.childForFieldName("parameter")?.text === name ? 0 : -1;
  const list = named(params);
  return list.findIndex((p) => {
    const id = p.type === "identifier" ? p : (p.childForFieldName("pattern") ?? p.childForFieldName("left") ?? p);
    return id?.text === name;
  });
}

/** Functions and methods in the file with this name */
function functionsNamed(root: Node, name: string): Node[] {
  const out: Node[] = [];
  for (const t of FUNCTION_TYPES) {
    for (const f of root.descendantsOfType(t)) {
      if (!f) continue;
      const n = f.childForFieldName("name")?.text ?? (f.parent?.type === "variable_declarator" ? f.parent.childForFieldName("name")?.text : undefined);
      if (n === name) out.push(f);
    }
  }
  return out;
}

const calleeName = (call: Node) => (call.childForFieldName("function")?.text ?? "").split(/[.?]+/).pop() ?? "";

/**
 * v8, bounded data flow within a file: the object literals that can reach `n` (a call's argument). Follows a name to
 * its object or to the call it holds, a call to what its function returns, a parameter back to the function's callers,
 * and a helper call through its arguments (sessionCreateParams(params, parts)). Depth-limited, at most 10 objects.
 */
function objectsReaching(n: Node, at: Node, depth: number, seen = new Set<number>()): Node[] {
  const node = unwrap(n);
  if (!node || seen.has(node.id) || seen.size > 40) return [];
  seen.add(node.id);
  if (node.type === "object") return [node];
  const root = (() => { let r: Node = node; while (r.parent) r = r.parent; return r; })();
  const out: Node[] = [];
  if (node.type === "identifier") {
    const bound = objectBoundTo(node, at);
    if (bound) out.push(bound);
    // const opts = this.build(…): what build returns
    for (const d of root.descendantsOfType("variable_declarator")) {
      if (!d || d.startIndex >= at.startIndex || d.childForFieldName("name")?.text !== node.text) continue;
      const v = unwrap(d.childForFieldName("value"));
      if (v?.type === "call_expression" && depth > 0) out.push(...objectsReaching(v, d, depth - 1, seen));
    }
    // A parameter: what the function's callers in this file pass in that position
    // (through callbacks: the nearest enclosing function that declares the name)
    let f = enclosingFunction(at);
    while (f && paramIndex(f.fn, node.text) < 0) f = enclosingFunction(f.fn);
    const i = f ? paramIndex(f.fn, node.text) : -1;
    if (f?.name && i >= 0 && depth > 0) {
      for (const c of root.descendantsOfType("call_expression")) {
        if (!c || calleeName(c) !== f.name) continue;
        const a = named(c.childForFieldName("arguments") ?? c)[i];
        if (a) out.push(...objectsReaching(a, c, depth - 1, seen));
      }
    }
  } else if (node.type === "call_expression" && depth > 0) {
    const fns = functionsNamed(root, calleeName(node));
    for (const fn of fns) {
      const body = fn.childForFieldName("body");
      if (body?.type === "object") out.push(body);
      for (const r of body ? body.descendantsOfType("return_statement") : []) {
        const e = r && named(r)[0];
        if (e) out.push(...objectsReaching(e, r, depth - 1, seen));
      }
    }
    // A helper: its arguments are what it builds from (sessionCreateParams(params, parts))
    for (const a of named(node.childForFieldName("arguments") ?? node)) out.push(...objectsReaching(a, node, depth - 1, seen));
  }
  return [...new Map(out.map((o) => [o.id, o])).values()].slice(0, 10);
}

/** v9: the objects a spread can add: a name bound to one, or the branches of a condition (a ? {…} : {}, a && {…}) */
function spreadObjects(n: Node | undefined, at: Node, depth = 3): Node[] {
  const node = n ? unwrap(n) : undefined;
  if (!node || depth < 0) return [];
  if (node.type === "object") return [node];
  if (node.type === "identifier") {
    const o = objectBoundTo(node, at);
    return o ? [o] : [];
  }
  if (node.type === "ternary_expression") return [...spreadObjects(node.childForFieldName("consequence") ?? undefined, at, depth - 1), ...spreadObjects(node.childForFieldName("alternative") ?? undefined, at, depth - 1)];
  if (node.type === "binary_expression" && /^(&&|\|\||\?\?)$/.test(node.childForFieldName("operator")?.text ?? "")) return [...spreadObjects(node.childForFieldName("left") ?? undefined, at, depth - 1), ...spreadObjects(node.childForFieldName("right") ?? undefined, at, depth - 1)];
  return [];
}

/** v11: keys a name gets by assignment before `at`, in the enclosing function: `p.k = …`, `p['k'] = …`, Object.assign(p, {…}) */
function keysAssignedTo(ctx: FileCtx, id: Node, at: Node): [string, Span][] {
  let scope: Node | null = at.parent;
  while (scope && !["statement_block", "program"].includes(scope.type)) scope = scope.parent;
  if (!scope) return [];
  const out: [string, Span][] = [];
  for (const a of scope.descendantsOfType("assignment_expression")) {
    if (!a || a.startIndex >= at.startIndex) continue;
    const left = a.childForFieldName("left");
    if (left?.type === "member_expression" && left.childForFieldName("object")?.text === id.text) {
      const k = left.childForFieldName("property")?.text;
      if (k) out.push([k, { start: a.startIndex, end: a.endIndex }]);
    } else if (left?.type === "subscript_expression" && left.childForFieldName("object")?.text === id.text) {
      const k = unquote(left.childForFieldName("index")?.text ?? "");
      if (k && /^[A-Za-z_]\w*$/.test(k)) out.push([k, { start: a.startIndex, end: a.endIndex }]);
    }
  }
  for (const c of scope.descendantsOfType("call_expression")) {
    if (!c || c.startIndex >= at.startIndex || c.childForFieldName("function")?.text !== "Object.assign") continue;
    const as = named(c.childForFieldName("arguments") ?? c);
    if (as[0]?.text !== id.text) continue;
    for (const o of as.slice(1).filter((x) => x.type === "object")) {
      const b = readBody(ctx, o);
      for (const k of b.params) out.push([k, b.paramSpans?.[k] ?? { start: o.startIndex, end: o.endIndex }]);
    }
  }
  return out;
}
