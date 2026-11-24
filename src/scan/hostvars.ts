/**
 * v11: a provider's base URL held in a name, then put in front of a path in a string:
 *   const resource = 'https://graph.microsoft.com'   …  `${resource}/v1.0/security/alerts`
 *   protected $apiUrl = 'https://graph.facebook.com';   …  "{$this->apiUrl}/v19.0/me"
 *   BASE = "https://api.stripe.com"                   …  f"{BASE}/v1/payment_intents"
 * The path is read with the host put in, so the provider, the operation and a literal version come out as for a full
 * URL. The method comes from the call around it (.post(, method: 'POST', http.MethodPost …); GET otherwise.
 * Same file, every language; bounded and line-based.
 */
import { matchUrl, urlVersionOf } from "../providers.js";
import type { Usage } from "../types.js";

const MAX_LINE = 2000;
const BIND = /(?:^|[\s(,{;])(?:(?:export|const|let|var|final|static|private|protected|public|readonly|internal|string|String|val)\s+)*\$?(?:this\.|self\.|this->|@)?([A-Za-z_]\w*)\s*(?::\s*[\w<>[\]?.]+\s*)?(?::=|=|:|=>)\s*["'`](https?:\/\/[a-z0-9.-]+\.[a-z]{2,}(?:\/[\w.-]+)*)\/?["'`]/gi;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const METHOD = /\.(post|put|patch|delete)\s*[(<]|method\s*[:=]\s*["'](POST|PUT|PATCH|DELETE)["']|["'](POST|PUT|PATCH|DELETE)["']\s*,|Method(Post|Put|Patch|Delete)\b|Http(Post|Put|Patch|Delete)\b|\b(Post|Put|Patch|Delete)Async\s*\(|Net::HTTP::(Post|Put|Patch|Delete)\b/i;

/** HTTP clients built with a base URL: Faraday.new(url:), httpx.Client(base_url=), Guzzle base_uri, C# BaseAddress, got/ky prefixUrl */
// (a name starts at a word boundary: unanchored, a long run of word characters, such as an embedded base64 blob,
// is rescanned from every position: quadratic)
const BASE_CLIENT = /(?<![\w$])(\$?[A-Za-z_]\w*)\s*(?::=|=)\s*(?:new\s+)?(?:Faraday\.new\(\s*(?:url:\s*|:url\s*=>\s*)?|httpx\.(?:Async)?Client\([^)]*?base_url\s*=\s*|requests_toolbelt\.\w+\(\s*|\\?GuzzleHttp\\Client\(\s*\[\s*["']base_uri["']\s*=>\s*|HttpClient\s*(?:\(\s*\))?\s*\{\s*BaseAddress\s*=\s*new\s+Uri\(\s*|got\.extend\(\s*\{\s*prefixUrl:\s*|ky\.create\(\s*\{\s*prefixUrl:\s*)["'](https?:\/\/[a-z0-9.-]+\.[a-z]{2,}[^"']*)["']/gi;
/** URI('https://…') / URI.parse('…') held in a name (Ruby Net::HTTP) */
const URI_BIND = /(?<![\w$])([A-Za-z_]\w*)\s*=\s*URI(?:\.parse)?\(\s*["'](https?:\/\/[^"']+)["']\s*\)/g;

/**
 * v11: HTTP clients with a base URL and a relative path (conn.post('/v1/x'), $client->request('POST', '/v1/x')),
 * Ruby Net::HTTP::Post.new(uri) with uri = URI('…'), and PHP curl_init('…') with CURLOPT_POST / CURLOPT_CUSTOMREQUEST
 */
export function baseClientUsages(file: string, lang: Usage["lang"], source: string, found: Usage[]): Usage[] {
  if (source.length > 2_000_000 || !/https?:\/\//.test(source)) return [];
  const have = new Set(found.filter((u) => u.op).map((u) => `${u.line}|${u.op}`));
  const lines = source.split("\n");
  const out: Usage[] = [];
  const add = (i: number, method: string, url: string, l: string) => {
    const full = url.replace(/\/+$/, "");
    const hit = matchUrl(full + "/");
    if (!hit) return;
    const path = hit.path.replace(/\/+$/, "").split("?")[0] || "/";
    const op = `${method.toUpperCase()} ${path}`;
    if (have.has(`${i + 1}|${op}`)) return;
    have.add(`${i + 1}|${op}`);
    const version = hit.provider.urlVersion ? urlVersionOf(hit.provider, full + "/") : undefined;
    out.push({ provider: hit.provider.id, kind: "http", lang, file, line: i + 1, op, params: [], confidence: "likely", ...(version ? { apiVersion: `url: ${version}` } : {}), snippet: l.trim().slice(0, 200) });
  };
  const bases = new Map<string, string>();
  for (const m of source.matchAll(BASE_CLIENT)) bases.set(m[1].replace(/^\$/, ""), m[2].replace(/\/+$/, ""));
  const uris = new Map<string, string>();
  for (const m of source.matchAll(URI_BIND)) uris.set(m[1], m[2]);
  const names = [...bases.keys()].map(esc).join("|");
  const call = names ? new RegExp(String.raw`(?:\$|@)?(?:this->|self\.)?\b(${names})\s*(?:\.|->)\s*(get|post|put|patch|delete|request|send)(?:Async)?\s*\(\s*(?:["'](GET|POST|PUT|PATCH|DELETE)["']\s*,\s*)?["'](\/[^"']*)["']`, "gi") : undefined;
  lines.forEach((l, i) => {
    if (l.length > MAX_LINE || /^\s*(\/\/|#|\*)/.test(l)) return;
    if (call) for (const m of l.matchAll(call)) {
      const verb = m[3] ?? (/^(request|send)$/i.test(m[2]) ? undefined : m[2]);
      if (verb) add(i, verb, bases.get(m[1])! + m[4], l);
    }
    // Net::HTTP::Post.new(uri) / Net::HTTP::Get.new(URI('…'))
    for (const m of l.matchAll(/Net::HTTP::(Get|Post|Put|Patch|Delete)\.new\(\s*(?:URI(?:\.parse)?\(\s*["'](https?:\/\/[^"']+)["']\s*\)|([A-Za-z_]\w*))/g)) {
      const url = m[2] ?? uris.get(m[3]);
      if (url) add(i, m[1], url, l);
    }
    // curl_init('https://…') then CURLOPT_POST / CURLOPT_CUSTOMREQUEST within a few lines
    const c = /\bcurl_init\(\s*["'](https?:\/\/[^"']+)["']/.exec(l);
    if (c) {
      const next = lines.slice(i, i + 12).join("\n");
      const custom = /CURLOPT_CUSTOMREQUEST\s*,\s*["'](\w+)["']/.exec(next)?.[1];
      add(i, custom ?? (/CURLOPT_POST(FIELDS)?\s*,/.test(next) ? "POST" : "GET"), c[1], l);
    }
  });
  return out;
}

/** A file's names bound to one provider base URL (with or without a path); ambiguous or computed names left out */
export function baseBindings(source: string): Map<string, string> {
  const hosts = new Map<string, string>();
  if (source.length > 2_000_000 || !/https?:\/\//.test(source)) return hosts;
  // A name with one value in the file: several URLs (one class per provider) or a computed value make it ambiguous
  const values = new Map<string, Set<string>>();
  for (const m of source.matchAll(BIND)) values.set(m[1], (values.get(m[1]) ?? new Set()).add(m[2]));
  for (const [name, vals] of values) {
    const hit = vals.size === 1 ? matchUrl(`${[...vals][0]}/x`) : undefined;
    const computed = new RegExp(String.raw`(?:^|[^\w.])(?:self\.|this\.|this->|@)?\$?${esc(name)}\s*(?::\s*[\w<>[\]?.]+\s*)?(?<![=!<>])=(?!=)\s*(?!["'\x60]|f["'])\S`, "m").test(source);
    if (hit && !computed) hosts.set(name, [...vals][0]);
  }
  return hosts;
}

/** v13: extraHosts: base URLs this file imports from another module (resolved by the caller through the import path) */
export function hostVariableUsages(file: string, lang: Usage["lang"], source: string, found: Usage[], extraHosts?: Map<string, string>): Usage[] {
  if (source.length > 2_000_000) return [];
  const hosts = baseBindings(source);
  if (extraHosts) for (const [k, v] of extraHosts) if (!hosts.has(k)) hosts.set(k, v);
  if (!hosts.size) return [];
  const have = new Set(found.filter((u) => u.op || u.apiVersion).map((u) => `${u.line}`));
  const lines = source.split("\n");
  const out: Usage[] = [];
  const names = [...hosts.keys()].map(esc).join("|");
  // ${resource}/…, ${this.resource}/…, #{@base}/…, {$this->apiUrl}/…, "$this->apiUrl/…, {BASE}/…, BASE + "/…, $base . '/…
  const use = new RegExp(
    String.raw`(?:\$\{\s*(?:this\.|self\.)?(${names})\s*\}|#\{\s*@?(${names})\s*\}|\{\s*\$(?:this->)?(${names})\s*\}|\$(?:this->)?(${names})\b|\{\s*(?:self\.)?(${names})\s*\}|\b(${names})\s*\+\s*["'\x60]|\$(${names})\s*\.\s*["'])(\/[^"'\x60\s]*)`,
    "g",
  );
  lines.forEach((l, i) => {
    if (l.length > MAX_LINE || /^\s*(\/\/|#|\*)/.test(l) || have.has(`${i + 1}`)) return;
    for (const m of l.matchAll(use)) {
      const name = m.slice(1, 8).find(Boolean)!;
      const host = hosts.get(name)!;
      const path = m[8].replace(/\$\{[^}]*\}|#\{[^}]*\}|\{\$[^}]*\}|\{[^}]*\}|\$(?:this->)?\w+/g, "{id}").split("?")[0].replace(/\/+$/, "");
      if (!path || path === "/") continue;
      const url = host + path + "/";
      const hit = matchUrl(url);
      if (!hit) continue;
      const near = lines.slice(Math.max(0, i - 2), i + 3).join("\n");
      const mm = METHOD.exec(near);
      const method = mm ? (mm.slice(1).find(Boolean) ?? "GET").toUpperCase() : "GET";
      const version = hit.provider.urlVersion ? urlVersionOf(hit.provider, url) : undefined;
      out.push({
        // The base may carry a path (https://graph.facebook.com/v23.0, https://api.openai.com/v1): the op is the full path
        provider: hit.provider.id, kind: "http", lang, file, line: i + 1, op: `${method} ${(hit.path.replace(/\/+$/, "").split("?")[0] || path)}`, params: [], confidence: "likely",
        ...(version ? { apiVersion: `url: ${version}` } : {}), snippet: l.trim().slice(0, 200), reason: `the base URL ${host} held in ${name}`,
      });
    }
  });
  return out;
}
