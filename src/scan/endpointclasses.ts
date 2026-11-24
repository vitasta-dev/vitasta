/**
 * An SDK's endpoint classes (RageAgainstThePixel/OpenAI-DotNet): a base class with an abstract path property that
 * its URL method puts into the route, and subclasses that set it:
 *   abstract class OpenAIBaseEndpoint { protected abstract string Root { get; }
 *     protected string GetUrl(string endpoint = "") => … $"{Root}{endpoint}" … }
 *   class AssistantsEndpoint : OpenAIBaseEndpoint { protected override string Root => "assistants";
 *     … PostAsync(GetUrl($"/{assistantId}"), …) }
 * plus the provider's host and API version as literals in the repo (const string Domain = "api.openai.com";
 * const string ApiVersion = "v1"). Each override is an endpoint (* /v1/assistants), each call of the URL method with
 * an HTTP verb on its line an operation (POST /v1/assistants/{id}). C#, Java and TypeScript.
 */
import { matchUrl } from "../providers.js";
import type { Usage } from "../types.js";

type Files = { rel: string; lang: Usage["lang"]; source: string }[];
const VERB = /\b(Post|Get|Put|Patch|Delete)(?:Async|Request|Json)?\s*\(|HttpMethod\.(Post|Get|Put|Patch|Delete)\b|\.(post|get|put|patch|delete)\s*\(/;

export function endpointClassUsages(files: Files, found: Usage[]): Usage[] {
  const code = files.filter((f) => (f.lang === "cs" || f.lang === "java" || f.lang === "ts") && f.source.length <= 2_000_000);
  // the provider host and version, as literals anywhere in the repo's code
  // (a file that holds both, like OpenAISettings, is preferred over a host named elsewhere)
  let host: string | undefined, version: string | undefined;
  for (const f of code) {
    const h = [...f.source.matchAll(/["']((?:[a-z0-9-]+\.)+[a-z]{2,})["']/g)].map((m) => m[1]).find((x) => matchUrl(`https://${x}/`));
    if (!h) continue;
    const ver = /\b\w*Version\w*\s*=\s*["'](v\d+)["']/i.exec(f.source)?.[1];
    if (ver) { host = h; version = ver; break; }
    host ??= h;
  }
  if (!host) return [];
  // base classes: an abstract string property, put into a route by one of the class's methods
  const bases: { cls: string; prop: string; method: string }[] = [];
  for (const f of code) {
    for (const p of f.source.matchAll(/\babstract\s+(?:override\s+)?(?:string|String)\s+([A-Z]?\w+)\s*(?:\{\s*get;\s*\}|;|\()/g)) {
      const prop = p[1];
      const cls = [...f.source.slice(0, p.index!).matchAll(/\bclass\s+(\w+)/g)].pop()?.[1];
      if (!cls) continue;
      const routeUse = new RegExp(`\\{\\s*(?:this\\.)?${prop}(?:\\(\\))?\\s*\\}|\\+\\s*(?:this\\.)?${prop}(?:\\(\\))?\\b`);
      if (!routeUse.test(f.source)) continue;
      // the method that takes the endpoint path (GetUrl(string endpoint = "")): any method whose body reaches the route
      for (const m of f.source.matchAll(/\b(?:protected|public|internal|private)?\s*(?:static\s+)?(?:string|String|Uri|URI)\s+(\w+)\s*\(\s*(?:string|String)\s+\w+/g)) bases.push({ cls, prop, method: m[1] });
    }
  }
  if (!bases.length) return [];
  const have = new Set(found.map((u) => `${u.file}|${u.line}|${u.op}`));
  const out: Usage[] = [];
  const lineAt = (s: string, at: number) => s.slice(0, at).split("\n").length;
  const v = version ?? "v1";
  for (const b of bases) {
    for (const f of code) {
      for (const c of f.source.matchAll(new RegExp(`\\bclass\\s+(\\w+)[^{;]*?[:\\s](?:extends\\s+)?${b.cls}\\b[^{;]*\\{`, "g"))) {
        const start = c.index!;
        const root = new RegExp(`\\boverride\\s+(?:string|String)\\s+${b.prop}\\s*(?:=>|\\{\\s*get\\s*(?:=>|\\{\\s*return))\\s*["']([\\w/-]+)["']`).exec(f.source.slice(start));
        if (!root) continue;
        const seg = root[1].replace(/^\//, "");
        const at = start + root.index!;
        const lines = f.source.split("\n");
        const hit = matchUrl(`https://${host}/${v}/${seg}`);
        if (!hit) continue;
        const rl = lineAt(f.source, at);
        const op = `* ${hit.path}`;
        if (!have.has(`${f.rel}|${rl}|${op}`)) {
          have.add(`${f.rel}|${rl}|${op}`);
          out.push({
            provider: hit.provider.id, kind: "http", lang: f.lang, file: f.rel, line: rl, op, confidence: "likely",
            snippet: (lines[rl - 1] ?? "").trim().slice(0, 200), reason: `${c[1]}.${b.prop} is "${root[1]}": every ${b.cls}.${b.method}() call in it goes to ${hit.path} on ${host}`, endpointRoot: c[1],
          });
        }
        // the calls of the URL method in the class, with the verb on the same line
        const next = f.source.slice(start + 1).search(/\n\s*(?:public|internal|private|protected)?\s*(?:sealed\s+|abstract\s+|static\s+|partial\s+)*class\s+\w+/);
        const body = f.source.slice(start, next < 0 ? f.source.length : start + 1 + next);
        for (const m of body.matchAll(new RegExp(`\\b${b.method}\\s*\\(\\s*(?:\\$?["']([^"']*)["'])?`, "g"))) {
          const l = lineAt(f.source, start + m.index!);
          const text = lines[l - 1] ?? "";
          const verb = VERB.exec(text);
          if (!verb) continue;
          const method = (verb[1] ?? verb[2] ?? verb[3]).toUpperCase();
          const suffix = (m[1] ?? "").replace(/\{[^}]*\}/g, "{id}").replace(/^(?!\/|$)/, "/");
          const h = matchUrl(`https://${host}/${v}/${seg}${suffix}`);
          if (!h) continue;
          const op2 = `${method} ${h.path}`;
          if (have.has(`${f.rel}|${l}|${op2}`)) continue;
          have.add(`${f.rel}|${l}|${op2}`);
          out.push({
            provider: h.provider.id, kind: "http", lang: f.lang, file: f.rel, line: l, op: op2, confidence: "likely",
            snippet: text.trim().slice(0, 200), reason: `${method} ${b.method}("${m[1] ?? ""}") in ${c[1]} (${b.prop} "${root[1]}") goes to ${h.path} on ${host}`, endpointCall: c[1],
          });
        }
      }
    }
  }
  return out;
}
