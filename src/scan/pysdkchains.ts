/**
 * Python: a provider SDK's resource chain on a client the file didn't build:
 * self.client.beta.assistants.create(…), self.tutor.client.beta.threads.create() with the client made by a wrapper in
 * another module. In a repo that depends on the provider's Python SDK, a call whose chain ends in one of the SDK's
 * own multi-part resource paths (its sdkOps table: beta.assistants, chat.completions.create, audio.speech.create …)
 * is that operation. One-word paths (files.create, models.list) aren't distinctive enough on an unknown receiver.
 */
import { PROVIDERS, sdkOp } from "../providers.js";
import { configuredBase } from "./baseexpr.js";
import type { Usage } from "../types.js";

type Files = { rel: string; lang: Usage["lang"]; source: string }[];

export function pythonSdkChainUsages(files: Files, manifestsText: string, found: Usage[]): Usage[] {
  const out: Usage[] = [];
  // (a model id on the same line is a finding of its own; only an operation already read there is skipped)
  const have = new Set(found.filter((u) => u.op).map((u) => `${u.file}|${u.line}`));
  const deps = PROVIDERS.filter((p) => (p.packages?.py ?? []).some((n) => new RegExp(`(?:^|[\\s"'\\[,])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[\\s"'\\]=<>~!,;\\[]|$)`, "im").test(manifestsText)));
  if (!deps.length) return out;
  // The base URL each client name is built with across the repo (self.client = OpenAI(base_url="https://gw.local/v1")):
  // a name whose every construction points at another server is a proxied client wherever it's used (reviewer
  // review of test sets). A name built without a base URL, or with a computed one, anywhere: unknown, left as is.
  const ctorBase = new Map<string, Set<string>>();
  for (const f of files) {
    if (f.lang !== "py" || f.source.length > 2_000_000 || !/\bbase_url\s*=/.test(f.source)) continue;
    for (const m of f.source.matchAll(/(?:^|[^\w.])(?:[A-Za-z_]\w*\.)*([A-Za-z_]\w*)\s*(?::\s*[\w.\[\]| ]+)?=\s*(?:\w+\.)*(?:Async)?(?:OpenAI|Anthropic|AzureOpenAI)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/gm)) {
      const b = /\bbase_url\s*=\s*["']([^"']+)["']/.exec(m[2]);
      // or built from the app's settings plus a version path (f"{self.config['gateway_url']}/v1")
      const expr = /\bbase_url\s*=\s*((?:[rRfF]{1,2})?(["'])(?:(?!\2).)*\2(?:\.format\([^()]*\))?|[\w.\[\]'"()]+\s*\+\s*(["'])[^"']*\3)/.exec(m[2])?.[1];
      const cfg = expr && !b ? configuredBase(expr, PROVIDERS.flatMap((x) => x.hosts)) : undefined;
      ctorBase.set(m[1], (ctorBase.get(m[1]) ?? new Set()).add(b ? b[1] : cfg ? `cfg:${cfg}` : "?"));
    }
  }
  for (const f of files) {
    if (f.lang !== "py" || f.source.length > 2_000_000) continue;
    for (const m of f.source.matchAll(/(?:^|[^\w.])(?:[A-Za-z_]\w*\.)*([A-Za-z_]\w*)\s*(?::\s*[\w.\[\]| ]+)?=\s*(?:\w+\.)*(?:Async)?(?:OpenAI|Anthropic|AzureOpenAI)\s*\(\s*\)/gm)) ctorBase.set(m[1], (ctorBase.get(m[1]) ?? new Set()).add("?"));
  }
  const proxyOf = (recv: string, p: (typeof PROVIDERS)[number]): string | undefined => {
    const bases = ctorBase.get(recv.split(".").pop()!);
    if (!bases || bases.has("?")) return undefined;
    const hosts = [...bases].map((u) => (u.startsWith("cfg:") ? u.slice(4) : /^https?:\/\/([^/]+)/.exec(u)?.[1]));
    if (hosts.some((h) => !h || p.hosts.some((x) => h.endsWith(x)))) return undefined;
    return new Set(hosts).size === 1 ? hosts[0] : undefined;
  };
  for (const p of deps) {
    // the SDK's multi-part resource paths, longest first
    const keys = Object.keys(p.sdkOps).filter((k) => k.includes(".") && (k.match(/\./g) ?? []).length >= 1).sort((a, b) => b.length - a.length);
    if (!keys.length) continue;
    const re = new RegExp(`\\b([A-Za-z_][\\w]*(?:\\.[A-Za-z_]\\w*)*)\\.(${keys.map((k) => k.replace(/\./g, "\\.")).join("|")})((?:\\.[a-z_]+)*)\\s*\\(`, "g");
    for (const f of files) {
      if (f.lang !== "py" || f.source.length > 2_000_000) continue;
      const lines = f.source.split("\n");
      lines.forEach((l, i) => {
        if (l.length > 2000 || /^\s*#/.test(l) || have.has(`${f.rel}|${i + 1}`)) return;
        for (const m of l.matchAll(re)) {
          // the receiver is a client (ends in a client-ish name), not the module itself
          if (!/(?:^|\.)(?:_*\w*client\w*|_*\w*api\w*|_*\w*openai\w*|_*\w*anthropic\w*|_*llm\w*)$/i.test(m[1])) continue;
          const op = sdkOp(p, `${m[2]}${m[3]}`);
          if (!op) continue;
          have.add(`${f.rel}|${i + 1}`);
          const proxy = proxyOf(m[1], p);
          out.push({
            ...(proxy ? { proxy } : {}),
            provider: p.id, kind: "sdk", lang: "py", file: f.rel, line: i + 1, op, confidence: "likely", sdkCall: `${m[2]}${m[3]}`,
            snippet: l.trim().slice(0, 200), reason: `${m[1]}.${m[2]}${m[3]}(…): the ${p.id} SDK's ${m[2]} resource on a client held elsewhere`,
          });
          break;
        }
      });
    }
  }
  return out;
}
