import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { blankLine, recordedBy } from "../src/scan/enclosing.js";
import { isTestPath, scanRepo } from "../src/scan/index.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-v4-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const roles = async (d: string, file: string) => (await scanRepo(d)).usages.filter((x) => x.file === file && x.model).map((x) => `${x.line} ${x.model} ${x.testRole ?? x.role}`);
const at = (src: string, needle: string) => {
  const lines = src.split("\n");
  const i = lines.findIndex((l) => l.includes(needle));
  return recordedBy(lines, lines.map(blankLine), i, lines[i].indexOf(needle));
};
const PY = { "requirements.txt": "openai==1.50.0\n" };
const JS = { "package.json": '{"dependencies":{"openai":"^4.0.0","react":"^19.0.0"}}' };

describe("roles v4", () => {
  it("a data file only tests load is test input; the same file loaded by app code is configuration", async () => {
    const fixture = '{ "conversations": [{ "model": "gpt-4o", "title": "t" }] }\n';
    const d = await repo({
      ...JS,
      "api/import/importers.spec.js": 'const fs = require("fs");\nconst data = fs.readFileSync(path.join(__dirname, "__data__", "chat-export.json"));\n',
      "api/import/__data__/chat-export.json": fixture,
      "api/import/payloads/export.json": fixture,
      "api/import/import.test.js": 'const x = require("./payloads/export.json");\n',
      "src/app.js": 'import OpenAI from "openai";\nconst cfg = require("./app-models.json");\n',
      "src/app-models.json": fixture,
    });
    expect(await roles(d, "api/import/__data__/chat-export.json")).toEqual(["1 gpt-4o recorded"]);
    expect(await roles(d, "api/import/payloads/export.json")).toEqual(["1 gpt-4o test-data"]);
    // Negative: app code loads it, so it's runtime configuration
    expect(await roles(d, "src/app-models.json")).toEqual(["1 gpt-4o breaks"]);
  });

  it("test-support modules are tests; modules that merely contain the word aren't", () => {
    for (const f of ["src/sdk/testing.py", "internal/testutil.go", "lib/test_support.ts", "spec_helpers/testhelpers.rb", "pkg/test-helpers.js"]) expect(isTestPath(f), f).toBe(true);
    for (const f of ["src/attesting.py", "src/testimonials.ts", "src/latest.py", "src/contest_utils.py"]) expect(isTestPath(f), f).toBe(false);
  });

  it("a value written only to a log or run record is recorded; the same value in a config object or a call isn't", () => {
    const src = [
      "log = {",
      '    "run_metadata": {',
      '        "researcher_model": os.getenv("SMART_LLM", "openai:gpt-4.1"),',
      "    },",
      "}",
      'config = {"model": os.getenv("LLM", "gpt-4o")}',
      'summary = {"answer": run_agent(model="gpt-4o-mini")}',
      'print(f"using gpt-4o")',
      'logger.info("model", extra={"model": "gpt-4o"})',
      'client.chat.completions.create(model="gpt-4o", metadata={"x": 1})',
    ].join("\n");
    expect(at(src, "openai:gpt-4.1")).toBe("record");
    expect(at(src, 'gpt-4o")}')).toBeUndefined();
    // Negative: a call between the value and the record uses it
    expect(at(src, "gpt-4o-mini")).toBeUndefined();
    expect(at(src, 'extra={"model": "gpt-4o"}'.slice(17))).toBe("write-call");
    expect(at(src, 'model="gpt-4o", metadata')).toBeUndefined();
    // Negative (Airflow test labels): a serialised setting is a setting
    const conn = 'conn = Connection(\n    extra=json.dumps({"model": "azure:gpt-4o"}),\n)';
    expect(at(conn, "azure:gpt-4o")).toBeUndefined();
  });

  it("a React context's default value is recorded; the provider's value and other defaults aren't", () => {
    const src = [
      "const DebugContext = createContext<IDebug>({",
      "  query: '',",
      "  modelConfig: {",
      "    provider: 'OPENAI',",
      "    model_id: 'gpt-3.5-turbo',",
      "  },",
      "})",
      "const value = { modelConfig: { model_id: 'gpt-4o' } }",
      "const [model, setModel] = useState('gpt-4o-mini')",
    ].join("\n");
    expect(at(src, "gpt-3.5-turbo")).toBe("context-default");
    expect(at(src, "'gpt-4o' }")).toBeUndefined();
    expect(at(src, "gpt-4o-mini")).toBeUndefined();
  });

  it("end to end: a run record and a context default are recorded with a reason; a live call still breaks", async () => {
    const d = await repo({
      ...PY, ...JS,
      "evals/run_eval.py": 'import os\nimport openai\nlog = {\n    "run_metadata": {\n        "researcher_model": os.getenv("SMART_LLM", "gpt-4.1"),\n    },\n}\nclient = openai.OpenAI()\nclient.chat.completions.create(model=os.getenv("SMART_LLM", "gpt-4.1"), messages=[])\n',
      "web/context.ts": "import { createContext } from 'react'\nimport OpenAI from 'openai'\nexport const Ctx = createContext({\n  modelConfig: {\n    model_id: 'gpt-3.5-turbo',\n  },\n})\n",
    });
    const map = await scanRepo(d);
    const at5 = map.usages.find((u) => u.file === "evals/run_eval.py" && u.line === 5);
    expect(at5?.role).toBe("recorded");
    expect(at5?.reason).toMatch(/log or record/);
    expect(map.usages.find((u) => u.file === "evals/run_eval.py" && u.line === 9)?.role).not.toBe("recorded");
    expect(map.usages.find((u) => u.file === "web/context.ts")?.role).toBe("recorded");
  });

  it("Python: a local name resolves to its assignment before the use, not to a later one in another branch", async () => {
    const d = await repo({
      ...PY,
      "chat.py": [
        "import openai",
        "client = openai.OpenAI()",
        "def submit(prompt, **kwargs):",
        '    if kwargs.get("model") is not None:',
        '        model = kwargs.get("model")',
        "        return client.chat.completions.create(model=model, messages=prompt)",
        "    else:",
        '        model = "gpt-3.5-turbo"',
        "        return client.chat.completions.create(model=model, messages=prompt)",
        "",
        'DEFAULT = "gpt-4o"',
        "def other(prompt):",
        "    return client.chat.completions.create(model=DEFAULT, messages=prompt)",
      ].join("\n"),
    });
    const hits = (await scanRepo(d)).usages.filter((u) => u.model).map((u) => `${u.line} ${u.model}`);
    expect(hits).not.toContain("6 gpt-3.5-turbo");
    expect(hits).toContain("9 gpt-3.5-turbo");
    // Negative: a module-level constant still resolves inside a function
    expect(hits).toContain("13 gpt-4o");
  });

  it("the enclosing check stays bounded on deep nesting and long files", () => {
    const lines = [...Array.from({ length: 5000 }, () => "x = [[[[[[[[[["), 'y = "gpt-4o"'];
    const t = performance.now();
    recordedBy(lines, lines.map(blankLine), lines.length - 1, 5);
    expect(performance.now() - t).toBeLessThan(500);
  });
});
