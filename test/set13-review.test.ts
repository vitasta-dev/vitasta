import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";
import { isTestPath } from "../src/scan/index.js";
import { langOf } from "../src/scan/files.js";

// Review: (24 Nov): generic fixes on hand-written code (never set 13's)
const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-s13r-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const usages = async (files: Record<string, string>) => (await scanRepo(await repo(files))).usages as any[];

describe("C# script files", () => {
  it(".csx is C#, and its interpolated Assistants URLs are found", async () => {
    expect(langOf("scripts/run.csx")).toBe("cs");
    const us = await usages({ "scripts/a.csx": 'var baseUrl = "https://api.openai.com/v1";\nvar http = new HttpClient();\nvar r = await http.PostAsync($"{baseUrl}/assistants", null);\n' });
    expect(us.some((u) => u.provider === "openai" && u.line === 3 && /assistants/.test(u.op ?? ""))).toBe(true);
  });
});

describe("model fallbacks", () => {
  it("PHP $config['model'] ?? '…' and JS action.model ??= '…'", async () => {
    const us = await usages({
      "a.php": "<?php\nclass A {\n  public function m(array $config) {\n    return $config['model'] ?? 'claude-3-haiku-20240307';\n  }\n}\n",
      "b.js": 'export function f(action) {\n  action.model ??= "gpt-4o";\n}\n',
    });
    expect(us.filter((u) => u.model).map((u) => `${u.file}:${u.line}`).sort()).toEqual(["a.php:4", "b.js:2"]);
  });
});

describe("precision", () => {
  it("UI state and form-event values aren't request settings", async () => {
    const us = await usages({ "web/Settings.tsx": 'import Anthropic from "@anthropic-ai/sdk";\nexport function S({ config, setConfig }: any) {\n  const c = new Anthropic();\n  return <input onChange={(e) => setConfig({ ...config, temperature: Number(e.target.value) })} />;\n}\n' });
    expect(us.filter((u) => u.params?.includes("temperature"))).toEqual([]);
  });
  it("a server's own route isn't a call; a relay's forwarded one is", async () => {
    const served = await usages({ "server/routes.go": 'package server\n\n// clients point base_url at us instead of https://api.openai.com\nfunc Setup(app *gin.Engine) {\n\tapp.POST("/v1/assistants", create)\n}\n' });
    expect(served.filter((u) => u.provider === "openai" && u.file === "server/routes.go" && u.op)).toEqual([]);
    const relay = await usages({ "relay/routes.go": 'package relay\n\nconst upstream = "https://api.openai.com"\n\nfunc Setup(app *gin.Engine) {\n\tapp.POST("/v1/assistants", forward)\n}\n' });
    expect(relay.some((u) => u.provider === "openai" && u.line === 6)).toBe(true);
  });
});

describe("scribejava's FacebookApi.instance() default", () => {
  it("8.3.3 from a pom property: the call and the property line, v3.2", async () => {
    const us = await usages({
      "pom.xml": "<project>\n  <properties><scribejava.version>8.3.3</scribejava.version></properties>\n  <dependencies><dependency><groupId>com.github.scribejava</groupId><artifactId>scribejava-apis</artifactId><version>${scribejava.version}</version></dependency></dependencies>\n</project>\n",
      "src/main/java/a/Fb.java": "package a;\nimport com.github.scribejava.apis.FacebookApi;\npublic class Fb {\n    Object s() { return new ServiceBuilder(\"id\").build(FacebookApi.instance()); }\n}\n",
    });
    expect(us.filter((u) => u.apiVersion === "default: v3.2").map((u) => `${u.file}:${u.line}`).sort()).toEqual(["pom.xml:2", "src/main/java/a/Fb.java:4"]);
  });
});

describe("a client built with provider anthropic", () => {
  it("the temperature it's called with, traced to the method's default", async () => {
    const us = await usages({ "py/agents.py": 'from agentkit import AgentClient\n\nclass Base:\n    def ask(self, prompt, temperature: float = 0.3):\n        return AgentClient(provider="anthropic").call(prompt, temperature=temperature)\n' });
    const at = us.filter((u) => u.provider === "anthropic" && u.params?.includes("temperature")).map((u) => u.line);
    expect(at).toEqual(expect.arrayContaining([4, 5]));
  });
});
