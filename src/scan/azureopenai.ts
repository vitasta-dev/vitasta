/**
 * Azure OpenAI (provider "azure-openai", src/providers/azure-openai.json): the Azure-hosted OpenAI API has its own
 * paths and its own retirements (/openai/assistants sunset, On Your Data's data_sources, the Realtime preview), apart
 * from OpenAI's. Raw HTTP to *.openai.azure.com / *.cognitiveservices.azure.com / *.services.ai.azure.com (path
 * /openai/…) is found by the provider's hosts. This module covers the SDKs:
 *
 *  - the `openai` package's AzureOpenAI / AsyncAzureOpenAI (TS/JS, Python), which the OpenAI provider's call
 *    analysis already reads as an OpenAI call on host azure: each of its calls with an operation is also an
 *    azure-openai call on the Azure path (/v1/assistants → /openai/assistants, /v1/chat/completions →
 *    /openai/deployments/{deployment}/chat/completions), and the OpenAI-path copy keeps its model but loses the
 *    operation, since OpenAI's endpoint records don't apply to Azure. Python's extra_body={"data_sources": …} and the
 *    C# / Java / Go options that add a data source count as the data_sources parameter;
 *  - Azure.AI.OpenAI (C#), com.azure:azure-ai-openai (Java) and azopenai (Go): their client methods by name
 *    (src/providers/azure-openai.json sdkOps), in files that import the package;
 *  - a Realtime URL string (wss://….openai.azure.com/openai/realtime?api-version=…-preview) in any language.
 * A plain api.openai.com call and a non-OpenAI host of Azure give nothing here.
 */
import { providerById } from "../providers.js";
import type { Usage } from "../types.js";

type Files = { rel: string; lang: Usage["lang"]; source: string }[];
const AZ = "azure-openai";
const FILE_SDK: Partial<Record<Usage["lang"], RegExp>> = {
  cs: /\bAzure\.AI\.OpenAI\b|\bAzureOpenAIClient\b/,
  java: /\bcom\.azure\.ai\.openai\b/,
  go: /\bsdk\/ai\/azopenai\b/,
};
/** A data source added to the chat request (On Your Data): the parameter data_sources, whatever the SDK calls it */
const DATA_SOURCE = /\bdata_sources\b|\bAddDataSource\s*\(|\bDataSources\b|\bsetDataSources\s*\(|\bAzureExtensionsOptions\b|\bAzureSearchChatDataSource\b/;
/** Calls that take a deployment name (the model slot): OpenAI-path operations that become deployment-scoped on Azure */
const DEPLOYMENT_SCOPED = /^\/v1\/(?:chat\/completions|completions|embeddings|images\/(?:generations|edits)|audio\/(?:transcriptions|translations|speech))$/;

/** An OpenAI path as its Azure path */
export function azureOpPath(path: string): string | undefined {
  if (!/^\/v1\//.test(path)) return undefined;
  return DEPLOYMENT_SCOPED.test(path) ? path.replace(/^\/v1\//, "/openai/deployments/{deployment}/") : path.replace(/^\/v1\//, "/openai/");
}

export function azureOpenAiUsages(kept: Usage[], files: Files, isTest: (rel: string) => boolean): Usage[] {
  const out: Usage[] = [];
  const text = new Map(files.map((f) => [f.rel, f]));
  const have = new Set<string>();
  const key = (u: Usage) => `${u.file}|${u.line}|${u.op}|${(u.params ?? []).join(",")}`;
  const lineAt = (rel: string, line: number) => text.get(rel)?.source.split("\n")[line - 1] ?? "";
  const dataSourceNear = (rel: string, line: number, before: number, after: number) => {
    const ls = text.get(rel)?.source.split("\n") ?? [];
    return DATA_SOURCE.test(ls.slice(Math.max(0, line - 1 - before), line + after).join("\n"));
  };
  const mk = (u: Usage, op: string, params?: string[]): Usage => {
    const { model, modelSpan, paramSpans, alsoLines, ...rest } = u;
    void model; void modelSpan; void paramSpans; void alsoLines;
    return { ...rest, provider: AZ, op, ...(params ? { params } : {}), host: undefined, via: undefined };
  };
  // (A) the openai package's Azure client (and C# files of the Azure SDK) read as OpenAI calls: add the Azure-path call
  for (const u of kept) {
    if (u.provider !== "openai" || u.kind !== "sdk" || !u.op) continue;
    const f = text.get(u.file);
    const isAzure = u.host === "azure" || (f && FILE_SDK[f.lang]?.test(f.source) && f.lang === "cs");
    if (!isAzure) continue;
    const [method, path] = u.op.split(" ");
    let azPath = /realtime/i.test(u.sdkCall ?? "") ? "/openai/realtime" : azureOpPath(path);
    if (!azPath) continue;
    const params = [...(u.params ?? [])];
    const chat = /\/chat\/completions$/.test(azPath);
    // Python passes it inside extra_body, the typed SDKs through an options object built a few lines up
    // (C#: only on the line that sends the chat, CompleteChat, not where the chat client is made)
    if (chat && !params.includes("data_sources") && (u.lang !== "cs" || /\bCompleteChat/.test(lineAt(u.file, u.line))) && dataSourceNear(u.file, u.line, u.lang === "cs" ? 12 : 0, u.lang === "py" ? 12 : u.lang === "cs" ? 2 : 0)) params.push("data_sources");
    const c = mk(u, `${method} ${azPath}`, params.length ? params : undefined);
    if (have.has(key(c))) continue;
    have.add(key(c));
    out.push(c);
    // the OpenAI-path copy keeps its model (Azure's model retirements read it) but no operation: OpenAI's endpoint
    // records aren't Azure's
    delete u.op;
    u.host ??= "azure";
  }
  // (B) the Azure SDKs of C# (older API), Java and Go: client methods by name
  const ops = providerById(AZ)?.sdkOps ?? {};
  for (const f of files) {
    const re = FILE_SDK[f.lang];
    if (!re || !re.test(f.source) || f.source.length > 2_000_000) continue;
    const lines = f.source.split("\n");
    lines.forEach((l, i) => {
      if (l.length > 1000 || /^\s*(?:\/\/|\*|#)/.test(l)) return;
      for (const m of l.matchAll(/(?<![\w$])\.?\s*([A-Za-z]\w*)\s*(?:<[^>]*>)?\s*\(/g)) {
        const name = m[1];
        const op = (f.lang === "java" ? ops[name] : /^[A-Z]/.test(name) ? ops[name] : undefined) ?? (f.lang === "go" ? ops[name] : undefined);
        if (!op || !/^(?:get|create|list|update|delete|submit|Get|Create)/.test(name)) continue;
        // a call (a receiver before it), not a declaration of the method
        if (!/\.\s*$/.test(l.slice(0, m.index! + (m[0].match(/^\.?\s*/)?.[0].length ?? 0)))) {
          if (!/\.\s*[A-Za-z]/.test(m[0]) && !/\.\s*$/.test(l.slice(0, m.index!))) continue;
        }
        const chat = /\/chat\/completions$/.test(op);
        const params = chat && dataSourceNear(f.rel, i + 1, 25, 3) ? ["data_sources"] : undefined;
        const u: Usage = { provider: AZ, kind: "sdk", lang: f.lang, file: f.rel, line: i + 1, op, sdkCall: name, ...(params ? { params } : {}), confidence: "likely", snippet: l.trim().slice(0, 200), host: undefined, ...(isTest(f.rel) ? { inTest: true, role: "note" as const } : { role: "breaks" as const }) };
        if (have.has(key(u)) || out.some((x) => x.file === u.file && x.line === u.line && x.op?.split(" ")[1] === op.split(" ")[1])) continue;
        have.add(key(u));
        out.push(u);
      }
    });
  }
  // (C) a Realtime URL string: wss://….openai.azure.com/openai/realtime?api-version=2024-10-01-preview
  const have2 = new Set(kept.filter((u) => u.provider === AZ && /\/openai\/realtime/.test(u.op ?? "")).map((u) => `${u.file}|${u.line}`));
  for (const f of files) {
    if (!/\/openai\/realtime/.test(f.source) || f.source.length > 2_000_000) continue;
    f.source.split("\n").forEach((l, i) => {
      if (l.length > 1000 || /^\s*(?:\/\/|\*|#)/.test(l) || have2.has(`${f.rel}|${i + 1}`)) return;
      const m = /["'`](?:wss?|https?):\/\/[^"'`\s]*?(?:openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)\/openai\/realtime\b(?!\/)[^"'`\s]*/.exec(l);
      if (!m) return;
      have2.add(`${f.rel}|${i + 1}`);
      const ver = /[?&]api-version=([\w.-]+)/.exec(m[0])?.[1];
      out.push({ provider: AZ, kind: "http", lang: f.lang, file: f.rel, line: i + 1, op: "* /openai/realtime", confidence: "likely", snippet: l.trim().slice(0, 200), ...(ver ? { apiVersion: `url: ${ver}` } : {}), ...(isTest(f.rel) ? { inTest: true, role: "note" as const } : { role: "breaks" as const }) });
    });
  }
  return out;
}
