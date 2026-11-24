import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluatePr } from "../src/check.js";
import { findImpacts } from "../src/feed/match.js";
import { scanRepo } from "./helpers/legacy-scan.js";
import type { ChangeRecord } from "../src/types.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-recall-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const found = async (d: string) =>
  (await scanRepo(d)).usages.filter((u) => u.model && !u.reason).map((u) => `${u.file}:${u.line} ${u.model}${u.doc ? " (doc)" : ""}`).sort();

const DEPS = {
  "package.json": '{"dependencies":{"openai":"^4.0.0","@anthropic-ai/sdk":"^0.30.0","commander":"^12.0.0"}}',
  "requirements.txt": "openai==1.50.0\nanthropic==0.40.0\nagno==1.0.0\n",
};

describe("model places the outreach check found by hand (18 Nov), generically", () => {
  it("finds each pattern in the recall fixture", async () => {
    expect(await found(resolve(import.meta.dirname, "fixtures/recall"))).toEqual([
      "README.md:6 gpt-image-1.5 (doc)",
      "basic.py:4 claude-sonnet-4-5-20250929",
      "capability.py:4 claude-sonnet-4-5",
      "cli/tts.ts:4 tts-1",
      "config.py:3 gpt-4o",
      "openai_generic_client.py:3 gpt-4.1-mini",
      "src/agents.ts:3 gpt-4.1",
      "src/agents.ts:4 gpt-5-mini",
      "src/quickstart.tsx:4 claude-sonnet-4-5 (doc)",
      "src/send-prompt.ts:7 gpt-3.5-turbo",
    ]);
  });

  it("environment defaults: a model ID is configuration; other defaults aren't models", async () => {
    const d = await repo({
      ...DEPS,
      "settings.py": 'import os\nimport openai\nPORT = os.getenv("PORT", "8000")\nLLM = os.environ.get("LLM", "gpt-4o-mini")\n',
      "env.ts": 'import OpenAI from "openai";\nexport const llm = process.env.LLM ?? "gpt-4.1";\nexport const region = process.env.REGION ?? "us-east-1";\n',
    });
    expect(await found(d)).toEqual(["env.ts:2 gpt-4.1", "settings.py:4 gpt-4o-mini"]);
  });

  it("gateway prefixes, but never file paths", async () => {
    const d = await repo({
      ...DEPS,
      "routes.ts": 'import OpenAI from "openai";\nexport const a = { model: "gateway/openai/gpt-4o" };\nexport const doc = { model: "docs/openai/gpt-4o.md" };\nexport const img = { model: "assets/openai/gpt-4o.png" };\n',
    });
    expect(await found(d)).toEqual(["routes.ts:2 gpt-4o"]);
  });

  it("CLI options and form fields: only ones about the model", async () => {
    const d = await repo({
      ...DEPS,
      "cli.ts": 'import { Command } from "commander";\nimport OpenAI from "openai";\nnew Command("x")\n  .option("-p, --port <n>", "Port", "3000")\n  .option("--speech-model <m>", "Speech model", "tts-1-hd")\n  .option("-v, --voice <v>", "Voice", "alloy");\n',
      "form.ts": 'import OpenAI from "openai";\nexport const props = {\n  temperature: { displayName: "Temperature", defaultValue: "0.7" },\n  model: { displayName: "Model", defaultValue: "gpt-4o" },\n};\n',
    });
    expect(await found(d)).toEqual(["cli.ts:5 tts-1-hd", "form.ts:4 gpt-4o"]);
  });

  it("framework model classes count; other classes with an id don't", async () => {
    const d = await repo({
      ...DEPS,
      "agent.py": 'from agno.models.openai import OpenAIChat\nfrom app import Record\nm = OpenAIChat(id="gpt-4o")\nr = Record(id="gpt-4o-mini")\n',
    });
    expect(await found(d)).toEqual(["agent.py:3 gpt-4o"]);
  });

  it("README code blocks count as documentation; prose and price tables in them don't count at all", async () => {
    const d = await repo({
      ...DEPS,
      "README.md": [
        "# App",
        "We use gpt-4o for answers and claude-sonnet-4-5 for code.",
        "",
        "```python",
        "from openai import OpenAI",
        "client = OpenAI()",
        'client.chat.completions.create(model="gpt-4o-mini", messages=[])',
        "PRICES = {\"gpt-4o\": 2.5, \"gpt-4o-mini\": 0.15}",
        "```",
        "",
        "```text",
        'model="gpt-4o"',
        "```",
      ].join("\n"),
    });
    expect(await found(d)).toEqual(["README.md:7 gpt-4o-mini (doc)"]);
  });

  it("code samples in template strings count as documentation; prose in template strings doesn't", async () => {
    const d = await repo({
      ...DEPS,
      "ui.tsx": [
        'import OpenAI from "openai";',
        "export const help = `Pick a model such as gpt-4o or claude-sonnet-4-5 in the settings (it costs more).`;",
        "export const sample = `",
        'import OpenAI from "openai";',
        "const client = new OpenAI();",
        "await client.chat.completions.create({ model: 'gpt-4o', messages: [] });",
        "`;",
      ].join("\n"),
    });
    expect(await found(d)).toEqual(["ui.tsx:6 gpt-4o (doc)"]);
  });

  it("documentation never fails a pull request check", async () => {
    const d = resolve(import.meta.dirname, "fixtures/recall");
    const map = await scanRepo(d);
    const feed: ChangeRecord[] = [{ id: "img", provider: "openai", type: "model_retirement", title: "t", selector: { models: ["gpt-image-1.5"] }, effective: "2026-01-01", trigger: "date", sources: [{ url: "https://x" }] }];
    const findings = findImpacts(map, feed, "2026-11-19");
    expect(findings.map((f) => f.usage.file)).toEqual(["README.md"]);
    expect(evaluatePr(findings, new Map([["README.md", new Set([6])]])).conclusion).toBe("neutral");
  });

  it("defaults in destructured parameters count; other destructured defaults don't", async () => {
    const d = await repo({ ...DEPS, "resolve.ts": 'import OpenAI from "openai";\nexport const resolve = async ({ defaultModel = "openai/gpt-4.1", timeout = "30s" }: { defaultModel?: string; timeout?: string }) => defaultModel + timeout;\n' });
    expect(await found(d)).toEqual(["resolve.ts:2 gpt-4.1"]);
  });

  it("a provider/model route in a provider- or LLM-named constant counts; a bare provider or a list of routes doesn't", async () => {
    const d = await repo({
      ...DEPS,
      "config.py": 'import openai\nDEFAULT_PROVIDER = "openai/gpt-4o"\nPROVIDER = "openai"\nFALLBACK_LLM = "anthropic:claude-sonnet-4-5"\nPROVIDERS = {"ollama/llama3": "no-token", "groq/llama3-70b-8192": "GROQ_API_KEY"}\n',
    });
    expect(await found(d)).toEqual(["config.py:2 gpt-4o", "config.py:4 claude-sonnet-4-5"]);
  });

  it("a router named only in a comment or a string doesn't turn provider routes into router IDs; importing the router does", async () => {
    const d = await repo({
      ...DEPS,
      "search.ts": "import OpenAI from \"openai\";\n// uses the openrouter:web_search plugin\nexport const body = { model: 'openai/gpt-5-mini', plugins: [{ type: 'openrouter:web_search' }] };\n",
      "router.ts": "import { createOpenRouter } from \"@openrouter/ai-sdk-provider\";\nexport const body = { model: 'openai/gpt-4o' };\n",
    });
    const map = await scanRepo(d);
    expect(map.usages.filter((u) => u.model && u.file === "search.ts").map((u) => `${u.provider} ${u.model}`)).toEqual(["openai gpt-5-mini"]);
    expect(map.usages.some((u) => u.file === "router.ts" && u.provider === "openai")).toBe(false);
  });

  it("code examples in Python docstrings count as documentation, without edit positions; docstring prose doesn't count", async () => {
    const d = await repo({
      ...DEPS,
      "lib.py": [
        "import anthropic",
        "",
        "def research():",
        '    """Run research. Works with claude-sonnet-4-5 or gpt-4o.',
        "",
        "    .. code-block:: python",
        "",
        "        from pydantic_ai import Agent",
        "        agent = Agent(",
        '            "anthropic:claude-sonnet-4-5",',
        '            name="researcher",',
        "        )",
        '    """',
        "    return None",
      ].join("\n"),
    });
    const map = await scanRepo(d);
    const hits = map.usages.filter((u) => u.model);
    expect(hits.map((u) => `${u.file}:${u.line} ${u.model}${u.doc ? " (doc)" : ""}`)).toEqual(["lib.py:10 claude-sonnet-4-5 (doc)"]);
    expect(hits[0].modelSpan).toBeUndefined();
  });

  it("price tables, recorded responses and lists only checked against are reported in their roles, never as breakage", async () => {
    const d = await repo({
      ...DEPS,
      "pricing.ts": 'import OpenAI from "openai";\nexport function costOf(model: string) {\n  const PRICES: Record<string, number> = { "gpt-4o": 2.5, "gpt-4o-mini": 0.15 };\n  return PRICES[model];\n}\n',
      "replay.py": 'import openai\nRESPONSE = {"id": "chatcmpl-1", "object": "chat.completion", "model": "gpt-4o-2024-08-06", "choices": [], "usage": {}}\n',
    });
    const map = await scanRepo(d);
    const extra = map.usages.filter((u) => u.reason);
    expect(extra.length).toBeGreaterThan(0);
    for (const u of extra) expect(u.role, `${u.file}:${u.line} ${u.reason}`).toMatch(/^(catalog|recorded)$/);
    expect(map.usages.some((u) => u.role === "breaks")).toBe(false);
  });
});
