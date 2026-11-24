/**
 * v11: generated fluent SDK clients (Kiota and its predecessors), where the call chain is the request path:
 *   JS      client.api('/security/alerts').get()                     → GET /v1.0/security/alerts
 *   Python  client.users.by_user_id(uid).messages.get()              → GET /v1.0/users/{id}/messages
 *   C#      client.Users["id"].Messages.GetAsync()                   → GET /v1.0/users/{id}/messages
 *   Java    client.users().byUserId(uid).messages().get()
 *   Go      client.Users().ByUserId(uid).Messages().Get(ctx, nil)
 *   PHP     $graph->users()->byUserId($uid)->messages()->get()
 * Data-driven per provider (FLUENT): the SDK's marks in a file, how a client is made, the base version and the beta
 * package. Text-based, so it works the same in every language.
 */
import type { Usage } from "../types.js";

type Fluent = {
  provider: string;
  /** The file uses this provider's fluent SDK */
  marks: RegExp;
  /** A name holding a client: `client = GraphServiceClient(…)`, `GraphServiceClient c`, `$graph = new GraphServiceClient(…)` */
  client: RegExp;
  /** Classic path client: client.api('/path') */
  apiCall?: boolean;
  version: string;
  beta?: { marks: RegExp; version: string };
};
const FLUENT: Fluent[] = [
  {
    provider: "msgraph",
    marks: /GraphServiceClient|@microsoft\/microsoft-graph-client|@microsoft\/msgraph-sdk|\bmsgraph\b|Microsoft\.Graph\b|com\.microsoft\.graph|microsoftgraph\/msgraph-sdk|microsoft\/microsoft-graph/,
    client: /(?:^|[\s(,])(?:(?:var|let|const|final|private|public|protected|readonly|static)\s+)*(?:GraphServiceClient\s+)?(\$?@?[A-Za-z_]\w*)(?:\s*,\s*_?\w*)?\s*(?::=|=|:)\s*(?:await\s+)?(?:new\s+)?(?:[\w.\\]*\b(?:GraphServiceClient|NewGraphServiceClient\w*|Client\.init|Client\.initWithMiddleware|createWithRequestContext|GraphClient))\b|\bGraphServiceClient\s+(\$?[A-Za-z_]\w*)\b/g,
    apiCall: true,
    version: "v1.0",
    beta: { marks: /msgraph-beta|Microsoft\.Graph\.Beta|com\.microsoft\.graph\.beta|msgraph-beta-sdk|defaultVersion\s*:\s*["']beta["']/, version: "beta" },
  },
];

const VERB: Record<string, string> = { get: "GET", post: "POST", create: "POST", patch: "PATCH", update: "PATCH", put: "PUT", delete: "DELETE", del: "DELETE" };
const lowerFirst = (s: string) => s[0].toLowerCase() + s.slice(1);
const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const SKIP = new Set(["request", "buildRequest", "withUrl", "api", "toGetRequestInformation", "toPostRequestInformation"]);

/** The path a chain describes: users().byUserId(x).messages() → /users/{id}/messages */
function pathOf(chain: string): string | undefined {
  const segs: string[] = [];
  for (const m of chain.matchAll(/(?:\.|->)\s*([A-Za-z_]\w*)\s*(\([^()]*\))?|\[([^\]]*)\]/g)) {
    if (m[3] !== undefined) {
      segs.push("{id}");
      continue;
    }
    const name = m[1];
    if (SKIP.has(name)) continue;
    if (/^by_?[A-Za-z]/.test(name) && /id$/i.test(name.replace(/_/g, ""))) {
      segs.push("{id}");
      continue;
    }
    if (/^item$/i.test(name) && m[2]) {
      segs.push("{id}");
      continue;
    }
    segs.push(lowerFirst(camel(name)));
  }
  return segs.length ? "/" + segs.join("/") : undefined;
}

export function fluentUsages(file: string, lang: Usage["lang"], source: string): Usage[] {
  if (source.length > 2_000_000) return [];
  const out: Usage[] = [];
  const lines = source.split("\n");
  for (const f of FLUENT) {
    if (!f.marks.test(source)) continue;
    const version = f.beta && f.beta.marks.test(source) ? f.beta.version : f.version;
    const names = new Set<string>();
    for (const m of source.matchAll(f.client)) {
      const n = (m[1] ?? m[2])?.replace(/^@/, "");
      if (n && !/^(new|await|return|var|let|const)$/.test(n)) names.add(n);
    }
    const esc = [...names].map((n) => n.replace(/[$]/g, "\\$"));
    const chain = esc.length
      ? new RegExp(`(?<![\\w$])(?:this\\.|self\\.|@|\\$this->)?(?:${esc.join("|")})((?:\\s*(?:\\.|->)\\s*[A-Za-z_]\\w*\\s*(?:\\([^()]*\\))?|\\[[^\\]]*\\])+?)\\s*(?:\\.|->)\\s*(get|post|patch|put|delete|create|update)(?:Async)?\\s*\\(`, "gi")
      : undefined;
    const seen = new Set<string>();
    lines.forEach((l, i) => {
      if (l.length > 2000 || /^\s*(\/\/|#|\*)/.test(l)) return;
      const add = (op: string, snippet: string) => {
        if (seen.has(`${i}|${op}`)) return;
        seen.add(`${i}|${op}`);
        out.push({ provider: f.provider, kind: "sdk", lang, file, line: i + 1, op, sdkCall: op, params: [], confidence: "likely", snippet: snippet.trim().slice(0, 200) });
      };
      if (f.apiCall) {
        for (const m of l.matchAll(/\.api\(\s*["'`]([^"'`]+)["'`]\s*\)((?:\s*\.\s*\w+\([^)]*\))*?)\s*\.\s*(get|post|patch|put|delete|update|create)\s*\(/gi)) {
          let path = m[1].split("?")[0].replace(/\$\{[^}]*\}|\{[^}]*\}/g, "{id}").replace(/\/+$/, "");
          const v = /^\/(v1\.0|beta)(\/|$)/.exec(path);
          const ver = v ? v[1] : /\.version\(\s*["']beta["']\s*\)/.test(m[2]) ? "beta" : version;
          if (v) path = path.slice(v[0].length - 1) || "/";
          if (!path.startsWith("/")) path = "/" + path;
          add(`${VERB[m[3].toLowerCase()]} /${ver}${path}`, l);
        }
      }
      if (chain) {
        for (const m of l.matchAll(chain)) {
          if (/\.api\s*\(/.test(m[1])) continue;
          const path = pathOf(m[1]);
          const verb = VERB[m[2].toLowerCase()];
          if (path && verb) add(`${verb} /${version}${path}`, l);
        }
      }
    });
  }
  return out;
}
