/**
 * Provider-wrapper libraries' own HTTP layer: a repository or service class per
 * endpoint with the path in a constant or enum value ("evals", "audio/translations", "assistants") joined to a base
 * URL the library sets ("https://api.openai.com/v1"), or a Retrofit-style interface (@POST("v1/assistants")).
 * A path counts only when, joined to the repo's versioned base URL for that provider, it is exactly one of the
 * provider's operations as its published SDKs define them (src/data/sdk-vocab): a bare word is never enough on its
 * own. Annotations carry their method ("likely"); constants are "possible" ("*" method) with the lines that use them
 * as alsoLines.
 */
import { matchUrl } from "../providers.js";
import type { Usage } from "../types.js";
import { vocabs } from "./vocab.js";

type Files = { rel: string; lang: Usage["lang"]; source: string }[];
export const norm = (p: string) => p.replace(/\{[^}]*\}|%[sd]|:\w+|\$\{[^}]*\}|<[^>]+>/g, "{}").replace(/\/+$/, "");

let KNOWN: Map<string, Map<string, Set<string>>> | undefined;
/** provider → normalised path → methods, from every SDK vocabulary's operations */
export function known(): Map<string, Map<string, Set<string>>> {
  if (KNOWN) return KNOWN;
  KNOWN = new Map();
  for (const v of vocabs()) {
    const ops = [
      ...Object.values(v.types ?? {}).flatMap((t) => Object.values(t.methods ?? {}).flat().map((m) => m.op)),
      ...Object.values(v.paramTypes ?? {}).flatMap((t) => t.ops ?? []),
    ];
    for (const op of ops) {
      const [method, path] = op.split(" ");
      if (!path || !/^\/v\d+\//.test(path)) continue;
      if (!KNOWN.has(v.provider)) KNOWN.set(v.provider, new Map());
      const m = KNOWN.get(v.provider)!;
      const k = norm(path);
      if (!m.has(k)) m.set(k, new Set());
      m.get(k)!.add(method);
    }
  }
  return KNOWN;
}

// an outbound HTTP request in any language (a client call, not a route)
const OUTBOUND = /\bhttp\.(?:NewRequest\w*|Get|Post|Head)\b|\.Do\(\s*\w+\s*\)|\bReverseProxy\b|\bfetch\s*\(|\baxios\b|\brequests\.(?:get|post|put|patch|delete|request)\b|\bhttpx\.|\baiohttp\b|\burlopen\b|\bFaraday\b|Net::HTTP|\bHTTParty\b|\bcurl_(?:init|exec)\b|\bwp_remote_\w+|\bGuzzle|\bRestTemplate\b|\bWebClient\b|\bHttpClient\b|\bOkHttp|\bPostAsync\b|\bSendAsync\b|\.(?:post|get|put|patch|delete)\s*\(\s*\w*(?:url|Url|URL|path|endpoint)/;
export function wrapperPathUsages(files: Files, found: Usage[]): Usage[] {
  const code = files.filter((f) => f.source.length <= 2_000_000 && (f.lang === "java" || f.lang === "php" || f.lang === "cs" || f.lang === "ts" || f.lang === "js" || f.lang === "py" || f.lang === "rb" || f.lang === "go"));
  // versioned base URLs the repo sets, per provider: https://api.openai.com/v1
  const bases = new Map<string, { host: string; base: string }>();
  for (const f of code) {
    // (a host without a version, https://api.openai.com/, serves paths that carry their own: @POST("v1/assistants"))
    for (const m of f.source.matchAll(/["'`]https:\/\/((?:[a-z0-9-]+\.)+[a-z]{2,})(\/v\d+)?\/?["'`]/g)) {
      const hit = matchUrl(`https://${m[1]}${m[2] ?? ""}/`);
      if (!hit) continue;
      const prev = bases.get(hit.provider.id);
      if (!prev || (!prev.base && m[2])) bases.set(hit.provider.id, { host: m[1], base: m[2] ?? "" });
    }
  }
  if (!bases.size) return [];
  const have = new Set(found.map((u) => `${u.file}|${u.line}`));
  const out: Usage[] = [];
  // packages that forward requests (a gateway or proxy: ReverseProxy, proxy / relay / upstream / forward names):
  // there any path string is a candidate, not only declarations (openAIFamilyProxy("/assistants"),
  // "/assistants/"+id+rest, return "/audio/translations")
  const dirOf = (rel: string) => rel.split("/").slice(0, -1).join("/");
  // (a gateway also serves routes: a folder that only says "forward" somewhere, an API client's comment, isn't one;
  // dev-key check 24 Nov)
  const ROUTES = /\b(?:r|router|app|e|g|engine|group|grp|mux|api|server|srv)\.(?:Any|GET|POST|PUT|DELETE|PATCH|Handle|HandleFunc|all|get|post|put|delete|patch|use|api_route|route)\s*\(\s*["'`]\/|@\w+\.(?:api_route|route|post|get)\s*\(\s*["']\/|\bHandleFunc\s*\(\s*["'`]\/|\bMap(?:Get|Post|Put|Delete|Methods)?\s*\(\s*["']\//;
  const routeDirs = new Set(code.filter((f) => ROUTES.test(f.source)).map((f) => dirOf(f.rel)));
  const forwarding = new Set(code.filter((f) => /ReverseProxy/.test(f.source) || (/\b\w*(?:proxy|relay|upstream|forward)\w*\b/i.test(f.source) && routeDirs.has(dirOf(f.rel)))).map((f) => dirOf(f.rel)));
  // folders that set a provider's versioned base themselves (a helper's default: get_option('…', 'https://api.openai.com/v1'))
  const baseDirs = new Set(code.filter((f) => /["'`]https:\/\/(?:[a-z0-9-]+\.)+[a-z]{2,}\/v\d+\/?["'`]/.test(f.source)).map((f) => dirOf(f.rel)));
  // A path joined to a base (base . '/threads', endpoint + "/threads") counts only when that base is the folder's
  // provider base: the join sits in a file that holds the base URL, or the base is a name such a file defines and the
  // joining file doesn't declare itself (dev-key check, 24 Nov: an Azure agents client's own endpoint + "/threads",
  // next to an OpenAI client that holds api.openai.com, isn't an OpenAI call)
  const BASE_URL = /["'`]https:\/\/(?:[a-z0-9-]+\.)+[a-z]{2,}\/v\d+\/?["'`]/;
  const baseHolders = new Map<string, Set<string>>();
  for (const g of code) if (BASE_URL.test(g.source)) baseHolders.set(dirOf(g.rel), (baseHolders.get(dirOf(g.rel)) ?? new Set()).add(g.rel));
  const sourceOf = new Map(code.map((g) => [g.rel, g.source]));
  const escName = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /** A Terraform-style schema key naming this field ("api_url" for APIURL) in a window that holds a versioned base URL */
  const schemaKeyFor = (field: string, src: string): boolean => {
    const norm = field.toLowerCase();
    const ls = src.split("\n");
    return ls.some((l, i) => {
      const k = /["'`]([a-z][a-z0-9_]*)["'`]\s*:/.exec(l)?.[1];
      return !!k && k.replace(/_/g, "") === norm && BASE_URL.test(ls.slice(i, i + 5).join(" "));
    });
  };
  const baseJoin = (f: { rel: string; source: string }, l: string): [string, string] | null => {
    const m = /([$\w]+)\s*(?:\(\s*\))?\s*(?:\.|\+)\s*["'`](\/[a-z][a-z_]*(?:\/[a-z_]+)*)\/?["'`]/.exec(l);
    if (!m) return null;
    const holders = baseHolders.get(dirOf(f.rel)) ?? new Set<string>();
    if (holders.has(f.rel)) return [m[0], m[2]];
    const name = escName(m[1].replace(/^\$/, ""));
    // the joining file's own parameter, field or local (String endpoint, $base = …, var url = …) is its own base
    const declares = new RegExp(String.raw`[\w<>\]?]\s+\$?${name}\s*[=;,)]|\b(?:var|let|const|val)\s+\$?${name}\b|\$${name}\s*=(?!=)|\b(?:function|def|func|fn)\s+&?${name}\s*\(`);
    // Go: the client's own field (APIURL string) that the provider's schema sets by key and default
    // ("api_url": {…, Default: "https://api.openai.com/v1"}): the same name, the folder's base
    if (f.rel.endsWith(".go") && [...holders].some((h) => schemaKeyFor(m[1], sourceOf.get(h) ?? ""))) return [m[0], m[2]];
    if (declares.test(f.source)) return null;
    // a function or name a base-holding file in the folder defines (function get_api_base_url(), BASE = …)
    // (or a Go struct field the file holds next to its default, APIURL string beside Default: "https://api…/v1")
    const defines = new RegExp(String.raw`\b(?:function|def|func|fn)\s+&?${name}\s*\(|[\w>\]]\s+${name}\s*\([^;{]*\)\s*\{|(?:^|[^\w.])\$?${name}\s*=(?!=)|^\s*${name}\s+\*?[A-Za-z_][\w.]*\s*(?:\x60[^\x60\n]*\x60)?\s*$`, "m");
    return [...holders].some((h) => defines.test(sourceOf.get(h) ?? "")) ? [m[0], m[2]] : null;
  };
  // Paths the repo serves (route registrations anywhere: mux.HandleFunc("/v1/threads", …), r.POST, app.post, @app.get,
  // @PostMapping, router.get), by their shape without a leading version: such a path is the app's own API
  const pathKey = (p: string) => p.replace(/^\/?v\d+(?=\/)/, "").replace(/\{[^}]*\}|:\w+|<[^>]*>/g, "{id}").replace(/\/+$/, "").replace(/^(?!\/)/, "/");
  const served = new Set<string>();
  for (const g of code) {
    for (const m of g.source.matchAll(/\b(?:HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE|Any|Group|MapGet|MapPost|MapPut|MapDelete|api_route|add_api_route|add_url_rule)\s*\(\s*["'`](\/[^"'`\s]*)["'`]|\b(?:app|router|r|e|g|api|server|srv|mux|engine|group|grp|bp|blueprint)\.(?:get|post|put|patch|delete|all|route|api_route|HandleFunc|Handle)\s*\(\s*["'`](\/[^"'`\s]*)["'`]|@\w*(?:Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?["'](\/[^"'\s]*)["']/g)) {
      // (a Feign / HTTP-interface client's mappings are calls, not served routes)
      if (m[3] && /@FeignClient\b|@HttpExchange\b/.test(g.source)) continue;
      served.add(pathKey(m[1] ?? m[2] ?? m[3]));
    }
  }
  /** a path with literal ids (/v1/threads/1, /v1/threads/thread_abc/runs) against the operations' {id} slots */
  const lookupLoose = (pid: string, path: string): Set<string> | undefined => {
    const segs = path.split("/");
    const k = known().get(pid);
    if (!k) return undefined;
    // each way of replacing the segments after the version and the collection name with {}
    for (let mask = 1; mask < 1 << Math.min(4, segs.length); mask++) {
      const c = segs.map((x, i) => (i >= 3 && mask & (1 << (i - 3)) && /^[\w-]+$/.test(x) ? "{}" : x)).join("/");
      const hit = k.get(c);
      if (hit) return hit;
    }
    return undefined;
  };
  const TABLE_VERB = "GET|POST|PUT|PATCH|DELETE";
  const TABLE_PATH = String.raw`(\/?v\d+\/[a-z][\w{}.%:\/-]*)`;
  const tableRow = (l: string, src: string): { method: string; path: string } | null => {
    const m = new RegExp(String.raw`["'\x60](${TABLE_VERB})["'\x60]\s*,\s*["'\x60]${TABLE_PATH}["'\x60]`).exec(l)
      ?? new RegExp(String.raw`\b(?:method|Method)\s*[:=]\s*["'\x60](${TABLE_VERB})["'\x60][^\n]*?\b(?:path|Path|endpoint|Endpoint|url|URL|route|Route|uri)\s*[:=]\s*["'\x60]${TABLE_PATH}["'\x60]`).exec(l);
    const r = m ? null : new RegExp(String.raw`["'\x60]${TABLE_PATH}["'\x60]\s*,\s*["'\x60](${TABLE_VERB})["'\x60]`).exec(l) ?? new RegExp(String.raw`\b(?:path|Path|endpoint|Endpoint|url|URL|route|Route|uri)\s*[:=]\s*["'\x60]${TABLE_PATH}["'\x60][^\n]*?\b(?:method|Method)\s*[:=]\s*["'\x60](${TABLE_VERB})["'\x60]`).exec(l);
    const hit = m ? { method: m[1], path: m[2] } : r ? { method: r[2], path: r[1] } : null;
    // the file sends requests (a loop over the table), and doesn't register routes
    if (!hit || !OUTBOUND.test(src) || ROUTES.test(src)) return null;
    return { method: hit.method.toUpperCase(), path: hit.path.startsWith("/") ? hit.path : `/${hit.path}` };
  };
  const lookup = (pid: string, path: string): Set<string> | undefined => known().get(pid)?.get(norm(path));
  const join = (base: string, p: string) => (/^\/?v\d+\//.test(p) ? `/${p.replace(/^\//, "")}` : `${base}/${p.replace(/^\//, "")}`);
  for (const f of code) {
    // views and templates aren't an HTTP layer (type="search" is an input's type)
    if (/\.blade\.php$|\.(?:vue|svelte|astro)$|(?:^|\/)(?:views?|templates?|components)\//.test(f.rel)) continue;
    const lines = f.source.split("\n");
    const enumAt = (row: number) => {
      for (let r = row; r >= Math.max(0, row - 200); r--) {
        const m = /^\s*(?:(?:public|private|internal|export)\s+)?enum\s+(?:class\s+)?(\w+)/.exec(lines[r]);
        if (m) return m[1];
        if (r < row && /^\s*(?:(?:public|private|final|abstract)\s+)*(?:class|interface|trait|object)\s+\w+/.test(lines[r])) return undefined;
      }
      return undefined;
    };
    // Retrofit / Feign / JAX-RS style: @POST("v1/assistants"), @GetMapping("/v1/threads/{id}")
    // (Spring's @GetMapping on a controller is a route the app serves, not a call: *Mapping counts only on a Feign
    // or HTTP-interface client). Once per file: per line it rescanned the whole file every line
    const client = /@FeignClient\b|@HttpExchange\b|\bretrofit2?\b/.test(f.source);
    lines.forEach((l, i) => {
      if (l.length > 2000 || have.has(`${f.rel}|${i + 1}`) || /^\s*(?:\/\/|#|\*)/.test(l)) return;
      // every shape below holds a quoted path
      if (!/["'`]/.test(l)) return;
      // (Feign: @RequestLine("POST /assistants"), the verb and path in one string)
      const ann = /@(GET|POST|PUT|DELETE|PATCH|HTTP)\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"]+)"/.exec(l) ?? /@RequestLine\s*\(\s*"(GET|POST|PUT|DELETE|PATCH)\s+([^"\s?]+)[^"]*"/.exec(l) ?? (client ? /@(Get|Post|Put|Delete|Patch)(?:Mapping|Exchange)\s*\(\s*(?:value\s*=\s*|path\s*=\s*|url\s*=\s*)?"([^"]+)"/.exec(l) : null);
      // a declaration holding a bare path: const / static / enum value / case / NAME("…") / NAME = '…'
      const decl = ann ? undefined : /^\s*(?:(?:public|private|protected|internal|static|final|const|readonly|export|case)\s+)*(?:[\w<>?]+\s+)?([A-Za-z_]\w*)\s*(?:\(\s*|(?::\s*[\w<>]+\s*)?=\s*)["'](\/?[a-z][a-z_]*(?:\/[\w{}.%:-]+)*)\/?["']\s*\)?\s*[,;]?\s*$/.exec(l);
      // a path string in a forwarding package: "/assistants" in a call, a concatenation or a return
      const fwd = !ann && !decl && forwarding.has(dirOf(f.rel)) ? /["'`](\/[a-z][a-z_]*(?:\/[a-z_]+)*)\/?["'`]/.exec(l)
        // a path joined to a base where the folder sets the base (get_api_base_url() . '/threads', base + "/threads")
        : !ann && !decl && baseDirs.has(dirOf(f.rel)) ? baseJoin(f, l) : null;
      // a request table row: {"GET", "/v1/assistants"}, {Method: "POST", Endpoint: "/v1/evals"}, ("GET", "/v1/threads/1"),
      // { method: 'GET', path: '/v1/assistants' }: a verb and a versioned path together, in a file that sends requests
      const row = ann || decl || fwd ? null : tableRow(l, f.source);
      const raw = ann?.[2] ?? decl?.[2] ?? fwd?.[1] ?? row?.path;
      if (!raw) return;
      // not a call: a route the repo serves itself (an Assistants-compatible server registering
      // /v1/threads), a router link (to="/threads", href, navigate("/threads")), or a path test (if "/search/" in
      // path, startswith("/assistants"), == "/x", case "/x")
      if (served.has(pathKey(raw))) return;
      const pre = l.slice(0, Math.max(0, l.indexOf(raw) - 1));
      // (a table row's own path: key isn't a router prop)
      if (!row && /(?:\bto|\bhref|\bpath|\bpathname|\broute)\s*[=:]\s*\{?\s*$|\b(?:navigate|push|replace|redirect|Redirect|Link|NavLink|router\.\w+)\s*\(\s*$/.test(pre)) return;
      // a CSS attribute selector (query_selector_all("a[href*='/search/']"), [src^="/assets"]) isn't a request
      if (/\[\s*[\w-]+\s*[*^$~|]?=\s*$/.test(pre)) return;
      if (/\bin\s+[\w.]*(?:path|url|uri|route)\w*\b|\.(?:startswith|endswith|startsWith|endsWith|includes|match|test)\s*\(\s*$|(?:===?|!==?)\s*$|\bcase\s+$/i.test(pre) || /^\s*["'`][^"'`]*["'`]\s*(?:in\s+[\w.]*(?:path|url|uri)|===?|!==?)/i.test(l.slice(l.indexOf(raw) - 1))) return;
      // a path string in a forwarding package counts only next to an outbound request (an http client call within a
      // few lines): route tables and handlers in the same package don't
      if (fwd && !ann && !decl && !baseDirs.has(dirOf(f.rel))) {
        const near = lines.slice(Math.max(0, i - 25), i + 25).join("\n");
        if (!OUTBOUND.test(near)) return;
      }
      // a bare one-word value needs more than its spelling to be an endpoint path (setFocus('search') isn't): a name
      // that says path / endpoint / route, an enum of them, or a use of the name in an HTTP call
      if (decl) {
        const en = enumAt(i);
        const callForm = /\(\s*["']/.test(l.slice(l.indexOf(decl[1]) + decl[1].length, l.indexOf(decl[1]) + decl[1].length + 3));
        if (callForm && !en) return;
        if (!raw.includes("/")) {
          const named = /path|endpoint|uri|url|route|resource/i.test(decl[1]) || (!!en && /endpoint|path|route|resource|api/i.test(en));
          //
          if (!named) return;
        }
      }
      for (const [pid, b] of bases) {
        if (!b.base && !/^\/?v\d+\//.test(raw)) continue;
        const path = join(b.base, raw);
        const methods = lookup(pid, path) ?? (row ? lookupLoose(pid, path) : undefined);
        if (!methods) continue;
        const hit = matchUrl(`https://${b.host}${path.replace(/\{[^}]*\}/g, "{id}")}`);
        if (!hit) continue;
        // (a request line that names its method, NewRequest("POST", base+"/path") / http.Post(…) / method: "POST", says which)
        const said = ann || decl ? undefined : (/\bNewRequest\w*\(\s*(?:[\w.]+\s*,\s*)?(?:"|http\.Method)(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete)\b/.exec(l)?.[1] ?? /\bhttp\.(Get|Post|Head)\(/.exec(l)?.[1] ?? /\bmethod\s*[:=]\s*["'](GET|POST|PUT|PATCH|DELETE)["']/i.exec(l)?.[1])?.toUpperCase();
        if (row && !methods.has(row.method) && !methods.has("*")) continue;
        const method = ann ? (ann[1].toUpperCase() === "HTTP" ? "*" : ann[1].toUpperCase()) : row ? row.method : said && methods.has(said) ? said : "*";
        if (ann && method !== "*" && !methods.has(method) && !methods.has("*")) continue;
        const uses = decl ? lines.map((x, k) => k + 1).filter((n) => n !== i + 1 && new RegExp(`(?<![\\w$])${decl[1]}(?![\\w$])`).test(lines[n - 1])).slice(0, 20) : [];
        have.add(`${f.rel}|${i + 1}`);
        out.push({
          provider: pid, kind: "http", lang: f.lang, file: f.rel, line: i + 1, op: `${method} ${hit.path}`, confidence: ann || row || method !== "*" ? "likely" : "possible",
          snippet: l.trim().slice(0, 200), reason: `${ann ? `${ann[1]} "${raw}"` : decl ? `${decl[1]} = "${raw}"` : `"${raw}" forwarded`} on ${b.host}${b.base}: ${hit.path}`,
          ...(uses.length ? { alsoLines: uses } : {}),
        });
        break;
      }
    });
  }
  return out;
}
