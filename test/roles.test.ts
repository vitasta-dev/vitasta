import { describe, expect, it } from "vitest";
import { isExamplePath, roleOf } from "../src/scan/roles.js";
import type { Usage } from "../src/types.js";

const u = (file: string, extra: Partial<Usage> = {}): Usage => ({ provider: "openai", kind: "model-ref", lang: "py", file, line: 1, model: "gpt-4o", confidence: "possible", snippet: "", ...extra });

describe("roles: what a place is for (founder, 19 Nov: replacement in all files, only breakage fails)", () => {
  it("examples, tutorials and docs are users-copy; tests aren't, even inside an examples folder", () => {
    for (const f of ["examples/agent.py", "cookbook/90_models/basic.py", "docs/guide.md", "tutorial.ipynb", "templates/starter/src/agent.ts", "demo_app.py"]) expect(isExamplePath(f), f).toBe(true);
    for (const f of ["src/agent.py", "tests/test_agent.py", "app/models.ts"]) expect(isExamplePath(f), f).toBe(false);
    expect(roleOf(u("examples/agent.py", { inTest: true }))).toBe("users-copy");
    expect(roleOf(u("examples/tests/test_agent.py", { inTest: true, setting: true }))).toBe("test-asserts");
  });

  it("live code breaks; a listed model is a catalog entry; recorded data is info; docs are users-copy", () => {
    expect(roleOf(u("src/agent.py", { setting: true }))).toBe("breaks");
    expect(roleOf(u("src/models.ts", { listed: true }))).toBe("catalog");
    expect(roleOf(u("src/trace.py", { recorded: true }))).toBe("recorded");
    expect(roleOf(u("README.md", { doc: true }))).toBe("users-copy");
  });

  it("tests: a call or a setting must be updated by the fix; a stored value is cleanup", () => {
    expect(roleOf(u("tests/test_x.py", { inTest: true, kind: "sdk" }))).toBe("test-asserts");
    expect(roleOf(u("tests/test_x.py", { inTest: true, setting: true }))).toBe("test-asserts");
    expect(roleOf(u("tests/test_x.py", { inTest: true }))).toBe("test-data");
  });

  it("step 2: example and docs paths; component registries; but not code that merely has such a word in it", () => {
    for (const f of ["gemini/sample-apps/hallcheck/cli.py", "gemini/use-cases/extract/config.json", "content/atlas/source/includes/ai/agent.py", "apps/ui/registry/default/kit/route.ts", "apps/ui/public/r/kit.json", "publications/paper_artifacts_june/config.ini"]) expect(isExamplePath(f), f).toBe(true);
    for (const f of ["src/includes/db.php", "src/template_engine.ts", "lib/registry/models.ts", "src/usecase.ts"]) expect(isExamplePath(f), f).toBe(false);
  });

  it("step 2: telemetry, tracing and recorded output are recorded; an ordinary setting that mentions a model isn't", () => {
    expect(roleOf(u("src/trace.ts", { snippet: "'attributes.gen_ai.response.model': 'claude-3-5-sonnet'" }))).toBe("recorded");
    expect(roleOf(u("tests/test_tracing.py", { inTest: true, setting: true, snippet: "SpanAttributeKey.MODEL: \"gpt-4\"," }))).toBe("recorded");
    expect(roleOf(u("packages/x/src/__fixtures__/graph.ts", { snippet: "ls_model_name: 'gpt-5'," }))).toBe("recorded");
    expect(roleOf(u("apps/webapp/seed-ai-spans.mts", { snippet: 'respModel: "gpt-5",' }))).toBe("recorded");
    expect(roleOf(u("docs/source/includes/seed-database.ts", { setting: true, snippet: 'modelName: "gpt-4o-mini",' }))).toBe("users-copy");
    expect(roleOf(u("src/agent.py", { setting: true, snippet: 'model="gpt-4o", temperature=0' }))).toBe("breaks");
  });

  it("step 2: a file of many models is a catalog, but a call in it isn't, and settings in tests stay tests", () => {
    expect(roleOf(u("src/presets.py", { setting: true }), 25)).toBe("catalog");
    expect(roleOf(u("src/presets.py", { kind: "sdk" }), 25)).toBe("breaks");
    expect(roleOf(u("src/models.ts"), 9)).toBe("catalog");
    expect(roleOf(u("src/router.ts", { setting: true }), 9)).toBe("breaks");
    expect(roleOf(u("tests/test_router.py", { inTest: true, setting: true }), 30)).toBe("test-asserts");
    expect(roleOf(u("src/bedrock.ts", { snippet: "['anthropic.claude-3-7-sonnet-20250219-v1:0']: {" }))).toBe("catalog");
  });

  it("step 2: in a test, mock and stored data is test-data; a configured call is test-asserts", () => {
    expect(roleOf(u("tests/test_x.ts", { inTest: true, setting: true, snippet: "mockResolvedValueOnce([{ model: 'claude-x' }])" }))).toBe("test-data");
    expect(roleOf(u("tests/test_x.py", { inTest: true, setting: true, snippet: 'agent = Agent(model="gpt-4o")' }))).toBe("test-asserts");
  });
});

describe("step 4: reporting by role", async () => {
  const { evaluatePr, annotationFor } = await import("../src/check.js");
  const { renderMarkdown } = await import("../src/report/markdown.js");
  const change = { id: "c", provider: "openai", type: "model_retirement", title: "gpt-4o retires", selector: { models: ["gpt-4o"] }, effective: "2026-01-01", trigger: "date", sources: [{ url: "https://x" }] } as const;
  const f = (file: string, line: number, extra: Partial<Usage> = {}) => ({ change: change as any, usage: u(file, { line, setting: true, ...extra }), daysLeft: -10, status: "broken" as const });
  const live = f("src/agent.py", 3);
  const example = f("examples/demo.py", 5);
  const test = f("tests/test_agent.py", 7, { inTest: true });
  const listed = f("src/models.ts", 9, { listed: true });

  it("only live code fails a check; examples are annotated without failing; tests and catalogs aren't in a PR's check", () => {
    const changed = new Map([["src/agent.py", new Set([3])], ["examples/demo.py", new Set([5])], ["tests/test_agent.py", new Set([7])], ["src/models.ts", new Set([9])]]);
    const r = evaluatePr([live, example, test, listed], changed);
    expect(r.conclusion).toBe("failure");
    expect(r.introduced.map((x) => x.usage.file).sort()).toEqual(["examples/demo.py", "src/agent.py"]);
    expect(annotationFor(example, true).annotation_level).not.toBe("failure");
    expect(annotationFor(live, true).annotation_level).toBe("failure");
    expect(evaluatePr([example, test, listed], changed).conclusion).not.toBe("failure");
  });

  it("the report has a section per role; only live code is under 'What breaks'", () => {
    const md = renderMarkdown({ root: ".", scannedAt: "2026-11-19T00:00:00Z", filesScanned: 4, sdks: [], usages: [] } as any, [live, example, test, listed], "acme/app");
    const breaks = md.slice(md.indexOf("## What breaks"), md.indexOf("## In examples and docs"));
    expect(breaks).toContain("src/agent.py");
    expect(breaks).not.toContain("examples/demo.py");
    expect(md).toContain("## In examples and docs");
    expect(md).toMatch(/<summary>In tests \(1\)<\/summary>[\s\S]*tests\/test_agent\.py/);
    expect(md).toMatch(/<summary>In model lists, catalogs and price tables \(1\)<\/summary>[\s\S]*Never renamed/);
  });
});

describe("roles v2 (rules designed from the held-out error categories; judged on a second blind set)", async () => {
  const { mkdir, mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { dirname, join } = await import("node:path");
  const { scanRepo } = await import("../src/scan/index.js");
  const { modelToModel } = await import("../src/scan/roles.js");
  const repo = async (files: Record<string, string>) => {
    const d = await mkdtemp(join(tmpdir(), "vitasta-v2-"));
    for (const [p, t] of Object.entries({ "package.json": '{"dependencies":{"openai":"^4.0.0"}}', "requirements.txt": "openai==1.50.0\nlitellm==1.50.0\n", ...files })) {
      await mkdir(dirname(join(d, p)), { recursive: true });
      await writeFile(join(d, p), t);
    }
    return d;
  };
  const roles = async (d: string) => (await scanRepo(d)).usages.filter((x) => x.model).map((x) => `${x.file}:${x.line} ${x.model} ${x.role}`).sort();

  it("1: JSON data of saved runs is recorded; a JSON config isn't", () => {
    expect(roleOf(u(".agents/skills/qa/references/backfills/run-12.json", { setting: true }))).toBe("recorded");
    expect(roleOf(u("eval/results/2026-11-01.jsonl", { setting: true }))).toBe("recorded");
    expect(roleOf(u("config/models.json", { setting: true }))).toBe("breaks");
    expect(roleOf(u("src/results/handler.ts", { setting: true }))).toBe("breaks");
  });

  it("2: a map from one model ID to another is a catalog; a model next to other values isn't", () => {
    expect(modelToModel('  "gpt-4o": "openai/gpt-4o",')).toBe(true);
    expect(modelToModel("  'claude-3-5-sonnet-20241022' => 'claude-sonnet-4-5',")).toBe(true);
    expect(modelToModel('  model: "gpt-4o", temperature: "0.2",')).toBe(false);
    expect(roleOf(u("src/translate.py", { setting: true, snippet: '"gpt-4o": "openai/gpt-4o",' }))).toBe("catalog");
  });

  it("3: defaults of token and size helpers (functions and class constructors) aren't uses; a client's default is", async () => {
    const d = await repo({
      "tokens.js": 'const { encoding_for_model } = require("tiktoken");\nclass TokenManager {\n  constructor(model = "gpt-3.5-turbo") { this.enc = encoding_for_model(model); }\n}\nmodule.exports = { TokenManager };\n',
      "sizes.py": 'import openai\ndef model_to_prompt_size(model_name: str = "gpt-4o") -> int:\n    return 128000\n',
      "client.py": 'import openai\nclass Client:\n    def __init__(self, model: str = "gpt-4o-mini"):\n        self.model = model\n',
    });
    expect(await roles(d)).toEqual(["client.py:3 gpt-4o-mini breaks"]);
  });

  it("4: model= in a response or stream-chunk object is recorded; in a request it's a setting", async () => {
    const d = await repo({
      "tests/test_stream.py": 'import litellm\nfrom litellm import ModelResponse\nchunk = ModelResponse(model="gpt-4o", choices=[])\nresp = litellm.completion(model="gpt-4o-mini", messages=[])\n',
      "app.py": 'from openai import OpenAI\nclient = OpenAI()\nr = client.responses.create(model="gpt-4.1", input="hi")\n',
    });
    const r = await roles(d);
    expect(r).toContain("tests/test_stream.py:3 gpt-4o recorded");
    expect(r).toContain("tests/test_stream.py:4 gpt-4o-mini test-asserts");
    expect(r.find((x) => x.startsWith("app.py:3"))).toMatch(/breaks$/);
  });

  it("5: a name gate in a test is test data; an assert against the old value must be updated (test-asserts)", () => {
    expect(roleOf(u("tests/test_router.py", { inTest: true, setting: true, snippet: 'if model.startswith("gpt-4o"):' }))).toBe("test-data");
    expect(roleOf(u("tests/test_router.ts", { inTest: true, setting: true, snippet: "if (name === 'gpt-4o') return true;" }))).toBe("test-data");
    expect(roleOf(u("tests/test_cfg.py", { inTest: true, setting: true, snippet: 'monkeypatch.setenv("MODEL", "gpt-4o")' }))).toBe("test-data");
    expect(roleOf(u("tests/test_cfg.py", { inTest: true, setting: true, snippet: 'assert cfg.model == "gpt-4o"' }))).toBe("test-asserts");
    expect(roleOf(u("tests/test_cfg.ts", { inTest: true, setting: true, snippet: "expect(cfg.model).toBe('gpt-4o')" }))).toBe("test-asserts");
  });
});
