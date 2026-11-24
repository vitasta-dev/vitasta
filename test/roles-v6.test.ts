import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { blankLine, catalogAt } from "../src/scan/enclosing.js";
import { scanRepo } from "../src/scan/index.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-v6-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const at = (src: string, needle: string) => {
  const lines = src.split("\n");
  const i = lines.findIndex((l) => l.includes(needle));
  return catalogAt(lines, lines.map(blankLine), i, lines[i].indexOf(needle));
};
const JS = { "package.json": '{"dependencies":{"openai":"^4.0.0","@anthropic-ai/sdk":"^0.30.0"}}' };
const PY = { "requirements.txt": "openai==1.50.0\n" };

describe("roles v6: model catalogs and registries (from sets 1-5)", () => {
  it("an entry with price, context or capability fields is a catalog entry, at any nesting", () => {
    const src = [
      "export const models = [",
      "  {",
      "    modelId: 'claude-opus-5',",
      "    contextWindow: 1_000_000,",
      "    capabilities: ['vision', 'tool_use'],",
      "  },",
      "]",
      "const GPT4: LLM = {",
      '  modelId: "gpt-4",',
      '  provider: "openai",',
      "  pricing: { currency: 'USD', inputCost: 10 },",
      "}",
      "registry = [",
      '    {"id": "gpt-4o", "input_cost_per_token": 0.0000025},',
      "]",
    ].join("\n");
    expect(at(src, "claude-opus-5")).toBe("catalog-entry");
    expect(at(src, '"gpt-4"')).toBe("catalog-entry");
    expect(at(src, '"gpt-4o"')).toBe("catalog-entry");
  });

  it("a list of entries that each name a model by an ID key is a registry (provider mappings are notes)", () => {
    const src = [
      "const claudeModels = [",
      "  { apiModelId: 'Claude-Opus-4.8', modelId: 'claude-opus-4-8' },",
      "  { apiModelId: 'Claude-Opus-4.7', modelId: 'claude-opus-4-7' },",
      "  { apiModelId: 'claude-sonnet-4.5', modelId: 'claude-sonnet-4-5' },",
      "]",
      "const two = [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }]",
    ].join("\n");
    expect(at(src, "claude-opus-4-7")).toBe("registry");
    expect(at(src, "Claude-Opus-4.8")).toBe("registry");
    // Negative: two entries aren't a registry
    expect(at(src, "'gpt-4o'")).toBeUndefined();
  });

  it("presets, requests and provider configurations are never catalogs; nor are assignments and returns", () => {
    const src = [
      "export const masks = [",
      "  { name: 'a', modelConfig: { model: 'gpt-3.5-turbo', temperature: 1, max_tokens: 2000 } },",
      "  { name: 'b', modelConfig: { model: 'gpt-4', temperature: 1, max_tokens: 2000 } },",
      "  { name: 'c', modelConfig: { model: 'gpt-4o', temperature: 1, max_tokens: 2000 } },",
      "]",
      "PROVIDERS = {",
      '    "Whisper(API)": {"id": "whisper", "api_key": "", "api_base": "", "model": "whisper-1", "supports_streaming": True},',
      "}",
      "client.chat.completions.create({ model: 'gpt-4.1', messages, contextWindow: 1 })",
      "ai.models.generateContent({ model: 'gemini-x', contents: [], config: { maxOutputTokens: 100 } })",
      "send({ model: 'direct-call', contextWindow: 1 })",
      'claudeRequest.Model = "claude-instant-1.1"',
      'return "gpt-4o-2024" // default',
      "const routes = [{ model: 'm1' }, { model: 'm2' }, { model: 'm3' }]",
    ].join("\n");
    expect(at(src, "gpt-3.5-turbo")).toBeUndefined();
    expect(at(src, "whisper-1")).toBeUndefined();
    expect(at(src, "gpt-4.1")).toBeUndefined();
    expect(at(src, "gemini-x")).toBeUndefined();
    // an object passed straight into a call is a request, whatever its fields
    expect(at(src, "direct-call")).toBeUndefined();
    expect(at(src, "claude-instant-1.1")).toBeUndefined();
    expect(at(src, "gpt-4o-2024")).toBeUndefined();
    // "model" in a list is a route or preset, not a registry ID
    expect(at(src, "m2")).toBeUndefined();
  });

  it("end to end: catalog entries become catalog with a reason; a preset and a call still break", async () => {
    const d = await repo({
      ...JS,
      "src/providers/definitions/claude.ts": [
        "import Anthropic from '@anthropic-ai/sdk'",
        "export const claude = defineProvider({",
        "  models: [",
        "    { modelId: 'claude-opus-4-1', contextWindow: 200_000, capabilities: ['vision'] },",
        "    { modelId: 'claude-sonnet-4-5', contextWindow: 200_000, capabilities: ['vision'] },",
        "  ],",
        "})",
      ].join("\n"),
      "src/masks.ts": "import OpenAI from 'openai'\nexport const masks = [{ modelConfig: { model: 'gpt-3.5-turbo', temperature: 1 } }]\n",
      "src/chat.ts": "import OpenAI from 'openai'\nconst client = new OpenAI()\nawait client.chat.completions.create({ model: 'gpt-4o', messages: [] })\n",
    });
    const map = await scanRepo(d);
    const role = (f: string, m: string) => map.usages.find((u) => u.file === f && u.model === m);
    expect(role("src/providers/definitions/claude.ts", "claude-opus-4-1")?.role).toBe("catalog");
    expect(role("src/providers/definitions/claude.ts", "claude-opus-4-1")?.reason).toMatch(/catalog/);
    expect(role("src/masks.ts", "gpt-3.5-turbo")?.role).toBe("breaks");
    expect(role("src/chat.ts", "gpt-4o")?.role).toBe("breaks");
  });

  it("Python: a list of model dicts with prices is a catalog; a config dict with a key isn't", async () => {
    const d = await repo({
      ...PY,
      "app/models.py": 'MODELS = [\n    {"id": "gpt-4o", "context_length": 128000, "pricing": {"input": 2.5}},\n]\n',
      "app/settings.py": 'import openai\nLLM = {"model": "gpt-4o-mini", "api_key": None, "base_url": None}\n',
    });
    const map = await scanRepo(d);
    expect(map.usages.find((u) => u.file === "app/models.py" && u.model === "gpt-4o")?.role).toBe("catalog");
    expect(map.usages.find((u) => u.file === "app/settings.py" && u.model === "gpt-4o-mini")?.role).toBe("breaks");
  });

  it("stays bounded on long files", () => {
    const lines = ["const x = [", ...Array.from({ length: 5000 }, () => "  { id: 'a', contextWindow: 1 },"), "]"];
    const t = performance.now();
    catalogAt(lines, lines.map(blankLine), 2500, lines[2500].indexOf("a'"));
    expect(performance.now() - t).toBeLessThan(500);
  });
});

describe("v6 second stage: the catalog model (off by default)", () => {
  const files = {
    ...JS,
    "src/masks.ts": "import OpenAI from 'openai'\nexport const masks = [{ modelConfig: { model: 'gpt-3.5-turbo', temperature: 1 } }]\n",
    "src/chat.ts": "import OpenAI from 'openai'\nconst client = new OpenAI()\nawait client.chat.completions.create({ model: 'gpt-4o', messages: [] })\n",
    "src/rewrite.ts": "import Anthropic from '@anthropic-ai/sdk'\nexport function fix(req: any) {\n  if (req.model === 'claude-2') req.model = 'claude-2.1'\n}\n",
  };
  it("weights load and the shipped threshold is set", async () => {
    const { catalogScore, FEATURES } = await import("../src/scan/catalog-model.js");
    const s = catalogScore(FEATURES.map(() => 0));
    expect(s).toBeDefined();
    expect(s!.p).toBeGreaterThan(0);
  });
  it("without the flag nothing changes; with it, presets, calls and rewrites still break", async () => {
    const d = await repo(files);
    const off = await scanRepo(d);
    const on = await scanRepo(d, { catalogModel: true });
    const roles = (m: any) => m.usages.filter((u: any) => u.model).map((u: any) => `${u.file} ${u.model} ${u.role}`).sort();
    expect(roles(off)).toContain("src/masks.ts gpt-3.5-turbo breaks");
    expect(roles(on)).toEqual(roles(off));
  });
});

describe("v7: a catalog whose first or chosen entry is the app's default still breaks (test set 6)", () => {
  it("defaultModels[0] used elsewhere keeps the list's places as breaks; an unused catalog stays a catalog", async () => {
    const entries = (name: string) => [
      `export const ${name} = [`,
      "  { model: 'gpt-5', name: 'gpt-5', maxContext: 400000, vision: true },",
      "  { model: 'gpt-5-mini', name: 'gpt-5-mini', maxContext: 400000, vision: true },",
      "]",
    ].join("\n");
    const d = await repo({
      ...JS,
      "packages/global/ai/constants.ts": "import OpenAI from 'openai'\n" + entries("defaultQAModels"),
      "packages/global/ai/catalog.ts": "import OpenAI from 'openai'\n" + entries("pickerModels"),
      "web/dataset/constants.ts": "import { defaultQAModels } from '../../packages/global/ai/constants'\nexport const datasetDefault = { agentModel: defaultQAModels[0].model }\n",
    });
    const map = await scanRepo(d);
    const role = (f: string) => map.usages.find((u) => u.file === f && u.model === "gpt-5" && u.line === 3)?.role;
    expect(role("packages/global/ai/constants.ts")).toBe("breaks");
    expect(role("packages/global/ai/catalog.ts")).toBe("catalog");
  });
});
