/**
 * v7: API versions written outside a full URL. Real code splits the host from the version: a version constant or
 * default (WHATSAPP_API_VERSION = 'v14.0', load('FACEBOOK_API_VERSION', 'v18.0'), STOREFRONT_API_VERSION =
 * "2026-10"), a parameter default (def phone_id_path(version = 'v13.0')), a version in a templated path whose host is
 * a variable ("#{api_base_path}/v13.0/#{id}"), or a config entry (name: FACEBOOK_API_VERSION … value: 'v18.0').
 *
 * Data-driven: a provider opts in with the shape of its version tokens (versionToken) and the words that tie code to
 * it (versionEvidence: hosts, product names); words that point elsewhere (notEvidence, e.g. Threads, whose v1.0 isn't
 * Graph's) rule a line out. Line-based and bounded, every language and config file alike. Comments are reported as
 * copy, and three or more versions together (an enum, a list) as a catalog.
 */
import { PROVIDERS, matchUrl, type ProviderDef } from "../providers.js";
import type { Usage } from "../types.js";

const WINDOW = 3;
const VERSION_NAME = /version|_path\b|path\(|url\(|endpoint/i;
// Names for the version of something other than a provider's API: the app, a schema, a protocol, a plugin…
const SELF_VERSION = /(?:^|[_.-])(?:app|application|cli|tool|plugin|extension|addon|schema|protocol|spec|openapi|swagger|manifest|format|build|release|package|module|bundle|firmware|template|theme|config|db|database|migration|server|agent|bot|game|engine|runtime|node|python|go|java|php|ruby|docker|chart|image|terraform|provider|lib|library)_?version(?:$|[_.-])/i;
const COMMENT = /^\s*(#|\/\/|\*|\/\*|<!--|--\s)/;
const MAX_LINE = 2000;

type Hit = { line: number; version: string; listed?: boolean; doc?: boolean };

/**
 * v15: names of other services whose versions share these shapes (LinkedIn's v2.1, Pinterest's v5.0). A version whose
 * nearest preceding name is one of these, or another provider's, isn't this provider's.
 */
const OTHER_BRANDS = ["twitter", "linkedin", "pinterest", "tiktok", "snapchat", "google", "youtube", "microsoft", "azure", "msgraph", "amazon", "aws", "apple", "yahoo", "vimeo", "dropbox", "slack", "discord", "spotify", "zoom", "paypal", "reddit", "tumblr", "twitch", "kakao", "naver", "vkontakte", "weibo", "wechat", "telegram", "viber", "okta", "auth0", "hubspot", "salesforce", "mailchimp", "sendgrid", "twilio", "mapbox", "github", "gitlab", "bitbucket", "stripe", "shopify", "openai", "anthropic", "mistral", "cohere", "dribbble", "strava", "fitbit", "garmin", "xero", "quickbooks", "intuit", "docusign", "notion", "asana", "trello", "jira", "atlassian", "box"];
const brandsFor = (p: ProviderDef) => new RegExp(`(?<![a-z])(?:${OTHER_BRANDS.filter((b) => b !== p.id && !p.hosts.some((h) => h.includes(b))).join("|")})(?![a-z])`, "gi");
/** Is the nearest service named before `at` in `text` another one? */
function otherCloser(text: string, at: number, ev: RegExp, brands: RegExp): boolean {
  const before = text.slice(0, at);
  let lastEv = -1;
  let lastOther = -1;
  for (const m of before.matchAll(new RegExp(ev.source, ev.flags.includes("g") ? ev.flags : ev.flags + "g"))) lastEv = m.index! + m[0].length;
  // Import lines and module paths (github.com/acme/app/pkg, "@aws-sdk/…" in an import) name code, not the service a
  // version belongs to: Go files import github.com paths right above their constants
  const masked = before
    .replace(/^[ \t]*(?:import\b|from\s+\S+\s+import\b|require[ \t(]|use\s|using\s|#include\b|package\s)[^\n]*/gm, (x) => " ".repeat(x.length))
    .replace(/(?<![\w.])(?:github\.com|gitlab\.com|bitbucket\.org)\/[\w.-]+\/[\w./-]*/gi, (x) => " ".repeat(x.length))
    .replace(/^[ \t]*(?:[\w.]+[ \t]+)?"[\w.-]+\.[a-z]+\/[^"\n]*"[ \t]*$/gm, (x) => " ".repeat(x.length));
  for (const m of masked.matchAll(brands)) lastOther = m.index! + m[0].length;
  return lastOther > lastEv;
}

function hitsFor(p: ProviderDef, path: string, text: string, lines: string[]): Hit[] {
  const tok = p.versionToken!;
  const ev = p.versionEvidence!;
  if (!ev.test(path) && !ev.test(text)) return [];
  const tokSrc = tok.source.replace(/^\^/, "").replace(/\$$/, "");
  // A quoted token, a YAML/INI value, or a segment of a path that starts with an interpolation (host in a variable)
  const quoted = new RegExp(`(["'\`])(${tokSrc})\\1`, "g");
  // v12: also a compose list entry (- WA_BUSINESS_VERSION=v18.0) and a quoted .env value (X="v18.0")
  const bare = new RegExp(`^\\s*(?:-\\s*)?(?:export\\s+)?[\\w.-]+\\s*[:=]\\s*["']?(${tokSrc})["']?\\s*$`);
  const leading = new RegExp(`(["'\`])\\/?(${tokSrc})\\/[\\w{}$.\\-/]*\\1`, "g");
  const segment = new RegExp(`(\\#\\{[^}]*\\}|\\$\\{[^}]*\\}|\\{[\\w.]+\\})[^"'\`\\s]*/(${tokSrc})(?=/|["'\`]|$)`, "g");
  const out: Hit[] = [];
  const brands = brandsFor(p);
  // v15: versions another host's URL in this file uses (api.example.com/v2.1/…), unless a URL of this provider does too
  const foreign = new Set<string>();
  const own = new Set<string>();
  for (const m of text.matchAll(new RegExp(`https?://([a-z0-9.-]+)[^\\s"'\`]*?/(${tokSrc})(?=[/"'\`?#]|$)`, "gim"))) {
    const host = m[1].toLowerCase();
    const mine = [...p.hosts, ...(p.versionOnlyHosts ?? [])].some((h) => host === h || host.endsWith(`.${h}`)) || ev.test(host);
    (mine ? own : foreign).add(m[2]);
  }
  for (const v of own) foreign.delete(v);
  const theirs = (l: string, idx: number, window: string) => {
    // The window ends with this line: the token's place in it
    const at = window.length - l.length + idx;
    return otherCloser(window, at, ev, brands);
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.length > MAX_LINE) continue;
    const window = lines.slice(Math.max(0, i - WINDOW), i + 1).join("\n");
    // Words for another API (Threads, Shopify's Partner API) on the line, just above it, or in the path rule it out
    if (p.notEvidence && (p.notEvidence.test(window) || p.notEvidence.test(path))) continue;
    const found = new Set<string>();
    // Every hit needs the provider named nearby or in the path: other APIs share these shapes (oauth2/v2.0)
    let near = ev.test(path) || ev.test(window);
    // v15: or named by the block it sits in ('facebook' => [ … 'graphApiVersion' => 'v2.8' ], facebook: { … })
    if (!near && VERSION_NAME.test(l) && new RegExp(tokSrc).test(l)) {
      for (let up = 0; up <= 2 && !near; up++) {
        const b = enclosingBlock(lines, i, path, up);
        if (!b) break;
        near = ev.test(`${lines[b[0] - 1] ?? ""}\n${lines[b[0]]}`);
      }
    }
    if (near) for (const m of l.matchAll(segment)) found.add(m[2]);
    // v8: a path that starts with the version, handed to a helper that adds the host: getApiUrl('v2.8/me')
    if (near) for (const m of l.matchAll(leading)) found.add(m[2]);
    const named = VERSION_NAME.test(l.replace(quoted, "")) || VERSION_NAME.test(window.replace(quoted, ""));
    // A bare token needs the provider named nearby (or in the path): a config file can hold several APIs' versions
    if (named && near) {
      for (const m of l.matchAll(quoted)) found.add(m[2]);
      const b = bare.exec(l);
      if (b) found.add(b[1]);
    }
    for (const version of found) {
      // v15: another service's version (its name closer than this provider's, or another host's URL uses it)
      if (foreign.has(version)) continue;
      const idx = l.indexOf(version);
      // v16: a version assigned to a name for something else's version (appVersion, SCHEMA_VERSION, protocol_version)
      // is that thing's, unless the name also names this provider (graphAppVersion stays)
      const owner = /([A-Za-z_][\w.-]*)["'`]?\s*(?::=|=>|[:=])\s*["'`]?[^"'`]*$/.exec(l.slice(0, Math.max(0, idx - 1)))?.[1] ?? "";
      if (SELF_VERSION.test(owner.replace(/(?<=[a-z0-9])(?=[A-Z])/g, "_")) && !ev.test(owner)) continue;
      if (idx >= 0 && theirs(l, idx, window)) continue;
      out.push({ line: i + 1, version, ...(COMMENT.test(l) ? { doc: true } : {}) });
    }
  }
  // Three or more of the provider's versions within a few lines: an enum or list of versions
  for (const h of out) {
    const near = new Set<string>();
    // (only this provider's: three services' versions side by side aren't a list of one API's versions)
    for (let r = Math.max(0, h.line - 1 - WINDOW); r < Math.min(lines.length, h.line + WINDOW); r++) {
      const l = lines[r];
      const w = lines.slice(Math.max(0, r - WINDOW), r + 1).join("\n");
      for (const m of l.matchAll(quoted)) if (!foreign.has(m[2]) && !theirs(l, m.index!, w)) near.add(m[2]);
    }
    if (near.size >= 3) h.listed = true;
    // v15: or an enumeration block around it (entries spread out by doc comments): see versionBlock
    else if (inVersionCatalog(lines, h.line - 1, path, quoted)) h.listed = true;
  }
  return out;
}

/** The rows [start, end] of the block a row sits in, by brackets (C-like, JSON) or indentation (Python, Ruby, YAML) */
function enclosingBlock(lines: string[], row: number, path: string, up = 0): [number, number] | undefined {
  const indentLang = /\.(py|rb|ya?ml)$/i.test(path);
  const strip = (l: string) => l.replace(/(["'`])(?:\\.|(?!\1)[^\\])*?\1/g, '""').replace(/\/\/.*$|#.*$/, "");
  if (indentLang) {
    const ind = (l: string) => /^\s*/.exec(l)![0].length;
    let at = row;
    let start = -1;
    for (let k = 0; k <= up; k++) {
      const base = ind(lines[at]);
      start = -1;
      for (let r = at - 1; r >= Math.max(0, row - 400); r--) {
        const l = lines[r];
        if (!l.trim() || /^\s*#/.test(l)) continue;
        if (ind(l) < base) { start = r; break; }
      }
      if (start < 0) return undefined;
      at = start;
    }
    const sInd = ind(lines[start]);
    let end = start;
    for (let r = start + 1; r < Math.min(lines.length, start + 400); r++) {
      const l = lines[r];
      if (!l.trim() || /^\s*#/.test(l)) continue;
      if (ind(l) <= sInd) break;
      end = r;
    }
    return [start, end];
  }
  // Brackets: walk up to the opener that's still open at this row, then down to its closer
  let depth = 0;
  let start = -1;
  let need = up;
  outer: for (let r = row; r >= Math.max(0, row - 400); r--) {
    const l = strip(lines[r]);
    for (let c = (r === row ? 0 : l.length) - 1; c >= 0; c--) {
      const ch = l[c];
      if (ch === "}" || ch === "]" || ch === ")") depth++;
      else if (ch === "{" || ch === "[" || ch === "(") {
        if (depth === 0) {
          if (need === 0) { start = r; break outer; }
          need--;
        } else depth--;
      }
    }
  }
  if (start < 0) return undefined;
  depth = 0;
  for (let r = start; r < Math.min(lines.length, start + 400); r++) {
    for (const ch of strip(lines[r])) {
      if (ch === "{" || ch === "[" || ch === "(") depth++;
      else if ((ch === "}" || ch === "]" || ch === ")") && --depth <= 0 && r > start) return [start, r];
    }
  }
  return undefined;
}

/**
 * v15: a row inside an enumeration of the provider's versions: three or more different versions in one block that is
 * an enum, a Python Enum / *Version class, a Go const (…) block, an array, or a map keyed by versions or by
 * version-named entries (V24 = 'v24.0', October24 = '2024-10', 'v24.0': { … }). A library's own list of versions is
 * a catalog, however far apart doc comments put its entries. An app's settings object that holds several products'
 * versions under plain keys (graphVersion: …) isn't one.
 */
function inVersionCatalog(lines: string[], row: number, path: string, quoted: RegExp): boolean {
  for (let up = 0; up <= 1; up++) {
    const b = enclosingBlock(lines, row, path, up);
    if (!b) return false;
    const [s, e] = b;
    if (e - s > 400) return false;
    const body = lines.slice(s, e + 1);
    const versions = new Set<string>();
    let named = 0;
    for (const l of body) {
      if (/^\s*(#|\/\/|\*|\/\*)/.test(l)) continue;
      for (const m of l.matchAll(new RegExp(quoted.source, "g"))) {
        versions.add(m[2]);
        // The entry's name or key carries the version's numbers (V24_0, October24, 'v24.0':)
        const lhs = l.slice(0, m.index).replace(/^\s*(?:(?:export|public|private|static|readonly|const|final|case)\s+)*/, "");
        const digits = (m[2].match(/\d+/g) ?? []).filter((d) => d !== "0");
        const key = /^\s*["'`]?([\w.-]+)["'`]?\s*(?:[:=]|\w+\s*=)/.exec(lhs)?.[1] ?? "";
        if (digits.some((d) => key.includes(d.slice(-2)))) named++;
        if (new RegExp(`^\\s*(["'\`])${m[2].replace(/[.]/g, "\\.")}\\1\\s*:`).test(l)) named++;
      }
    }
    if (versions.size < 3) continue;
    const opener = `${lines[s - 1] ?? ""}\n${lines[s]}`;
    const enumLike = /\benum\b|\bEnum\b|\bconst\s*\(\s*$|\[\s*$|[=:]\s*\[|\bclass\s+\w*Version|\bmodule\s+\w*Version|\bobject\s+\w*Version/.test(opener);
    if (enumLike || named >= 3) return true;
  }
  return false;
}

export function versionConstantUsages(path: string, lang: Usage["lang"], text: string, found: Usage[]): Usage[] {
  if (text.length > 2_000_000) return [];
  // A line that already pins this version (for any provider: Graph vs Marketing API share v24.0) isn't counted twice
  const have = new Set(found.filter((u) => u.apiVersion).map((u) => `${u.line}|${u.apiVersion!.split(": ").pop()}`));
  const lines = text.split("\n");
  const out: Usage[] = [];
  for (const p of PROVIDERS) {
    if (!p.versionToken || !p.versionEvidence) continue;
    for (const h of hitsFor(p, path, text, lines)) {
      if (have.has(`${h.line}|${h.version}`)) continue;
      have.add(`${h.line}|${h.version}`);
      out.push({
        provider: p.id, kind: "version-pin", lang, file: path, line: h.line, apiVersion: `const: ${h.version}`, confidence: "possible",
        snippet: (lines[h.line - 1] ?? "").trim().slice(0, 200),
        ...(h.listed ? { listed: true, reason: "a list of API versions" } : {}), ...(h.doc ? { doc: true } : {}),
      });
    }
  }
  return out;
}

/** v8: a name bound to a version token: `const apiVersion = "v20.0"`, `META_GRAPH_API_VERSION = 'v25.0'`, `$version = 'v2.8';` */
// v11: also an env var's fallback (VERSION: process.env.WA_VERSION || 'v18.0', os.getenv('X', 'v18.0'), ENV.fetch('X', 'v18.0'))
const ENV_FALLBACK = String.raw`(?:process\.env(?:\.\w+|\[[^\]]+\])|import\.meta\.env\.\w+|os\.environ\.get\([^,)]+|os\.getenv\([^,)]+|ENV\.fetch\([^,)]+|ENV\[[^\]]+\]|getenv\([^,)]+|env\([^,)]+|config\([^,)]+|Environment\.GetEnvironmentVariable\([^)]*\))\s*(?:\|\||\?\?|\bor\b|,|\?:)\s*`;
const BIND = (tok: string) => new RegExp(`(?:^|[\\s(,{;])(?:(?:export|const|let|var|static|readonly|private|public|protected|final|String)\\s+)*[$@]?([A-Za-z_][\\w]*)\\s*(?::\\s*[\\w<>\\[\\]|. ]+)?\\s*(?:=|:|=>)\\s*(?:${ENV_FALLBACK})?["'\`](${tok})["'\`]`, "g");
/** An interpolated name in a string: ${a.b.NAME}, #{@NAME}, {self.NAME}, " + NAME, ' . $NAME, {$this->NAME}, $this->NAME */
// v14: also a config read by key: ${this.configService.get<T>('WA_BUSINESS').VERSION}, ${config('meta').version}
const INTERP = String.raw`(?:\$\{\s*(?:[\w$]+\??\.)*([\w$]+)\s*\}|\$\{\s*(?:this\.)?([\w$]+)\(\s*\)\s*\}|["']\s*\.\s*(?:self::|static::|[\w\\]+::)?([A-Z][A-Z0-9_]*)\b|\$\{\s*(?:[\w$]+\??\.)*[\w$]+(?:<[\w$.\[\]| ]*>)?\(\s*["'][\w$.-]+["']\s*\)\??\.([\w$]+)\s*\}|#\{\s*@?(?:[\w]+(?:\.|::))*([\w]+)\s*\}|\{\s*(?:self\.|this\.)?([\w]+)\s*\}|["']\s*\+\s*(?:[\w$]+\.)*([\w$]+)|["']\s*\.\s*\$(?:this->)?([\w]+)|\{\s*\$(?:this->)?(\w+)\s*\}|\$this->(\w+))`;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The literal path before a provider's version capture: "/admin/api/" for Shopify's urlVersion */
function versionPrefix(p: ProviderDef): string | undefined {
  const src = p.urlVersion?.source ?? "";
  const i = src.indexOf("(");
  if (i <= 0) return undefined;
  const lit = src.slice(0, i).replace(/\\\//g, "/");
  return /[\\[\]()*+?{}|^$]/.test(lit) || lit.length < 3 ? undefined : lit;
}

/**
 * v8: a version held in a variable or constant and used in a provider URL: `const apiVersion = "v20.0"` …
 * `https://graph.facebook.com/${apiVersion}/…`, or an exported constant another file imports and interpolates
 * (META_GRAPH_API_VERSION). The variable is followed into the URL instead of looking for the provider's name nearby.
 * Reported at the binding (where a fix changes the version) and at each file's use.
 */
export function versionVariableUsages(files: { rel: string; lang: Usage["lang"]; source: string }[], found: Usage[], moreFiles?: () => { rel: string; lang: Usage["lang"]; source: string }[], readRel?: (rel: string) => string | undefined, resolveImport?: (useFile: string, name: string) => { file: string; start: number; end: number } | undefined): Usage[] {
  const providers = PROVIDERS.filter((p) => p.versionToken && p.urlVersion);
  if (!providers.length) return [];
  const tokens = providers.map((p) => p.versionToken!.source.replace(/^\^/, "").replace(/\$$/, "")).join("|");
  const have = new Set(found.filter((u) => u.apiVersion).map((u) => `${u.file}|${u.line}|${u.apiVersion!.split(": ").pop()}`));
  // 1. Bindings, by name
  const binds = new Map<string, { file: string; line: number; version: string; source: string; obj?: string; numeric?: boolean }[]>();
  // v14: a version given as a call's fallback (getattr(settings, 'X', {}).get('VERSION', 'v19.0'), settings.get('V', 'v19.0'))
  const MODS = String.raw`(?:(?:export|const|let|var|static|readonly|private|public|protected|final)\s+)*`;
  const BIND_CALL = new RegExp(String.raw`^\s*${MODS}[$@]?([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*(?!["'\x60])[^\n]*[,(]\s*["'\x60](${tokens})["'\x60]\s*\)+\s*;?\s*$`);
  // v14: a bare number held by a version setting (API_VERSION = 24.0), put after a literal "v" in a URL (v{version})
  const BIND_NUM = new RegExp(String.raw`^\s*(?:[\w<>\[\]?,]+\s+)*?[$@]?([A-Za-z_]*[Vv][Ee][Rr]\w*)\s*(?::[^=]+)?=\s*["']?(\d{1,2}\.\d{1,2})["']?\s*;?\s*(?:(?:#|\/\/).*)?$|^\s*define\(\s*["']([A-Za-z_]*[Vv][Ee][Rr]\w*)["']\s*,\s*["']?(\d{1,2}\.\d{1,2})["']?\s*\)|^\s*([a-z_]*version)\s*\(?\s*["'](\d{1,2}\.\d{1,2})["']\s*\)?\s*$`);
  // v14: a name bound to an SDK setter's value (export const SHOPIFY_API_VERSION = ApiVersion.October24)
  const setterBinds = providers.flatMap((p) => (p.versionSetters ?? []).filter((s) => !s.ident).map((s) => ({ p, s })));
  const LHS = /(?:^|[\s(,{;])(?:(?:export|const|let|var|static|readonly|private|public|protected|final)\s+)*\$?([A-Za-z_][\w]*)\s*(?::\s*[\w<>[\]|. ]+)?\s*=\s*$/;
  for (const f of files) {
    if (f.source.length > 2_000_000) continue;
    const viaSetter = setterBinds.filter(({ s }) => (!s.needs || s.needs.test(f.source)) && new RegExp(s.re.source).test(f.source));
    // (or an SDK option takes a name: GraphAPI(version=GRAPH_API_VERSION) with GRAPH_API_VERSION = "2.12")
    const numeric = /v(?:\$?\{|#\{|["']\s*[+.])/.test(f.source) || providers.some((p) => (p.versionSetters ?? []).some((x) => x.ident && x.re.test(f.source)));
    if (!viaSetter.length && !numeric && !new RegExp(tokens).test(f.source)) continue;
    const srcLines = f.source.split("\n");
    srcLines.forEach((l, i) => {
      if (l.length > MAX_LINE || COMMENT.test(l)) return;
      let call = BIND_CALL.exec(l);
      let at = i;
      // Call map pilot: a binding wrapped in parentheses over several lines (NAME = (\n getattr(…)\n .get("VERSION", "v19.0")\n))
      if (!call && /^\s*[$@]?[A-Za-z_]\w*\s*(?::[^=]+)?=\s*\(\s*$/.test(l)) {
        let depth = 0;
        const parts: string[] = [];
        for (let k = i; k < Math.min(srcLines.length, i + 10); k++) {
          const t = srcLines[k];
          if (t.length > MAX_LINE) break;
          parts.push(k === i ? t : t.trim());
          depth += (t.match(/\(/g) ?? []).length - (t.match(/\)/g) ?? []).length;
          if (depth <= 0) break;
        }
        const joined = depth <= 0 ? parts.join("") : "";
        call = joined ? BIND_CALL.exec(joined) : null;
        if (call) at = i + Math.max(0, srcLines.slice(i, i + parts.length).findIndex((t) => t.includes(call![2])));
      }
      if (call) binds.set(call[1], [...(binds.get(call[1]) ?? []), { file: f.rel, line: at + 1, version: call[2], source: f.source }]);
      const num = numeric ? BIND_NUM.exec(l) : null;
      if (num) {
        const [n, v] = num[1] ? [num[1], num[2]] : num[3] ? [num[3], num[4]] : [num[5], num[6]];
        binds.set(n, [...(binds.get(n) ?? []), { file: f.rel, line: i + 1, version: v, source: f.source, numeric: true }]);
      }
      for (const { p, s } of viaSetter) {
        const m = new RegExp(s.re.source).exec(l);
        const lhs = m ? LHS.exec(l.slice(0, m.index)) : null;
        if (!m || !lhs) continue;
        const version = s.fmt ? s.fmt(m) : m[1];
        if (!p.versionToken!.test(version)) continue;
        binds.set(lhs[1], [...(binds.get(lhs[1]) ?? []), { file: f.rel, line: i + 1, version, source: f.source }]);
      }
      for (const m of l.matchAll(BIND(tokens))) {
        const list = binds.get(m[1]) ?? [];
        // v13: the object it sits in (const WA_BUSINESS = { VERSION: … }), for uses like WA_BUSINESS.VERSION
        const ls = f.source.split("\n");
        let obj: string | undefined;
        for (let r = i; r >= Math.max(0, i - 15) && !obj; r--) obj = /([A-Za-z_$][\w$]*)["']?\s*(?::|=)\s*\{\s*$|([A-Za-z_$][\w$]*)\s*=\s*\{[^}]*$/.exec(ls[r].slice(0, r === i ? l.indexOf(m[0]) + 1 : undefined))?.slice(1).find(Boolean);
        list.push({ file: f.rel, line: i + 1, version: m[2], source: f.source, obj });
        binds.set(m[1], list);
      }
    });
  }
  // v14: a local name given a bound name's value in the same file (version = self.setting('API_VERSION', self.API_VERSION))
  // holds that version too; the fix still goes where the value is written
  for (const f of files) {
    if (f.source.length > 2_000_000) continue;
    if (![...binds.values()].some((cs) => cs.some((c) => c.file === f.rel))) continue;
    f.source.split("\n").forEach((l, i) => {
      if (l.length > MAX_LINE || !/=/.test(l)) return;
      const a = /^\s*(?:(?:const|let|var|final)\s+)?\$?([A-Za-z_]\w*)\s*=\s*(?![=>])(.*?)(?:self\.|this\.|cls\.|static::|self::)?\$?([A-Za-z_]\w*)\s*\)*\s*;?\s*$/.exec(l);
      if (!a || a[1] === a[3] || COMMENT.test(l)) return;
      if (a[2] && !/[(,]\s*$|\b(?:or|\|\||\?\?|\?:)\s*$/.test(a[2])) return;
      const src = (binds.get(a[3]) ?? []).filter((c) => c.file === f.rel && c.line <= i + 1).pop();
      if (src) binds.set(a[1], [...(binds.get(a[1]) ?? []), src]);
    });
    // v15: a getter that returns a bound name (return configured || DEFAULT_GRAPH_API_VERSION): its calls hold it too
    const ls = f.source.split("\n");
    ls.forEach((l, i) => {
      if (l.length > MAX_LINE) return;
      const r = /^\s*return\b.*?(?:self\.|this\.|static::|self::)?\$?([A-Za-z_]\w*)\s*\)*\s*;?\s*$/.exec(l);
      if (!r) return;
      const src = (binds.get(r[1]) ?? []).filter((c) => c.file === f.rel && c.line <= i + 1).pop();
      const fn = src ? enclosingFunctionName(ls, i) : undefined;
      if (src && fn && fn !== r[1]) binds.set(fn, [...(binds.get(fn) ?? []), src]);
    });
  }
  // v15: a name imported from a module the prefilter skipped (constants.ts holding only DEFAULT_API_VERSION = "v23.0"):
  // read that module, by its import path, and take the binding from it
  const fromModule = (name: string, fromRel: string, source: string): { file: string; line: number; version: string; source: string; obj?: string; numeric?: boolean } | undefined => {
    const spec = importSpec(source, name);
    if (!spec || !readRel || !/^\./.test(spec)) return undefined;
    const dir = fromRel.split("/").slice(0, -1);
    for (const seg of spec.replace(/\.(m?[jt]sx?|py|rb)$/, "").split("/")) {
      if (seg === "..") dir.pop();
      else if (seg !== "." && seg) dir.push(seg);
    }
    const stem = dir.join("/");
    for (const rel of [".ts", ".tsx", ".js", ".mjs", ".cjs", "/index.ts", "/index.js"].map((e) => stem + e)) {
      const src = readRel(rel);
      if (src === undefined) continue;
      const ls = src.split("\n");
      for (let i = 0; i < ls.length; i++) {
        if (ls[i].length > MAX_LINE) continue;
        for (const m of ls[i].matchAll(BIND(tokens))) if (m[1] === name) return { file: rel, line: i + 1, version: m[2], source: src };
      }
      return undefined;
    }
    return undefined;
  };
  // (no early return: Ruby configuration blocks, below, need no plain binding)
  // 2. Uses: a provider host (or its version path) followed by an interpolated name
  const slots = providers.map((p) => {
    const hosts = [...p.hosts, ...(p.versionOnlyHosts ?? [])].map(esc);
    const pre = p.urlVersionStandsAlone ? versionPrefix(p) : undefined;
    const head = pre ? esc(pre) : `(?:${hosts.join("|")})/`;
    return { p, re: new RegExp(`${head}(v)?${INTERP}`, "g") };
  }).concat(providers.filter((p) => p.hostUrlVersion).map((p) => {
    // v14: a host-anchored versioned path (Shopify Storefront: myshopify.com/api/${v}/)
    const src = p.hostUrlVersion!.source;
    return { p, re: new RegExp(`${src.slice(0, src.indexOf("("))}(v)?${INTERP}`, "g") };
  }));
  const out: Usage[] = [];
  const usedIn = new Set<string>();
  // Requests already found (calls with an operation and no version), by file and line
  const requestsAt = new Map<string, Usage[]>();
  for (const u of found) if (u.op && !u.apiVersion && (u.kind === "http" || u.kind === "sdk")) requestsAt.set(`${u.file}|${u.line}`, [...(requestsAt.get(`${u.file}|${u.line}`) ?? []), u]);
  const holders: { name: string; file: string; provider: string; version: string }[] = [];
  const add = (u: Usage) => {
    const k = `${u.file}|${u.line}|${u.apiVersion!.split(": ").pop()}`;
    if (have.has(k)) return;
    have.add(k);
    out.push(u);
  };
  // In the binding's own file, a use of the version is one more line of the binding's finding (one finding at the
  // constant, its uses in alsoLines), not a finding of its own
  const onBinding = (b: { file: string; line: number; source: string }, ver: string, prov: string, lang: Usage["lang"], line: number) => {
    let u = [...out, ...found].find((x) => x.file === b.file && x.line === b.line && x.apiVersion?.split(": ").pop() === ver);
    if (!u) {
      u = { provider: prov, kind: "version-pin", lang, file: b.file, line: b.line, apiVersion: `const: ${ver}`, confidence: "likely", snippet: (b.source.split("\n")[b.line - 1] ?? "").trim().slice(0, 200) };
      add(u);
    }
    if (line !== b.line) u.alsoLines = [...new Set([...(u.alsoLines ?? []), line])].sort((x, y) => x - y);
  };
  // A use a cross-file trace must start from (a request in a method, a function returning the URL): kept for the trace
  // only, never a finding itself
  const traceStart = (u: Usage) => add({ ...u, traceOnly: true });
  const fileUse = new Map<string, Usage>();
  const TYPE_WORD = /^(?:undefined|null|string|number|boolean|any|unknown|never|void|object)$/;
  // v14: SDK options set from a constant (new WhatsAppAPI({ v: WA_VERSION })), resolved like a URL's name
  const identSetters = providers.flatMap((p) => (p.versionSetters ?? []).filter((s) => s.ident).map((s) => ({ p, s, once: new RegExp(s.re.source, s.re.flags.replace("g", "")) })));
  for (const f of files) {
    if (f.source.length > 2_000_000) continue;
    // Only setters that can match this file: a match on a line, or on a line joined with the next ones, is a match
    // in the file with its line breaks made spaces (and `needs` is about the whole file)
    const flat = identSetters.length ? f.source.replace(/\n/g, " ") : "";
    const active = identSetters.filter(({ s, once }) => (!s.needs || s.needs.test(f.source)) && once.test(flat));
    if (!active.length) continue;
    const lines = f.source.split("\n");
    lines.forEach((l, i) => {
      if (l.length > MAX_LINE || COMMENT.test(l)) return;
      for (const { p, s } of active) {
        // (the options often open on this line and set the version a few lines down)
        let m = s.re.exec(l);
        if (!m && /[({]\s*$/.test(l)) {
          const j = s.re.exec([l, ...lines.slice(i + 1, i + 8)].join(" "));
          if (j && j.index < l.length) m = j;
        }
        if (!m) continue;
        // A member of an imported object or namespace (WHATSAPP.API_VERSION): its binding inside that definition only
        const [objName, member] = m[1].includes(".") ? m[1].split(".") : [undefined, m[1]];
        if (objName && !resolveImport) continue;
        const all = binds.get(member) ?? [];
        const local = objName ? undefined : all.filter((c) => c.file === f.rel && c.line <= i + 1).pop();
        const spec = local || objName ? undefined : importSpec(f.source, member);
        // Call map: the definition the import leads to, through re-exports (exact, or nothing)
        const exact = !local && resolveImport ? resolveImport(f.rel, objName ?? member) : undefined;
        if (objName && !exact) continue;
        const fromSpec = exact ? all.filter((c) => c.file === exact.file && c.line >= exact.start && c.line <= exact.end) : spec ? all.filter((c) => c.file !== f.rel && resolvesTo(spec, f.rel, c.file)) : [];
        const b = local ?? (fromSpec.length === 1 ? fromSpec[0] : undefined) ?? (objName || (all.length && !exact) ? undefined : fromModule(member, f.rel, f.source));
        // (a bare number, GRAPH_API_VERSION = "2.12", is the version without its "v")
        const ver = b && (b.numeric || /^\d/.test(b.version)) ? `v${b.version}` : b?.version;
        if (!b || !ver || !p.versionToken!.test(ver)) continue;
        const snippet = (src: string, n: number) => (src.split("\n")[n - 1] ?? "").trim().slice(0, 200);
        add({ provider: p.id, kind: "version-pin", lang: f.lang, file: b.file, line: b.line, apiVersion: `const: ${ver}`, confidence: "likely", snippet: snippet(b.source, b.line) });
        if (b.file !== f.rel) add({ provider: p.id, kind: "version-pin", lang: f.lang, file: f.rel, line: i + 1, apiVersion: `setter: ${ver}`, confidence: "likely", snippet: l.trim().slice(0, 200), reason: `${m[1]} (${b.file}) is ${ver}` });
      }
    });
  }
  const slotOnce = slots.map((x) => ({ ...x, once: new RegExp(x.re.source, x.re.flags.replace("g", "")) }));
  for (const f of files) {
    if (f.source.length > 2_000_000) continue;
    // Only the slots this file has somewhere (a line's match is a match in the file)
    const here = slotOnce.filter((x) => x.once.test(f.source));
    if (!here.length) continue;
    const lines = f.source.split("\n");
    lines.forEach((l, i) => {
      if (l.length > MAX_LINE) return;
      for (const { p, re } of here) {
        for (const m of l.matchAll(re)) {
          const name = m.slice(2).find(Boolean)!;
          const all = binds.get(name) ?? [];
          // In this file before the use; else the binding in the module it's imported from
          const local = all.filter((c) => c.file === f.rel && c.line <= i + 1).pop();
          const spec = local ? undefined : importSpec(f.source, name);
          const others = all.filter((c) => c.file !== f.rel);
          // Call map: the definition the import leads to, through re-exports; when it resolves, only bindings inside it
          const exact = !local && resolveImport ? resolveImport(f.rel, name) : undefined;
          const fromSpec = exact ? others.filter((c) => c.file === exact.file && c.line >= exact.start && c.line <= exact.end) : spec ? others.filter((c) => c.file.replace(/\.[^./]+$/, "").endsWith(spec.replace(/^[./@~]+/, "").replace(/\.(m?[jt]sx?|py|rb)$/, ""))) : [];
          // v11: a property of an object from another module (config.whatsapp.VERSION): the one binding of that name in the repo
          const dotted = new RegExp(`\\.\\s*${esc(name)}\\b`).test(m[0]);
          // Ruby: a constant named through its modules (Fb::Config::API_VERSION) is the one binding of that name
          const qualified = f.lang === "rb" && new RegExp(`::\\s*${esc(name)}\\b`).test(m[0]);
          // v13: several bindings of a common name (VERSION): the one inside the object the use names (WA_BUSINESS.VERSION)
          // (or the key a config getter reads: configService.get('WA_BUSINESS').VERSION)
          const om = dotted ? new RegExp(`(?:([\\w$]+)|\\(\\s*["']([\\w$]+)["']\\s*\\))\\??\\.\\s*${esc(name)}\\b`).exec(m[0]) : undefined;
          const objName = om?.[1] ?? om?.[2];
          const inObj = objName ? others.filter((c) => c.obj === objName) : [];
          const b = local ?? (exact ? (fromSpec.length === 1 ? fromSpec[0] : undefined) : fromSpec.length === 1 ? fromSpec[0] : inObj.length === 1 ? inObj[0] : (spec || dotted || qualified) && others.length === 1 ? others[0] : undefined) ?? (all.length || dotted ? undefined : fromModule(name, f.rel, f.source));
          if (!b) continue;
          // A literal "v" before the name: only a bare number completes it (v{24.0}); a "v18.0" there would read "vv18.0"
          if (!!m[1] !== !!b.numeric) continue;
          const ver = b.numeric ? `v${b.version}` : b.version;
          if (!p.versionToken!.test(ver)) continue;
          // The URL with the value put in decides the provider (Graph vs the Marketing API's paths)
          const tail = new RegExp(`${INTERP}$`).exec(m[0])![0];
          const url = m[0].slice(0, m[0].length - tail.length) + b.version + "/" + l.slice(m.index + m[0].length).replace(/^\}?\/?/, "");
          const hit = matchUrl(url.replace(/^[^a-z]*/i, "https://"));
          const prov = hit?.provider.urlVersion ? hit.provider : p;
          const snippet = (s: string, n: number) => (s.split("\n")[n - 1] ?? "").trim().slice(0, 200);
          add({ provider: prov.id, kind: "version-pin", lang: f.lang, file: b.file, line: b.line, apiVersion: `const: ${ver}`, confidence: "likely", snippet: snippet(b.source, b.line) });
          // A request on this line sends that version: in the binding's file, a line of the binding's finding, and a
          // start for traces to the request's callers
          for (const r of requestsAt.get(`${f.rel}|${i + 1}`) ?? []) {
            if (r.provider !== prov.id || b.file !== f.rel) continue;
            onBinding(b, ver, prov.id, f.lang, i + 1);
            traceStart({ provider: prov.id, kind: "version-pin", lang: f.lang, file: f.rel, line: i + 1, apiVersion: `url: ${ver}`, ...(r.op ? { op: r.op } : {}), confidence: "likely", snippet: l.trim().slice(0, 200), reason: `${name} (${b.file}:${b.line}) is ${ver}` });
          }
          // A file's uses count once per version (the binding is where the fix goes)
          const useKey = `${f.rel}|${prov.id}|${ver}`;
          if (b.file !== f.rel && !usedIn.has(useKey)) {
            usedIn.add(useKey);
            const u: Usage = { provider: prov.id, kind: "version-pin", lang: f.lang, file: f.rel, line: i + 1, apiVersion: `url: ${ver}`, confidence: "likely", snippet: l.trim().slice(0, 200) };
            fileUse.set(useKey, u);
            add(u);
          } else if (b.file !== f.rel) {
            // The file's later uses: lines of its one usage
            const u = fileUse.get(useKey);
            if (u && u.line !== i + 1) u.alsoLines = [...new Set([...(u.alsoLines ?? []), i + 1])].sort((x, y) => x - y);
          } else if (b.file === f.rel) {
            // In the binding's own file: a function returning the versioned URL (getBaseUrl(shop)), or a name built
            // from it (GRAPH_API_URL = f"https://graph.facebook.com/{GRAPH_API_VERSION}"): reported where the URL is
            // made, so its callers and importers can be traced
            const pre = l.slice(0, m.index);
            const fnName = /\breturn\b/.test(pre) ? enclosingFunctionName(lines, i) : (/["']?([A-Za-z_]\w*)["']?\s*(?::|=)\s*(?:["'`]|f["'])[^"'`]*$/.exec(pre)?.[1] ?? parenBinding(lines, i));
            onBinding(b, ver, prov.id, f.lang, i + 1);
            const k = `${f.rel}|${prov.id}|${ver}|${fnName}`;
            if (fnName && /\breturn\b/.test(pre) && !usedIn.has(k)) {
              usedIn.add(k);
              traceStart({ provider: prov.id, kind: "version-pin", lang: f.lang, file: f.rel, line: i + 1, apiVersion: `url: ${ver}`, confidence: "likely", snippet: l.trim().slice(0, 200), reason: `${fnName} returns a ${ver} URL (${name}, line ${b.line})` });
            }
          }
          // v11: the name holding this versioned URL (API_URL: `…/${V}`, a getter that returns it), for its uses elsewhere
          // (or the name of a parenthesized binding this line sits in: NAME = (\n …get("URL", f"https://…/{V}")\n))
          const holder = /["']?([A-Za-z_]\w*)["']?\s*(?::|=)\s*(?:["'`]|f["'])[^"'`]*$/.exec(l.slice(0, m.index))?.[1] ?? (/\breturn\b/.test(l.slice(0, m.index)) ? enclosingFunctionName(lines, i) : undefined) ?? parenBinding(lines, i);
          if (holder && !/^(url|uri|endpoint|path|u)$/i.test(holder) && !TYPE_WORD.test(holder)) holders.push({ name: holder, file: f.rel, provider: prov.id, version: ver });
        }
      }
    });
  }
  // A version setting given a name imported from the module that binds it ({ "appId": id, "version": GRAPH_API_VERSION },
  // apiVersion: SHOPIFY_API_VERSION): the provider is the one whose versions look like it and whose name or host the
  // binding's module or this file names
  const VKEY = /["']?\b(?:version|api_?version|apiVersion|graph_?api_?version|graphApiVersion)["']?\s*[:=]\s*([A-Za-z_][\w]*)\s*[,})\n]/gi;
  for (const f of files) {
    if (f.source.length > 2_000_000 || !/version/i.test(f.source)) continue;
    const lines = f.source.split("\n");
    lines.forEach((l, i) => {
      if (l.length > MAX_LINE || COMMENT.test(l) || !/version/i.test(l)) return;
      for (const m of `${l}\n`.matchAll(VKEY)) {
        const nm = m[1];
        const all = binds.get(nm) ?? [];
        if (!all.length || all.some((c) => c.file === f.rel)) continue;
        const exact = resolveImport ? resolveImport(f.rel, nm) : undefined;
        const b = exact ? all.filter((c) => c.file === exact.file && c.line >= exact.start && c.line <= exact.end) : [];
        if (b.length !== 1) continue;
        const ver = b[0].numeric || /^\d/.test(b[0].version) ? `v${b[0].version}` : b[0].version;
        const prov = providers.find((p) => p.versionToken!.test(ver) && (p.versionEvidence ? p.versionEvidence.test(b[0].source) || p.versionEvidence.test(f.source) : true));
        if (!prov) continue;
        const useKey = `${f.rel}|${prov.id}|${ver}`;
        if (usedIn.has(useKey)) continue;
        usedIn.add(useKey);
        add({ provider: prov.id, kind: "version-pin", lang: f.lang, file: f.rel, line: i + 1, apiVersion: `setter: ${ver}`, confidence: "likely", snippet: l.trim().slice(0, 200), reason: `${nm} (${b[0].file}) is ${ver}` });
      }
    });
  }
  // Fix 7: a version read from configuration by key (const version = this.configService.get<T>('WA_BUSINESS').VERSION,
  // config.get('meta.version')), where exactly one object in the repo binds that key and field (WA_BUSINESS: {
  // VERSION: process.env.X || 'v18.0' }), put into a URL in the next lines: reported where it's read
  const CFG = /^\s*(?:(?:const|let|var|final)\s+)?\$?([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*[^;\n]*?\.get(?:<[^>]*>)?\(\s*["']([\w.-]+)["']\s*\)\??(?:\.([A-Za-z_]\w*))?\s*;?\s*$/;
  for (const f of files) {
    if (f.source.length > 2_000_000 || !/\.get(?:<[^>]*>)?\(\s*["']/.test(f.source)) continue;
    const lines = f.source.split("\n");
    lines.forEach((l, i) => {
      if (l.length > MAX_LINE || COMMENT.test(l)) return;
      const m = CFG.exec(l);
      if (!m) return;
      const [key, field] = m[3] ? [m[2], m[3]] : [m[2].split(".").slice(0, -1).pop(), m[2].split(".").pop()];
      if (!key || !field) return;
      const cands = (binds.get(field) ?? []).filter((c) => c.obj === key);
      if (cands.length !== 1) return;
      const b = cands[0];
      const ver = b.numeric || /^\d/.test(b.version) ? `v${b.version}` : b.version;
      const prov = providers.find((p) => p.versionToken!.test(ver) && (p.versionEvidence ? p.versionEvidence.test(b.source) : true));
      if (!prov) return;
      // The name goes into a URL within the next lines (`${base}/${version}/…`, base + '/' + version)
      const use = new RegExp(`\\$\\{\\s*${m[1]}\\s*\\}|\\+\\s*${m[1]}\\b`);
      if (!lines.slice(i + 1, i + 6).some((x) => use.test(x) && /\/|https?:/.test(x))) return;
      add({ provider: prov.id, kind: "version-pin", lang: f.lang, file: f.rel, line: i + 1, apiVersion: `setter: ${ver}`, confidence: "likely", snippet: l.trim().slice(0, 200), reason: `${key}.${field} is ${ver} (${b.file}:${b.line})` });
    });
  }
  // 3. Uses of those holders in other files that import them (getBaseUrl(shop), META.API_URL + '/…')
  // v12: a holder resolves only through an import whose path leads to the module that defines it. A local declaration
  // of the same name, a this./self. method, another package's export, an export list, or an unresolvable path: skipped
  // Files the prefilter skipped can use a holder too: read them once, only when there are holders
  const useFiles = holders.length && moreFiles ? [...files, ...moreFiles().filter((m) => holders.some((h) => m.source.includes(h.name)))] : files;
  for (const h of holders) {
    for (const f of useFiles) {
      if (f.rel === h.file || !f.source.includes(h.name) || f.source.length > 2_000_000) continue;
      // Call map: an import that leads to the holder's module, through re-exports and multi-line imports
      const exact = resolveImport?.(f.rel, h.name);
      // Ruby has no imports: a holder named through its modules (Fb::Config::GRAPH_URL), when only one holder has the name
      const rbQualified = f.lang === "rb" && h.file.endsWith(".rb") && holders.filter((x) => x.name === h.name).length === 1 && new RegExp(`::${esc(h.name)}\\b`).test(f.source);
      const via = rbQualified ? `::${h.name}` : exact ? (exact.file === h.file ? h.name : undefined) : importedVia(f.source, f.rel, h.file, h.name);
      if (!via) continue;
      const lines = f.source.split("\n");
      // Lines inside a multi-line import (from x import (\n  NAME,\n) / import {\n NAME,\n} from …) aren't uses
      const inImport = new Set<number>();
      for (let r = 0, open = false; r < lines.length; r++) {
        if (open) {
          inImport.add(r);
          if (/[)}]/.test(lines[r])) open = false;
        } else if (/^\s*(?:from\s+[\w.]+\s+import\s*\(|import\s*(?:type\s+)?\{|export\s*\{)[^)}]*$/.test(lines[r])) open = true;
      }
      const use = via.startsWith("::")
        ? new RegExp(`::${esc(h.name)}\\b`)
        : via === h.name
        ? new RegExp(`(?<![\\w$.])${esc(h.name)}\\b\\s*(?:\\(|\\+|\\}|\`|,|\\))`)
        : new RegExp(`(?<![\\w$.])${esc(via)}\\??\\.${esc(h.name)}\\b`);
      const i = lines.findIndex((l, n) => !inImport.has(n) && l.length <= MAX_LINE && !COMMENT.test(l) && !/^\s*(import\b|from\b|export\s*(\{|\*)|const\s*\{[^}]*\}\s*=\s*require)/.test(l) && use.test(l));
      const useKey = `${f.rel}|${h.provider}|${h.version}`;
      if (i < 0) continue;
      if (usedIn.has(useKey)) {
        // the file's usage of that version: this is one more of its lines
        const u = fileUse.get(useKey);
        if (u && u.line !== i + 1) u.alsoLines = [...new Set([...(u.alsoLines ?? []), i + 1])].sort((x, y) => x - y);
        continue;
      }
      usedIn.add(useKey);
      const hu: Usage = { provider: h.provider, kind: "version-pin", lang: f.lang, file: f.rel, line: i + 1, apiVersion: `url: ${h.version}`, confidence: "likely", snippet: lines[i].trim().slice(0, 200), reason: `${h.name} (${h.file}) holds a ${h.version} URL` };
      fileUse.set(useKey, hu);
      add(hu);
    }
  }
  // 4. v12, Ruby configuration blocks: ShopifyApp.configure do |config| config.api_version = "2025-10" end, then
  // ShopifyApp.configuration.api_version wherever it's read (Ruby resolves the constant without an import)
  const rbAll = [...files, ...(moreFiles ? moreFiles() : [])].filter((f) => f.lang === "rb" && f.source.length <= 2_000_000);
  for (const f of rbAll) {
    for (const m of f.source.matchAll(/\b([A-Z]\w*(?:::[A-Z]\w*)*)\.configure\s+do\s*\|\s*(\w+)\s*\|/g)) {
      const startRow = f.source.slice(0, m.index).split("\n").length - 1;
      const lines = f.source.split("\n");
      const ind = /^\s*/.exec(lines[startRow])![0].length;
      for (let r = startRow; r < Math.min(lines.length, startRow + 80); r++) {
        // The block ends at the `end` level with the configure line
        if (r > startRow && /^\s*end\b/.test(lines[r]) && /^\s*/.exec(lines[r])![0].length === ind) break;
        const a = new RegExp(`\\b${m[2]}\\.(\\w+)\\s*=\\s*["'](${tokens})["']`).exec(lines[r]);
        if (!a) continue;
        const prov = providers.find((p) => p.versionToken!.test(a[2]) && (p.versionEvidence?.test(f.rel) || p.versionEvidence?.test(m[1]) || p.versionEvidence?.test(f.source)));
        if (!prov) continue;
        add({ provider: prov.id, kind: "version-pin", lang: "rb", file: f.rel, line: r + 1, apiVersion: `const: ${a[2]}`, confidence: "likely", snippet: lines[r].trim().slice(0, 200) });
        const chain = new RegExp(`\\b${esc(m[1])}\\.(?:configuration|config)\\.${a[1]}\\b`);
        for (const g of rbAll) {
          if (!chain.test(g.source)) continue;
          const gl = g.source.split("\n");
          // The same file counts too (ShopifyAPI::Context.setup(api_version: ShopifyApp.configuration.api_version) in the initializer)
          const i = gl.findIndex((l, n) => !/^\s*#/.test(l) && chain.test(l) && (g.rel !== f.rel || n !== r));
          const useKey = `${g.rel}|${prov.id}|${a[2]}`;
          if (i < 0 || usedIn.has(useKey)) continue;
          usedIn.add(useKey);
          add({ provider: prov.id, kind: "version-pin", lang: "rb", file: g.rel, line: i + 1, apiVersion: `url: ${a[2]}`, confidence: "likely", snippet: gl[i].trim().slice(0, 200), reason: `${m[1]}.configuration.${a[1]} is set to ${a[2]} in ${f.rel}` });
        }
      }
    }
  }
  // 5. A request whose URL interpolates a name bound to its provider's version in the same file
  // (`${this._baseUrl}/${this._version}/me` with `private _version = 'v21.0'`), also when the URL starts on the line
  // after the call opens: the request carries that version
  const byRel = new Map(files.map((f) => [f.rel, f]));
  const NAMES = /\$\{\s*(?:this\.|self\.)?([A-Za-z_$][\w$]*)\s*\}|\{\s*(?:self\.)?([A-Za-z_]\w*)\s*\}/g;
  for (const [key, reqs] of requestsAt) {
    const [rel, ln] = [key.slice(0, key.lastIndexOf("|")), +key.slice(key.lastIndexOf("|") + 1)];
    const f = byRel.get(rel);
    if (!f || f.source.length > 2_000_000) continue;
    const ls = f.source.split("\n");
    const own = ls[ln - 1] ?? "";
    const text = /[(,]\s*$/.test(own) ? own + " " + (ls[ln] ?? "") : own;
    if (text.length > 2 * MAX_LINE) continue;
    for (const m of text.matchAll(NAMES)) {
      const name = m[1] ?? m[2];
      const b = (binds.get(name) ?? []).filter((c) => c.file === rel && !c.numeric).pop();
      if (!b) continue;
      for (const r of reqs) {
        const p = providers.find((x) => x.id === r.provider);
        if (r.apiVersion || !p || !p.versionToken!.test(b.version)) continue;
        onBinding(b, b.version, p.id, f.lang, ln);
        traceStart({ provider: p.id, kind: "version-pin", lang: f.lang, file: rel, line: ln, apiVersion: `url: ${b.version}`, ...(r.op ? { op: r.op } : {}), confidence: "likely", snippet: own.trim().slice(0, 200), reason: `${name} (${b.file}:${b.line}) is ${b.version}` });
      }
    }
  }
  return out;
}

/** The name of a parenthesized module-level binding (NAME = ( … )) that a line sits inside, within 8 lines */
function parenBinding(lines: string[], row: number): string | undefined {
  let depth = 0;
  for (let r = row; r >= Math.max(0, row - 8); r--) {
    const t = lines[r];
    if (t.length > MAX_LINE) return undefined;
    if (r < row) depth += (t.match(/\(/g) ?? []).length - (t.match(/\)/g) ?? []).length;
    const m = /^([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*\(\s*$/.exec(t);
    if (m && r < row && depth > 0) return m[1];
    if (r < row && /^\S/.test(t) && !m) return undefined;
  }
  return undefined;
}

/** The function a line is in: function name(, def name(, name(…) {, name = (…) => */
function enclosingFunctionName(lines: string[], row: number): string | undefined {
  for (let r = row; r >= Math.max(0, row - 60); r--) {
    const m = /\b(?:function|def)\s+([A-Za-z_]\w*)|^\s*(?:export\s+)?(?:async\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?\(?[^)]*\)?\s*=>|^\s*(?:public|private|protected|static|async|\s)*([A-Za-z_]\w*)\s*\([^)]*\)\s*(?::\s*[\w<>[\]|]+\s*)?\{/.exec(lines[r]);
    const n = m?.[1] ?? m?.[2] ?? m?.[3];
    if (n && !/^(if|for|while|switch|catch|return)$/.test(n)) return n;
  }
  return undefined;
}

/**
 * v12: how `useFile` reaches `name` defined in `defFile`: `name` itself (import { name } from './x'), or the local name
 * of an object imported from it (import { META } from './x' → "META", const config = require('../config') → "config").
 * Only imports whose path resolves to defFile count; a local declaration of `name` rules the file out.
 */
export function importedVia(source: string, useFile: string, defFile: string, name: string): string | undefined {
  const n = esc(name);
  // Declared here (a function, a const, a method): this file's own `name`
  if (new RegExp(`(?:\\bfunction\\s*\\*?\\s+|\\bdef\\s+|\\b(?:const|let|var)\\s+)${n}\\b|^[ \\t]*(?:(?:public|private|protected|static|async|override)\\s+)*${n}\\s*\\([^)]*\\)\\s*(?::[^{=;]*)?\\{`, "m").test(source)) return undefined;
  const imports: { names: string[]; spec: string; ns?: string }[] = [];
  for (const m of source.matchAll(/\bimport\s+(?:type\s+)?(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+(\w+))?\s*from\s*["']([^"']+)["']/g)) {
    imports.push({ names: [m[1], ...(m[2] ?? "").split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!)].filter(Boolean) as string[], spec: m[4], ns: m[3] });
  }
  for (const m of source.matchAll(/\b(?:const|let|var)\s+(?:\{([^}]*)\}|(\w+))\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g)) {
    imports.push({ names: m[1] ? m[1].split(",").map((s) => s.trim().split(/\s*:\s*/).pop()!) : [m[2]], spec: m[3], ns: m[2] });
  }
  for (const m of source.matchAll(/^[ \t]*from\s+([\w.]+)\s+import\s+\(?([^)\n]*)/gm)) imports.push({ names: m[2].split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!), spec: m[1] });
  const resolves = (spec: string) => resolvesTo(spec, useFile, defFile);
  for (const im of imports) {
    if (!resolves(im.spec)) continue;
    if (im.names.includes(name)) return name;
    // An object (or namespace) from that module: its property holds the URL
    const obj = im.ns ?? im.names.find((x) => new RegExp(`(?<![\\w$.])${esc(x)}\\??\\.${n}\\b`).test(source));
    if (obj) return obj;
  }
  return undefined;
}

/** Does an import path written in useFile lead to defFile? Relative paths are resolved; others must be unambiguous suffixes */
function resolvesTo(spec: string, useFile: string, defFile: string): boolean {
  const target = defFile.replace(/\.[^./]+$/, "");
  const candidates = [target, target.replace(/\/index$/, ""), target.replace(/\/__init__$/, "")];
  if (spec.startsWith(".")) {
    // JS ./x ../x, and Python relative imports (.x, ..x)
    const dir = useFile.split("/").slice(0, -1);
    let rest = spec;
    if (/^\.+[\w]/.test(spec) && !spec.includes("/")) {
      const dots = /^\.+/.exec(spec)![0].length;
      rest = "../".repeat(dots - 1) + "./" + spec.slice(dots).replace(/\./g, "/");
    }
    const parts = [...dir];
    for (const seg of rest.replace(/\.(m?[jt]sx?|py|rb)$/, "").split("/")) {
      if (seg === "..") parts.pop();
      else if (seg !== "." && seg) parts.push(seg);
    }
    return candidates.includes(parts.join("/"));
  }
  // An alias (@/lib/x, ~/lib/x, src/lib/x) or a Python dotted path: the definition must end with it
  const tail = spec.replace(/^(@|~|#)\//, "").replace(/\./g, spec.includes("/") ? "." : "/").replace(/\.(m?[jt]sx?|py|rb)$/, "");
  if (/^@[\w-]+\/[\w-]+$/.test(spec) || !tail.includes("/")) return false;
  return candidates.some((c) => c === tail || c.endsWith(`/${tail}`));
}

/** The module this file imports `name` from (ES import, require, Python from-import), as written */
function importSpec(source: string, name: string): string | undefined {
  const n = esc(name);
  const m = new RegExp(`\\bimport\\b[^;]*?\\b${n}\\b[^;]*?\\bfrom\\s*["']([^"']+)["']`).exec(source)
    ?? new RegExp(`\\b${n}\\b[^\\n]*=\\s*require\\(\\s*["']([^"']+)["']`).exec(source)
    ?? new RegExp(`\\bfrom\\s+([\\w.]+)\\s+import\\b[^\\n]*\\b${n}\\b`).exec(source);
  return m?.[1].replace(/\./g, (d, i, str) => (str.includes("/") ? d : "/"));
}

/**
 * v9: a version list whose first entry the code takes as its default (`'api_version' => current(self::versions())`,
 * `VERSIONS[0]`): that entry isn't a catalog but the version the app uses, so it fails a check like a constant; the
 * others stay a catalog. Each place that takes the first entry is reported with that version too.
 */
const FIRST_OF = (name: string) =>
  new RegExp(String.raw`(?:\bcurrent|\breset|\bhead|Arr::first|\barray_shift)\(\s*(?:(?:self|static|[\w\\]+)::${name}\(\s*\)|\$(\w+)\s*\))|(?:(?:self|static|[\w\\]+)::|\b)${name}(?:\(\s*\))?\s*(?:\[\s*0\s*\]|\.get\(\s*0\s*\)|\.getFirst\(\s*\)|\.First(?:OrDefault)?\(\s*\)|\.first\b)|\bnext\(\s*iter\(\s*${name}\s*\)`);
export function firstVersionDefaults(files: { rel: string; lang: Usage["lang"]; source: string }[], usages: Usage[], selected: Set<string>): Usage[] {
  const listed = usages.filter((u) => u.reason === "a list of API versions" && u.apiVersion);
  if (!listed.length || !selected.size) return [];
  const byFile = new Map<string, Usage[]>();
  for (const u of listed) byFile.set(u.file, [...(byFile.get(u.file) ?? []), u]);
  const text = new Map(files.map((f) => [f.rel, f.source]));
  const lists: { name: string; provider: string; version: string }[] = [];
  const ver = (u: Usage) => u.apiVersion!.split(": ").pop()!;
  for (const [file, us] of byFile) {
    const lines = (text.get(file) ?? "").split("\n");
    us.sort((a, b) => a.line - b.line || (lines[a.line - 1] ?? "").indexOf(ver(a)) - (lines[b.line - 1] ?? "").indexOf(ver(b)));
    // Blocks of nearby list entries, each with the name that holds it (a function, a constant, a variable)
    for (let i = 0; i < us.length; ) {
      let j = i;
      while (j + 1 < us.length && us[j + 1].line - us[j].line <= WINDOW) j++;
      const first = us[i];
      let name: string | undefined;
      for (let r = first.line - 1; r >= Math.max(0, first.line - 7) && !name; r--) {
        const l = lines[r] ?? "";
        name = /\b(?:function|def)\s+(?:self\.)?(\w+)\s*[(\n]?/.exec(l)?.[1]
          ?? /(?:^|\b(?:const|let|var|static|public|private|protected)\s+)\$?([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*[[(]/.exec(l)?.[1]
          // Go []string{…}, Java List.of(…) / Arrays.asList(…), C# new[] { … } / new List<string> { … }, Ruby %w[…] / [ … ].freeze
          ?? /\b([A-Za-z_]\w*)\s*(?::=|=)\s*(?:\[\]\w+\s*\{|new\s*(?:[\w<>]+)?\s*\[?\]?\s*(?:\(\s*\))?\s*\{|List\.of\(|Arrays\.asList\(|%w\[|\{)/.exec(l)?.[1]
          ?? /["']?([A-Za-z_]\w*)["']?\s*:\s*\[/.exec(l)?.[1];
      }
      if (name && selected.has(name)) {
        delete first.listed;
        first.reason = `the first entry of ${name}, which the code uses as its default`;
        lists.push({ name, provider: first.provider, version: ver(first) });
      }
      i = j + 1;
    }
  }
  const out: Usage[] = [];
  const have = new Set(usages.filter((u) => u.apiVersion).map((u) => `${u.file}|${u.line}`));
  for (const f of files) {
    if (f.source.length > 2_000_000) continue;
    for (const list of lists) {
      if (!f.source.includes(list.name)) continue;
      const re = FIRST_OF(list.name);
      f.source.split("\n").forEach((l, i) => {
        if (l.length > MAX_LINE || COMMENT.test(l)) return;
        const m = re.exec(l);
        if (!m) return;
        // current($versions): only when $versions holds the list ($versions = Service::versions())
        if (m[1] && !new RegExp(String.raw`\$${m[1]}\s*=\s*(?:self|static|[\w\\]+)::${list.name}\(`).test(f.source)) return;
        if (have.has(`${f.rel}|${i + 1}`)) return;
        have.add(`${f.rel}|${i + 1}`);
        out.push({
          provider: list.provider, kind: "version-pin", lang: f.lang, file: f.rel, line: i + 1, apiVersion: `const: ${list.version}`,
          confidence: "likely", snippet: l.trim().slice(0, 200), reason: `the default version: the first entry of ${list.name}`,
        });
      });
    }
  }
  return out;
}

/** v10: version pins written through SDK setters and settings (provider data: versionSetters), in any language */
export function versionSetterUsages(path: string, lang: Usage["lang"], text: string, found: Usage[]): Usage[] {
  if (text.length > 2_000_000) return [];
  const setters = PROVIDERS.filter((p) => p.versionSetters?.length);
  if (!setters.length) return [];
  const have = new Set(found.filter((u) => u.apiVersion).map((u) => `${u.line}|${u.apiVersion!.split(": ").pop()}`));
  const lines = text.split("\n");
  const out: Usage[] = [];
  // Prose strings (an error or help message naming ApiVersion.July26) aren't settings: their spans, in code files
  let prose: [number, number][] | undefined;
  const lineStart: number[] = [];
  const inProse = (row: number, col: number) => {
    if (lang === "config" || lang === "notebook") return false;
    if (!prose) {
      prose = [];
      for (const m of text.matchAll(/`(?:\\[\s\S]|[^\\`])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g)) if (m[0].length >= 40 && /\s\S+\s/.test(m[0])) prose.push([m.index!, m.index! + m[0].length]);
      let at = 0;
      for (const l of lines) {
        lineStart.push(at);
        at += l.length + 1;
      }
    }
    const off = lineStart[row] + col;
    return prose.some(([a, b]) => off > a && off < b);
  };
  for (const p of setters) {
    for (const s of p.versionSetters!) {
      if (s.ident || (s.needs && !s.needs.test(text))) continue;
      lines.forEach((l, i) => {
        if (l.length > MAX_LINE) return;
        // v15: a call split over lines (GraphAPI(\n access_token=t, version="3.0")): the setter starts on this line
        let m = s.re.exec(l);
        if (!m && /\($|\(\s*[\w"'=,\s]*$/.test(l)) {
          const joined = [l, ...lines.slice(i + 1, i + 5)].join(" ");
          const j = s.re.exec(joined);
          if (j && j.index < l.length) m = j;
        }
        if (!m || (m.index < l.length && inProse(i, m.index))) return;
        const version = s.fmt ? s.fmt(m) : m[1];
        if (have.has(`${i + 1}|${version}`)) return;
        have.add(`${i + 1}|${version}`);
        out.push({
          provider: p.id, kind: "version-pin", lang, file: path, line: i + 1, apiVersion: `setter: ${version}`, confidence: "likely",
          snippet: l.trim().slice(0, 200), ...(COMMENT.test(l) ? { doc: true } : {}),
        });
      });
    }
  }
  return out;
}

/**
 * v14: a module that sets the version on a client and exports it (graph.setVersion('7.0'); module.exports = graph):
 * the modules that import that client call the API at that version too, so each is reported where it first uses it
 */
export function setterModuleUsers(files: { rel: string; lang: Usage["lang"]; source: string }[], usages: Usage[]): Usage[] {
  const out: Usage[] = [];
  const text = new Map(files.map((f) => [f.rel, f]));
  const have = new Set(usages.filter((u) => u.apiVersion).map((u) => `${u.file}|${u.provider}|${u.apiVersion!.split(": ").pop()}`));
  for (const u of usages) {
    if (!u.apiVersion?.startsWith("setter: ") || !["js", "ts", "py"].includes(u.lang)) continue;
    const f = text.get(u.file);
    if (!f) continue;
    const recv = /^\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\./.exec(f.source.split("\n")[u.line - 1] ?? "")?.[1];
    if (!recv) continue;
    const r = esc(recv);
    const asDefault = new RegExp(`\\bmodule\\.exports\\s*=\\s*${r}\\b|\\bexport\\s+default\\s+${r}\\b`).test(f.source);
    const asNamed = new RegExp(`\\bexport\\s+(?:const|let|var)\\s+${r}\\b|\\bexport\\s*\\{[^}]*\\b${r}\\b|\\b(?:module\\.)?exports\\.${r}\\s*=`).test(f.source) || (f.lang === "py" && new RegExp(`^${r}\\s*=`, "m").test(f.source));
    if (!asDefault && !asNamed) continue;
    const version = u.apiVersion.slice("setter: ".length);
    for (const g of files) {
      if (g.rel === f.rel || g.source.length > 2_000_000 || !/\b(?:import|require|from)\b/.test(g.source)) continue;
      const locals: string[] = [];
      for (const m of g.source.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*["']([^"']+)["']\s*\)|\bimport\s+(\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*["']([^"']+)["']/g)) {
        if (asDefault && resolvesTo(m[2] ?? m[4], g.rel, f.rel)) locals.push(m[1] ?? m[3]);
      }
      for (const m of g.source.matchAll(/\bimport\s*(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']|^[ \t]*from\s+([\w.]+)\s+import\s+\(?([^)\n]*)/gm)) {
        const spec = m[2] ?? m[3];
        if (!asNamed || !resolvesTo(spec, g.rel, f.rel)) continue;
        for (const n of (m[1] ?? m[4]).split(",")) {
          const [name, alias] = n.trim().split(/\s+as\s+/);
          if (name === recv) locals.push(alias ?? name);
        }
      }
      if (!locals.length) continue;
      const lines = g.source.split("\n");
      const use = new RegExp(`(?<![\\w$.])(?:${locals.map(esc).join("|")})\\s*\\.\\s*\\w+\\s*\\(`);
      const i = lines.findIndex((l) => l.length <= MAX_LINE && !COMMENT.test(l) && !/^\s*(import\b|from\b)|\brequire\(/.test(l) && use.test(l));
      const key = `${g.rel}|${u.provider}|${version}`;
      if (i < 0 || have.has(key)) continue;
      have.add(key);
      out.push({ provider: u.provider, kind: "version-pin", lang: g.lang, file: g.rel, line: i + 1, apiVersion: `setter: ${version}`, confidence: "likely", snippet: lines[i].trim().slice(0, 200), reason: `${recv} from ${f.rel}, which sets version ${version}` });
    }
  }
  return out;
}
