import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { comparedAt, inResponseSchema } from "../src/scan/enclosing.js";
import { scanRepo } from "../src/scan/index.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-v5-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const rolesOf = async (d: string) => (await scanRepo(d)).usages.filter((x) => x.model).map((x) => `${x.file}:${x.line} ${x.model} ${x.testRole ?? x.role}`);
const PY = { "requirements.txt": "openai==1.50.0\n" };
const JS = { "package.json": '{"dependencies":{"openai":"^4.0.0"}}' };

describe("roles v5", () => {
  it("comparedAt: only the operand next to a comparison", () => {
    const at = (l: string, s: string) => comparedAt(l, l.indexOf(s));
    expect(at('if (modelId === "gpt-4o") {', "gpt-4o")).toBe(true);
    expect(at("if model == 'gpt-4o':", "gpt-4o")).toBe(true);
    expect(at('if ("gpt-4o" !== model) return', "gpt-4o")).toBe(true);
    expect(at('  case "gpt-4o":', "gpt-4o")).toBe(true);
    expect(at('if (model.startsWith("gpt-4o")) {', "gpt-4o")).toBe(true);
    // Negatives: the values a comparison chooses between are sent
    expect(at('const m = fast === true ? "gpt-4o-mini" : "gpt-4o"', "gpt-4o-mini")).toBe(false);
    expect(at('model = "gpt-4o"', "gpt-4o")).toBe(false);
    expect(at('const f = (m = "gpt-4o") => m', "gpt-4o")).toBe(false);
  });

  it("inResponseSchema: a field default in a response class, not in a request class or a method", () => {
    const src = [
      "class VideoResponse(BaseModel):",
      '    model: str = "sora-2"',
      "class VideoRequest(BaseModel):",
      '    model: str = "sora-2"',
      "class ChatCompletionResponse(BaseModel):",
      "    def build(self):",
      '        model = "gpt-4o"',
    ].join("\n").split("\n");
    expect(inResponseSchema(src, 1)).toBe(true);
    expect(inResponseSchema(src, 3)).toBe(false);
    expect(inResponseSchema(src, 6)).toBe(false);
  });

  it("end to end: comparisons and response schemas aren't breaks; the call and the request default are", async () => {
    const d = await repo({
      ...PY, ...JS,
      "src/bedrock.ts": 'import OpenAI from "openai";\nexport function shape(modelId: string) {\n  if (modelId === "anthropic.claude-3-5-sonnet-20240620-v1:0") return "a";\n  if (modelId.startsWith("anthropic.claude-3-haiku-20240307-v1:0")) return "b";\n  const id = "amazon.nova-pro-v1:0";\n  return id;\n}\nconst client = new OpenAI();\nclient.chat.completions.create({ model: "gpt-4o", messages: [] });\n',
      "server/protocol.py": 'import openai\nfrom pydantic import BaseModel\nclass VideoResponse(BaseModel):\n    model: str = "gpt-4o"\nclass VideoRequest(BaseModel):\n    model: str = "gpt-4o-mini"\n',
    });
    const r = await rolesOf(d);
    expect(r).toContain("src/bedrock.ts:3 anthropic.claude-3-5-sonnet-20240620-v1:0 catalog");
    expect(r).toContain("src/bedrock.ts:4 anthropic.claude-3-haiku-20240307-v1:0 catalog");
    // Negatives: a constant and the call keep their role
    expect(r).toContain("src/bedrock.ts:5 amazon.nova-pro-v1:0 breaks");
    expect(r).toContain("src/bedrock.ts:9 gpt-4o breaks");
    expect(r).toContain("server/protocol.py:4 gpt-4o recorded");
    expect(r).toContain("server/protocol.py:6 gpt-4o-mini breaks");
  });

  it("a comparison in a test is an assertion, not a catalog entry", async () => {
    const d = await repo({
      ...JS,
      "src/main.ts": 'import OpenAI from "openai";\nnew OpenAI().chat.completions.create({ model: "gpt-4o", messages: [] });\n',
      "src/main.test.ts": 'import { test } from "vitest";\ntest("id", () => {\n  const modelId = pick();\n  if (modelId === "anthropic.claude-3-5-sonnet-20240620-v1:0") throw new Error("old");\n});\n',
    });
    const r = await rolesOf(d);
    expect(r.find((x) => x.startsWith("src/main.test.ts"))).not.toMatch(/catalog$/);
  });

  it("span attributes are telemetry; a value passed on to a call isn't", async () => {
    const d = await repo({
      ...PY,
      "lib/instrument.py": 'import openai\ndef wrap(span, kwargs):\n    span.set_attribute("llm.request.model", kwargs.get("model", "gpt-4o"))\n    return openai.OpenAI().chat.completions.create(model=kwargs.get("model", "gpt-4o-mini"), messages=[])\n',
    });
    const r = await rolesOf(d);
    expect(r).toContain("lib/instrument.py:3 gpt-4o recorded");
    expect(r.find((x) => x.includes("gpt-4o-mini"))).toMatch(/breaks$/);
  });

  it("fixtures and seeders by any folder name; snippets shown to users; translations", async () => {
    const d = await repo({
      ...JS,
      "packages/session-fixture/session.ts": 'export const s = { model: "gpt-4o" };\n',
      "worker/src/seeder/scenarios/chat.ts": 'export const run = { model: "gpt-4o" };\n',
      "web/src/lib/call-snippets.ts": 'export const py = { model: "gpt-4o" };\n',
      "frontend/src/integrations/scripts/openai.py": 'import openai\nopenai.OpenAI().chat.completions.create(model="gpt-4o", messages=[])\n',
      "web/src/locales/en.json": '{ "hint": "Uses gpt-4o by default", "model": "gpt-4o" }\n',
      "web/src/i18n.ts": 'import en from "./locales/en.json";\nimport cfg from "./models.json";\n',
      "web/src/models.json": '{ "model": "gpt-4o" }\n',
      // Negatives: app code with the same words isn't
      "src/fixtures.ts": 'import OpenAI from "openai";\nnew OpenAI().chat.completions.create({ model: "gpt-4o", messages: [] });\n',
      "src/seed.ts": 'export const model = "gpt-4o";\n',
      "src/main.ts": 'import OpenAI from "openai";\nnew OpenAI().chat.completions.create({ model: "gpt-4o", messages: [] });\n',
    });
    const r = await rolesOf(d);
    const role = (f: string) => r.filter((x) => x.startsWith(f + ":")).map((x) => x.split(" ").pop());
    expect(role("packages/session-fixture/session.ts")).not.toContain("breaks");
    expect(role("worker/src/seeder/scenarios/chat.ts")).toEqual(["recorded"]);
    expect(role("web/src/lib/call-snippets.ts")).toEqual(["users-copy"]);
    expect(role("frontend/src/integrations/scripts/openai.py")).toEqual(["users-copy"]);
    expect(role("web/src/locales/en.json")).not.toContain("breaks");
    expect(role("web/src/models.json")).toEqual(["breaks"]);
    expect(role("src/main.ts")).toEqual(["breaks"]);
  });

  it("a benchmark harness that calls the provider breaks; a mocked test beside it doesn't", async () => {
    const d = await repo({
      ...PY,
      "benchmarks/longmem/run.py": 'import openai\nMODEL = "gpt-4o"\nopenai.OpenAI().chat.completions.create(model=MODEL, messages=[])\n',
      "benchmarks/longmem/test_run.py": 'import openai\nfrom unittest.mock import MagicMock\nc = MagicMock()\nc.chat.completions.create(model="gpt-4o", messages=[])\n',
    });
    const r = await rolesOf(d);
    expect(r.filter((x) => x.startsWith("benchmarks/longmem/run.py")).map((x) => x.split(" ").pop())).toContain("breaks");
    expect(r.filter((x) => x.startsWith("benchmarks/longmem/test_run.py")).map((x) => x.split(" ").pop())).not.toContain("breaks");
  });

  it("a mocked client's model is test data unless an assertion names it", async () => {
    const d = await repo({
      ...PY,
      "tests/test_mocked.py": 'import openai\nfrom unittest.mock import MagicMock\ndef test_a():\n    c = MagicMock()\n    c.chat.completions.create(model="gpt-4o", messages=[])\n',
      "tests/test_checked.py": 'import openai\nfrom unittest.mock import MagicMock\ndef test_b():\n    c = MagicMock()\n    c.chat.completions.create(model="gpt-4o-mini", messages=[])\n    c.chat.completions.create.assert_called_with(\n        model="gpt-4o-mini",\n    )\n',
      "tests/test_live.py": 'import openai\ndef test_c():\n    openai.OpenAI().chat.completions.create(model="gpt-4o", messages=[])\n',
    });
    const r = await rolesOf(d);
    const role = (f: string) => r.filter((x) => x.startsWith(f + ":")).map((x) => x.split(" ").pop());
    expect(role("tests/test_mocked.py")).toEqual(["test-data"]);
    expect(role("tests/test_checked.py")).not.toContain("test-data");
    expect(role("tests/test_live.py")).toEqual(["test-asserts"]);
  });
});
