/**
 * SDK calls in Ruby, PHP, C#, Java and Go for providers whose calls are named paths (messages.create,
 * chat.completions.create, assistants.list), and the typed request objects and settings those SDKs and frameworks use.
 * All data, from each SDK's documented method and option names:
 *   CLIENTS   how a client is made in each language (constructor, facade, typed field), and the SDK's own method paths
 *             when they differ from the provider's sdkOps (ruby-openai's client.chat(parameters: {…}), openai-php's
 *             $client->chat()->create([…]), the community anthropic gem's client.messages(parameters: {…}))
 *   TYPED     request or option objects that name their operation (OpenAI .NET ChatCompletionOptions, Anthropic.SDK
 *             MessageParameters, Microsoft.Extensions.AI ChatOptions, Spring AI AnthropicChatOptions.builder(),
 *             go-openai ChatCompletionRequest, openai-go ChatCompletionNewParams), with their fields
 *   METHODS   SDK methods that name the operation themselves (go-openai CreateAssistant, OpenAI .NET AssistantClient)
 *   SETTINGS  configuration keys a framework sends (spring.ai.anthropic.chat.options.temperature)
 * Keys are written the wire's way (Temperature → temperature, topP → top_p, top-p → top_p). Text-based, like the rest
 * of the support for these languages; each key on its own line, a call with no keys on its own line.
 */
import { providerById, sdkOp, type ProviderDef } from "../providers.js";
import type { Usage } from "../types.js";
import { arrayKeys } from "./phpsdk.js";
import { hashKeys } from "./rbsdk.js";
import { blockFields, snake } from "./typedsdk.js";

type Lang = "rb" | "php" | "cs";
type Key = { key: string; line: number; start: number; end: number };

/** The OpenAI REST resources by an SDK method path's first segment (SDKs that don't follow the provider's own paths) */
const OPENAI_PATHS: Record<string, string> = {
  chat: "POST /v1/chat/completions", completions: "POST /v1/completions", embeddings: "POST /v1/embeddings",
  assistants: "* /v1/assistants", threads: "* /v1/threads", runs: "* /v1/threads", run_steps: "* /v1/threads", messages: "* /v1/threads",
  vector_stores: "* /v1/vector_stores", vectorStores: "* /v1/vector_stores", files: "* /v1/files", models: "GET /v1/models",
  moderations: "POST /v1/moderations", images: "POST /v1/images/generations", responses: "POST /v1/responses", batches: "* /v1/batches",
  fine_tuning: "* /v1/fine_tuning", fineTuning: "* /v1/fine_tuning",
};
const ANTHROPIC_PATHS: Record<string, string> = { messages: "POST /v1/messages", complete: "POST /v1/complete", models: "GET /v1/models" };

const CLIENTS: { provider: string; make: Partial<Record<Lang, RegExp>>; facade?: Partial<Record<Lang, RegExp>>; paths: Record<string, string>; nested?: string }[] = [
  {
    provider: "anthropic",
    make: {
      rb: /\b([a-z_]\w*|@[a-z_]\w*)\s*(?:\|\|)?=\s*(?:::)?Anthropic::Client\.new\b/g,
      php: /\$([A-Za-z_]\w*)\s*=\s*(?:\\?Anthropic(?:\\\w+)*::(?:client|factory)\b|new\s+\\?(?:Anthropic\\)?Client\s*\()/g,
      // (a field, parameter or local of the client type, or var x = new AnthropicClient(…))
      cs: /\b(?:Anthropic\.)?AnthropicClient\s+(\w+)\b|\bvar\s+(\w+)\s*=\s*new\s+(?:Anthropic\.)?AnthropicClient\b/g,
    },
    paths: ANTHROPIC_PATHS,
    // the community anthropic gem: client.messages(parameters: { … })
    nested: "parameters",
  },
  {
    provider: "openai",
    make: {
      rb: /\b([a-z_]\w*|@[a-z_]\w*)\s*(?:\|\|)?=\s*(?:::)?OpenAI::Client\.new\b/g,
      php: /\$([A-Za-z_]\w*)\s*=\s*\\?OpenAI(?:\\\w+)*::(?:client|factory)\b/g,
    },
    // openai-php/laravel: OpenAI::chat()->create([…])
    facade: { php: /\bOpenAI::(?!client\b|factory\b)/ },
    paths: OPENAI_PATHS,
    // ruby-openai: client.chat(parameters: { … })
    nested: "parameters",
  },
];

/** Typed request and option objects: the type names the operation; its fields are the params */
const TYPED: { lang: "cs" | "java" | "go"; provider: string; op: string; re: RegExp; needs?: RegExp; kind: "init" | "builder" | "struct"; providerByFile?: boolean }[] = [
  { lang: "cs", provider: "openai", op: "POST /v1/chat/completions", re: /\bnew\s+(?:OpenAI\.Chat\.)?ChatCompletionOptions\b\s*(?:\(\s*\))?/g, needs: /\bOpenAI\b/, kind: "init" },
  { lang: "cs", provider: "anthropic", op: "POST /v1/messages", re: /\bnew\s+(?:Anthropic\.SDK\.Messaging\.)?MessageParameters\b\s*(?:\(\s*\))?/g, needs: /Anthropic\.SDK/, kind: "init" },
  // Microsoft.Extensions.AI: the provider is the client the file wires (an Anthropic or OpenAI IChatClient)
  { lang: "cs", provider: "*", op: "", re: /\bnew\s+(?:Microsoft\.Extensions\.AI\.)?ChatOptions\b\s*(?:\(\s*\))?/g, needs: /Microsoft\.Extensions\.AI/, kind: "init", providerByFile: true },
  { lang: "java", provider: "anthropic", op: "POST /v1/messages", re: /\bAnthropicChatOptions\s*\.\s*builder\s*\(\s*\)/g, kind: "builder" },
  { lang: "java", provider: "openai", op: "POST /v1/chat/completions", re: /\bOpenAiChatOptions\s*\.\s*builder\s*\(\s*\)/g, kind: "builder" },
  { lang: "go", provider: "openai", op: "POST /v1/chat/completions", re: /\bopenai\.ChatCompletion(?:Request|NewParams)\s*\{/g, needs: /sashabaranov\/go-openai|openai\/openai-go/, kind: "struct" },
  { lang: "go", provider: "openai", op: "* /v1/assistants", re: /\bopenai\.Assistant(?:Request|NewParams)\s*\{/g, needs: /sashabaranov\/go-openai|openai\/openai-go/, kind: "struct" },
  { lang: "go", provider: "openai", op: "* /v1/threads", re: /\bopenai\.(?:Run|Thread)(?:Request|NewParams)\s*\{/g, needs: /sashabaranov\/go-openai|openai\/openai-go/, kind: "struct" },
];

/** SDK methods that name the operation (on a client of the SDK) */
const METHODS: { lang: "go" | "cs"; provider: string; needs: RegExp; re: RegExp; op: string }[] = [
  { lang: "go", provider: "openai", needs: /sashabaranov\/go-openai/, re: /\.(?:Create|List|Retrieve|Modify|Delete)Assistants?\w*\s*\(/g, op: "* /v1/assistants" },
  { lang: "go", provider: "openai", needs: /sashabaranov\/go-openai/, re: /\.(?:Create|List|Retrieve|Modify|Delete|Cancel|Submit)(?:Thread|Run|Message|RunStep)\w*\s*\(/g, op: "* /v1/threads" },
  { lang: "go", provider: "openai", needs: /sashabaranov\/go-openai/, re: /\.CreateChatCompletion(?:Stream)?\s*\(/g, op: "POST /v1/chat/completions" },
  { lang: "cs", provider: "openai", needs: /OpenAI\.Assistants/, re: /\b\w+\.(?:Create|Get|Modify|Delete)(?:Assistant|Thread|Run|Message)s?(?:Async)?\s*\(/g, op: "* /v1/assistants" },
  { lang: "cs", provider: "openai", needs: /OpenAI\.Chat/, re: /\b\w+\.CompleteChat(?:Streaming)?(?:Async)?\s*\(/g, op: "POST /v1/chat/completions" },
];

/** Framework settings in configuration files: key → provider, operation and the wire name of the setting */
const SETTINGS: { re: RegExp; provider: string; op: string }[] = [
  { re: /^\s*spring\.ai\.anthropic\.chat\.options\.(temperature|top-p|top-k|top_p|top_k|topP|topK)\s*[=:]/, provider: "anthropic", op: "POST /v1/messages" },
  { re: /^\s*spring\.ai\.openai\.chat\.options\.(temperature|top-p|top_p|topP)\s*[=:]/, provider: "openai", op: "POST /v1/chat/completions" },
];

const MAX_LINE = 2000;
const camelToPath = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const wire = (k: string) => snake(k.replace(/^:/, "").replace(/-/g, "_"));

/** The operation of an SDK method path: the provider's sdkOps, else the SDK's own path table (first segment) */
function opOf(p: ProviderDef, paths: Record<string, string>, path: string): string | undefined {
  return sdkOp(p, path) ?? paths[path.split(".")[0]];
}

/** PHP named arguments at the top level of a call (create(maxTokens: 100, temperature: 0.2)) */
function namedArgs(lines: string[], starts: number[], row: number, col: number): Key[] {
  const out: Key[] = [];
  let depth = 0;
  for (let r = row; r < Math.min(lines.length, row + 60); r++) {
    const l = lines[r];
    for (let j = r === row ? col : 0; j < l.length; j++) {
      const c = l[j];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (--depth === 0) return out;
      } else if (depth === 1 && /[(,\s]/.test(l[j - 1] ?? "(")) {
        const m = /^([A-Za-z_]\w*)\s*:(?!:)/.exec(l.slice(j));
        if (m) out.push({ key: m[1], line: r + 1, start: starts[r] + j, end: starts[r] + l.length });
      }
    }
  }
  return out;
}

export function sdkClientUsages(file: string, lang: Usage["lang"], source: string): Usage[] {
  if (source.length > 2_000_000) return [];
  const out: Usage[] = [];
  const lines = source.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const l of lines) {
    starts.push(at);
    at += l.length + 1;
  }
  const emit = (p: ProviderDef, line: number, op: string, sdkCall: string, keys: Key[], why: string, confidence: Usage["confidence"] = "likely") => {
    if (!keys.length) {
      out.push({ provider: p.id, kind: "sdk", lang, file, line, op, sdkCall, confidence, snippet: (lines[line - 1] ?? "").trim().slice(0, 200), reason: why });
      return;
    }
    for (const k of keys) {
      const key = wire(k.key);
      out.push({
        provider: p.id, kind: "sdk", lang, file, line: k.line, op, sdkCall, params: [key], confidence,
        snippet: (lines[k.line - 1] ?? "").trim().slice(0, 200), reason: `${key} in ${why}`, paramSpans: { [key]: { start: k.start, end: k.end } },
      });
    }
  };

  // 1. Clients by method path (Ruby, PHP, C#)
  if (lang === "rb" || lang === "php" || lang === "cs") {
    for (const c of CLIENTS) {
      const p = providerById(c.provider);
      const make = c.make[lang];
      if (!p || !make) continue;
      const names = new Set([...source.matchAll(make)].map((m) => m[1] ?? m[2]).filter(Boolean));
      const facade = c.facade?.[lang];
      if (!names.size && !(facade && facade.test(source))) continue;
      const esc = (s: string) => s.replace(/[$@]/g, "\\$&");
      const calls: RegExp[] = [...names].map((n) =>
        lang === "rb" ? new RegExp(`(?<![\\w.])${esc(n)}\\.((?:[a-z_]\\w*\\.)*[a-z_]\\w*)\\s*\\(?`, "g")
        : lang === "php" ? new RegExp(`\\$${n}((?:->\\w+(?:\\(\\))?)*)->(\\w+)\\s*\\(`, "g")
        : new RegExp(`(?<![\\w.])${n}\\.((?:[A-Z]\\w*\\.)*)([A-Z]\\w*?)(?:Async)?\\s*\\(`, "g"));
      if (facade && lang === "php") calls.push(/\bOpenAI::((?:\w+\(\)->)*)(\w+)\s*\(/g);
      lines.forEach((l, i) => {
        if (l.length > MAX_LINE || /^\s*(?:#|\/\/|\*)/.test(l)) return;
        for (const call of calls) {
          for (const m of l.matchAll(call)) {
            const path = lang === "rb" ? m[1]
              : lang === "php" ? [...m[1].matchAll(/(?:->|^)(\w+)(?:\(\))?/g)].map((x) => x[1]).concat(m[2]).join(".")
              : [...m[1].split(".").filter(Boolean), m[2]].map(camelToPath).join(".");
            const op = opOf(p, c.paths, path);
            if (!op) continue;
            const open = m.index! + m[0].length - 1;
            let keys: Key[] = [];
            if (lang === "rb") {
              if (l[open] === "(" || /\s/.test(l[open] ?? "")) {
                // ruby-openai / anthropic gem: the request is the `parameters:` hash
                const abs = starts[i] + open;
                const nest = c.nested ? new RegExp(`\\b${c.nested}:\\s*\\{`).exec(source.slice(abs, abs + 400)) : null;
                if (nest) {
                  const brace = abs + nest.index + nest[0].length - 1;
                  let row = i;
                  while (row + 1 < starts.length && starts[row + 1] <= brace) row++;
                  keys = hashKeys(lines, starts, row, brace - starts[row]);
                } else keys = hashKeys(lines, starts, i, open);
                keys = keys.filter((k) => k.key.replace(/^:/, "") !== c.nested);
              }
            } else if (lang === "php") {
              const b = /^\(\s*(?:['"][^'"]*['"]\s*,\s*)?\[/.exec(l.slice(open));
              keys = b ? arrayKeys(lines, starts, i, open + b[0].length - 1) : namedArgs(lines, starts, i, open);
            } else {
              const rest = l.slice(open);
              const b = /new\s+[\w.]+\s*(?:\(\s*\))?\s*\{/.exec(rest);
              if (b) keys = blockFields(lines, starts, i, open + b.index + b[0].length - 1, /\b([A-Z]\w*)\s*=(?!=)/g, snake);
              else {
                // A local passed by name: var p = new MessageCreateParams { … } earlier in the method
                const arg = /^\(\s*([A-Za-z_]\w*)\s*[,)]/.exec(rest)?.[1];
                for (let r = i - 1; arg && r >= Math.max(0, i - 120); r--) {
                  const d = new RegExp(`\\b(?:var|[\\w.<>]+)\\s+${arg}\\s*=\\s*new\\s+[\\w.]+\\s*(?:\\(\\s*\\))?\\s*(\\{)?`).exec(lines[r]);
                  if (!d) continue;
                  const brace = d[1] ? { row: r, col: d.index + d[0].length - 1 } : /^\s*\{/.test(lines[r + 1] ?? "") ? { row: r + 1, col: lines[r + 1].indexOf("{") } : undefined;
                  if (brace) keys = blockFields(lines, starts, brace.row, brace.col, /\b([A-Z]\w*)\s*=(?!=)/g, snake);
                  break;
                }
              }
            }
            emit(p, i + 1, op, path, keys, `a ${p.id} SDK ${path} call`);
          }
        }
      });
    }
  }

  // 2. Typed request and option objects (C#, Java, Go)
  for (const t of TYPED) {
    if (t.lang !== lang || (t.needs && !t.needs.test(source))) continue;
    let p = t.provider === "*" ? undefined : providerById(t.provider);
    let op = t.op;
    if (t.providerByFile) {
      // the client this file wires: an Anthropic one, or an OpenAI one, not both
      const a = /\bAnthropicClient\b|\bAnthropic\.SDK\b|using\s+Anthropic\b/.test(source);
      const o = /\bOpenAIClient\b|\bChatClient\b|using\s+OpenAI\b/.test(source);
      if (a === o) continue;
      p = providerById(a ? "anthropic" : "openai");
      op = a ? "POST /v1/messages" : "POST /v1/chat/completions";
    }
    if (!p) continue;
    lines.forEach((l, i) => {
      if (l.length > MAX_LINE) return;
      for (const m of l.matchAll(t.re)) {
        const end = m.index! + m[0].length;
        let keys: Key[] = [];
        if (t.kind === "init" || t.kind === "struct") {
          const brace = t.kind === "struct" ? { row: i, col: end - 1 } : /^\s*\{/.test(l.slice(end)) ? { row: i, col: end + l.slice(end).indexOf("{") } : /^\s*\{/.test(lines[i + 1] ?? "") ? { row: i + 1, col: lines[i + 1].indexOf("{") } : undefined;
          if (brace) keys = blockFields(lines, starts, brace.row, brace.col, t.kind === "struct" ? /\b([A-Z]\w*)\s*:(?!=)/g : /\b([A-Z]\w*)\s*=(?!=)/g, snake);
        } else {
          // builder: .temperature(0.4).topP(0.9) … up to .build(); only the chain's own steps, not calls inside their
          // arguments (.temperature(cfg.getTemperature() != null ? …: 0.7) is one step, temperature; test sets)
          let depth = 0, done = false;
          for (let r = i; r < Math.min(lines.length, i + 30) && !done; r++) {
            const s = r === i ? lines[r].slice(end) : lines[r];
            const base = r === i ? end : 0;
            for (let c = 0; c < s.length; c++) {
              const ch = s[c];
              if (ch === '"' || ch === "'") { const q = ch; for (c++; c < s.length && s[c] !== q; c++) if (s[c] === "\\") c++; continue; }
              if (ch === "(" || ch === "[" || ch === "{") { depth++; continue; }
              if (ch === ")" || ch === "]" || ch === "}") { depth--; if (depth < 0) { done = true; break; } continue; }
              if (ch === ";" && depth === 0) { done = true; break; }
              if (ch !== "." || depth !== 0) continue;
              const b = /^\.([a-z]\w*)\s*\(/.exec(s.slice(c));
              if (!b) continue;
              if (b[1] === "build") { done = true; break; }
              keys.push({ key: b[1], line: r + 1, start: starts[r] + base + c + 1, end: starts[r] + lines[r].length });
            }
          }
        }
        emit(p, i + 1, op, m[0].replace(/\s+/g, ""), keys, `a ${p.id} request (${m[0].replace(/^new\s+|\s*\{$|\s+/g, "")})`, t.providerByFile ? "possible" : "likely");
      }
    });
  }

  // 3. SDK methods that name the operation
  for (const x of METHODS) {
    if (x.lang !== lang || !x.needs.test(source)) continue;
    const p = providerById(x.provider);
    if (!p) continue;
    lines.forEach((l, i) => {
      if (l.length > MAX_LINE || /^\s*\/\//.test(l)) return;
      for (const m of l.matchAll(x.re)) emit(p, i + 1, x.op, m[0].replace(/[\s(]+$/, "").replace(/^\.|^\w+\./, ""), [], `an ${p.id} SDK ${m[0].replace(/[\s(]+$/, "")} call`);
    });
  }

  // 4. Framework settings in configuration (application.properties / .yml / .yaml)
  if (lang === "config" && /(^|\/)application[\w-]*\.(properties|ya?ml)$/.test(file)) {
    // A YAML tree flattened to dotted keys, by indentation
    const yaml = /\.ya?ml$/.test(file);
    const stack: { ind: number; key: string }[] = [];
    lines.forEach((l, i) => {
      if (l.length > MAX_LINE || /^\s*(#|$)/.test(l)) return;
      let key = l;
      if (yaml) {
        const m = /^(\s*)([\w.-]+)\s*:/.exec(l);
        if (!m) return;
        const ind = m[1].length;
        while (stack.length && stack[stack.length - 1].ind >= ind) stack.pop();
        stack.push({ ind, key: m[2] });
        key = stack.map((s) => s.key).join(".") + ":";
      }
      for (const s of SETTINGS) {
        const m = s.re.exec(key);
        const p = m ? providerById(s.provider) : undefined;
        if (!m || !p) continue;
        const k = wire(m[1]);
        out.push({ provider: p.id, kind: "sdk", lang, file, line: i + 1, op: s.op, params: [k], confidence: "likely", setting: true, snippet: l.trim().slice(0, 200), reason: `${k} set for the framework's ${p.id} requests` });
      }
    });
  }
  // One usage per line, operation and param (a client call and its typed request can both read the same keys)
  const seen = new Set<string>();
  return out.filter((u) => {
    const k = `${u.line}|${u.provider}|${u.op}|${u.params?.[0] ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
