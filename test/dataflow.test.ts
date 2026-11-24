import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectLoadRefs, emptyRefs, isDataFile, knownConfig, loadedByCode } from "../src/scan/dataflow.js";
import { isTestPath, scanRepo } from "../src/scan/index.js";
import { isExamplePath, roleOf } from "../src/scan/roles.js";
import type { Usage } from "../src/types.js";

const u = (file: string, extra: Partial<Usage> = {}): Usage => ({ provider: "openai", kind: "model-ref", lang: "config", file, line: 1, model: "gpt-4o", confidence: "possible", snippet: "model: gpt-4o", setting: true, ...extra });
const refsOf = (...sources: string[]) => {
  const r = emptyRefs();
  for (const s of sources) collectLoadRefs(s, r);
  return r;
};
const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-dataflow-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const roles = async (d: string, file: string) => (await scanRepo(d)).usages.filter((x) => x.file === file && x.model).map((x) => `${x.line} ${x.model} ${x.role}`);

describe("roles v3: two flows by file type", () => {
  it("data files are the data flow; code and notebooks are not", () => {
    for (const f of ["config.yaml", "a/b.json", "pyproject.toml", "app.ini", ".env", ".env.local", "prod.env", "x.properties"]) expect(isDataFile(f), f).toBe(true);
    for (const f of ["src/app.py", "src/config.ts", "nb.ipynb", "README.md", "envoy.go"]) expect(isDataFile(f), f).toBe(false);
  });

  it("known configuration names and places; not any data file", () => {
    for (const f of [".env", ".env.production", "config.yaml", "src/settings.json", "llm-config.yml", "litellm_config.yaml", "appsettings.Development.json", "docker-compose.prod.yml", "values.yaml", "wrangler.toml", ".github/workflows/ci.yml", "config/models.yaml", "deploy/agent.json", ".myapprc"]) expect(knownConfig(f), f).toBe(true);
    for (const f of ["data/models.json", "src/i18n/fr.json", "website/_data/table.yml", "agents/agent_1.json", "prompts/summarize.yaml", "configurator.json"]) expect(knownConfig(f), f).toBe(false);
  });

  it("a file the code loads: by name, by path, or by its folder next to a pattern for its type", () => {
    const r = refsOf(
      'SETTINGS = importlib_resources.files("aider.resources").joinpath("model-settings.yml")',
      'const p = path.join(__dirname, "conf/llm/providers.yaml");',
      'AGENTS_DIR = Path(__file__).parent / "agents"\nfiles = list(AGENTS_DIR.glob("agent_*.json"))',
    );
    expect(loadedByCode("aider/resources/model-settings.yml", r)).toBe(true);
    expect(loadedByCode("backend/conf/llm/providers.yaml", r)).toBe(true);
    expect(loadedByCode("backend/agents/agent_1.json", r)).toBe(true);
    // Negative: another name, the same name in another folder path, a folder named without a pattern for its type
    expect(loadedByCode("aider/resources/model-metadata.json", r)).toBe(false);
    expect(loadedByCode("other/llm/providers.yaml", r)).toBe(false);
    expect(loadedByCode("backend/agents/agent_1.yaml", r)).toBe(false);
    expect(loadedByCode("x/agents/a.json", refsOf('AGENTS = "agents"'))).toBe(false);
  });

  it("a setting in a data file fails only in runtime config; elsewhere it's recorded, still reported", () => {
    const none = emptyRefs();
    expect(roleOf(u("config.yaml"), 0, none)).toBe("breaks");
    expect(roleOf(u(".env", { snippet: "MODEL=gpt-4o" }), 0, none)).toBe("breaks");
    expect(roleOf(u("prompts/summarize.yaml"), 0, none)).toBe("recorded");
    expect(roleOf(u("prompts/summarize.yaml"), 0, refsOf('load_prompt("prompts/summarize.yaml")'))).toBe("breaks");
    // Lists in data files stay catalog entries, runtime or not
    expect(roleOf(u("config.yaml", { setting: false, listed: true }), 0, none)).toBe("catalog");
    // Code keeps the code rules: the same place in a .py file breaks with or without refs
    expect(roleOf(u("src/app.py", { lang: "py" }), 0, none)).toBe("breaks");
    // Without refs (a usage that didn't come through a scan) a data file is configuration, as before v3
    expect(roleOf(u("prompts/summarize.yaml"))).toBe("breaks");
  });

  it("a runtime settings registry the code reads isn't a catalog by density alone; its entries' names are", () => {
    const r = refsOf('MODEL_SETTINGS = resources.files("pkg").joinpath("model-settings.yml")');
    expect(roleOf(u("pkg/model-settings.yml", { snippet: "weak_model_name: gpt-4o-mini" }), 40, r)).toBe("breaks");
    expect(roleOf(u("pkg/model-settings.yml", { setting: false, listed: true, snippet: "- name: gpt-4o" }), 40, r)).toBe("catalog");
    // Negative: the same dense file when no code loads it and no name marks it is a catalog
    expect(roleOf(u("pkg/model-table.yml", { snippet: "weak_model_name: gpt-4o-mini" }), 40, emptyRefs())).toBe("catalog");
    // Negative: density still makes a code file's plain entries a catalog
    expect(roleOf(u("src/models.py", { lang: "py", setting: false }), 40, r)).toBe("catalog");
  });

  it("history and site data are recorded: release notes, changelogs, website/_data, benchmark and leaderboard data", () => {
    for (const f of ["CHANGELOG.md", "docs/CHANGES.rst", "releasenotes/notes/add-gpt-4o.yaml", "release-notes/2026.md", "HISTORY.md", "website/_data/edit_leaderboard.yml", "benchmark/results.json", "leaderboards/2026.yaml"]) {
      expect(roleOf(u(f, { lang: f.endsWith(".md") || f.endsWith(".rst") ? "py" : "config", doc: f.endsWith(".md") }), 0, emptyRefs()), f).toBe("recorded");
    }
    // Negative: code in a benchmark folder keeps the code rules; a module named history isn't a changelog
    expect(roleOf(u("benchmark/run.py", { lang: "py" }), 0, emptyRefs())).toBe("breaks");
    expect(roleOf(u("src/history/store.py", { lang: "py" }), 0, emptyRefs())).toBe("breaks");
    expect(roleOf(u("src/newsletter.py", { lang: "py" }), 0, emptyRefs())).toBe("breaks");
  });

  it("test projects and test settings are tests; examples inside a tested-examples folder stay examples", () => {
    for (const f of ["src/Acme.IntegrationTests/Chat.cs", "Acme.Tests/ChatTests.cs", "e2e-tests/run.ts", "integration_tests/test_chat.py", "testsettings.json", "src/test-settings.yaml", "appsettings.Test.json"]) expect(isTestPath(f), f).toBe(true);
    for (const f of ["src/contests/run.ts", "src/attestation.py", "src/latest/run.ts", "src/settings.json"]) expect(isTestPath(f), f).toBe(false);
    expect(roleOf(u("testsettings.json"), 0, emptyRefs())).toBe("test-asserts");
    expect(roleOf(u("src/Acme.IntegrationTests/Chat.cs", { lang: "cs", inTest: true }), 0, emptyRefs())).toBe("test-asserts");
    expect(roleOf(u("code-example-tests/python/examples/rag.py", { lang: "py", inTest: true }), 0, emptyRefs())).toBe("users-copy");
  });

  it("skill assets and migration guides are users-copy; database migrations aren't", () => {
    for (const f of ["skills/pdf/assets/template.py", ".claude/skills/review/assets/config.json", "docs/migration-guide/v2.py", "migrating/from-v1.ts", "docs/upgrade_guide_v3.py"]) expect(isExamplePath(f), f).toBe(true);
    for (const f of ["skills/pdf/handler.py", "db/migrations/0001_models.py", "src/migration.py", "alembic/versions/upgrade_guide_x.py"]) expect(isExamplePath(f), f).toBe(false);
  });

  it("end to end: aider-style settings the code loads break; a prompt file nobody loads is recorded", async () => {
    const d = await repo({
      "requirements.txt": "openai==1.50.0\n",
      "pkg/models.py": 'import openai\nfrom importlib import resources\nSETTINGS = resources.files("pkg.resources").joinpath("model-settings.yml")\n',
      "pkg/resources/model-settings.yml": Array.from({ length: 10 }, (_, i) => `- name: gpt-4o-2024-0${i}\n  weak_model_name: gpt-4o-mini\n`).join(""),
      "prompts/summarize.yaml": "model: gpt-4o\nprompt: hi\n",
      "config.yaml": "model: gpt-4o\n",
    });
    const settings = await roles(d, "pkg/resources/model-settings.yml");
    expect(settings.filter((s) => s.includes("gpt-4o-mini")).every((s) => s.endsWith("breaks"))).toBe(true);
    expect(settings.filter((s) => s.includes("gpt-4o-mini")).length).toBe(10);
    expect(await roles(d, "prompts/summarize.yaml")).toEqual(["1 gpt-4o recorded"]);
    expect(await roles(d, "config.yaml")).toEqual(["1 gpt-4o breaks"]);
  });

  it("corpus review (19 Nov): Spring and extension manifests are config; loaders by scheme, template or concatenation", () => {
    for (const f of ["src/main/resources/application.properties", "src/main/resources/application-prod.yml", "bootstrap.yaml", "package.json"]) expect(knownConfig(f), f).toBe(true);
    for (const f of ["src/main/resources/agents.json", "applications.json", "packages/x.json"]) expect(knownConfig(f), f).toBe(false);
    const r = refsOf(
      'private val agentDefFileName = "classpath:bootstrap-agents.json"',
      'pipeline_path = "pipelines/" + pipeline_name + ".yml"',
      'path = f"flows/{name}.json"',
    );
    expect(loadedByCode("src/main/resources/bootstrap-agents.json", r)).toBe(true);
    expect(loadedByCode("pipelines/task_pipeline.yml", r)).toBe(true);
    expect(loadedByCode("flows/a.json", r)).toBe(true);
    // Negative: the folder with another type, another folder
    expect(loadedByCode("flows/a.yaml", r)).toBe(false);
    expect(loadedByCode("other/task_pipeline.yml", r)).toBe(false);
  });

  it("corpus review: not tests or history just by a word in a name", () => {
    for (const f of ["app/api/generate-tests/route.ts", "src/latest-specs/x.ts", "plugins/x/internal/entry/history.go"]) expect(isTestPath(f), f).toBe(false);
    for (const f of ["api-tests/chat.ts", "ui_tests/x.py", "e2e-specs/run.ts", "OpenAI-DotNet-Tests/TestFixture_03_Threads.cs", "Foo_Tests/A.cs"]) expect(isTestPath(f), f).toBe(true);
    expect(roleOf(u("plugins/x/internal/entry/history.go", { lang: "go" }), 0, emptyRefs())).toBe("breaks");
    expect(roleOf(u("plugins/x/internal/entry/history_test.go", { lang: "go", inTest: true, kind: "sdk" }), 0, emptyRefs())).toBe("test-asserts");
    expect(roleOf(u("NEWS.txt", { lang: "py" }), 0, emptyRefs())).toBe("recorded");
  });

  it("end to end: a loader in a language the scanner doesn't parse (Kotlin) makes its data file runtime config", async () => {
    const d = await repo({
      "build.gradle.kts": 'dependencies { implementation("com.openai:openai-java:2.0.0") }\n',
      "src/main/kotlin/Boot.kt": 'class Boot { val file = "classpath:bootstrap-agents.json" }\n',
      "src/main/java/App.java": "import com.openai.client.OpenAIClient;\nclass App {}\n",
      "src/main/resources/bootstrap-agents.json": '{ "agents": [{ "name": "helper", "model": "gpt-4o" }] }\n',
      "src/main/resources/other.json": '{ "model": "gpt-4o" }\n',
    });
    expect(await roles(d, "src/main/resources/bootstrap-agents.json")).toEqual(["1 gpt-4o breaks"]);
    expect(await roles(d, "src/main/resources/other.json")).toEqual(["1 gpt-4o recorded"]);
  });

  it("the load patterns stay linear on long hostile lines", () => {
    const line = `"${"a/".repeat(400)}${"b".repeat(150)}*${"c".repeat(150)}" `.repeat(3);
    const t = performance.now();
    collectLoadRefs(Array.from({ length: 2000 }, () => line.slice(0, 990)).join("\n"), emptyRefs());
    expect(performance.now() - t).toBeLessThan(2000);
  });
});
