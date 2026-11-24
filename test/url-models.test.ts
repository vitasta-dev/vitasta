import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scanRepo } from "../src/scan/index.js";
import { urlModelsIn } from "../src/scan/urlmodels.js";

vi.setConfig({ testTimeout: 60_000 });

const scan = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-urlmodel-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return ((await scanRepo(d)).usages as any[]).filter((u) => u.kind === "model-ref");
};
const GEM = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent";

describe("a model named in a request URL's path", () => {
  it("every language reads it from the string", async () => {
    const files: Record<string, string> = {
      "a.ts": `const r = await fetch(\`${GEM}?key=\${k}\`, { method: "POST" });\n`,
      "a.py": `import requests\nurl = "${GEM}"\nrequests.post(url, json={})\n`,
      "A.java": `class A { void f() { String u = "${GEM}"; } }\n`,
      "a.go": `package main\nfunc f() { u := "${GEM}"; _ = u }\n`,
      "a.rb": `u = "${GEM}"\n`,
      "a.php": `<?php $u = "${GEM}";\n`,
      "A.cs": `class A { string U = "${GEM}"; }\n`,
    };
    const us = await scan(files);
    for (const f of Object.keys(files)) expect(us.find((u) => u.file === f), f).toMatchObject({ provider: "google", model: "gemini-1.5-pro", setting: true });
    const t = us.find((u) => u.file === "a.py")!;
    expect(files["a.py"].slice(t.modelSpan.start, t.modelSpan.end)).toBe("gemini-1.5-pro");
  });
  it("host context: Vertex (aiplatform) and Bedrock paths carry their host", async () => {
    const us = await scan({
      "a.ts": 'fetch("https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google/models/gemini-1.0-pro:predict");\n',
      "b.py": 'u = "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-sonnet-20240229-v1:0/invoke"\n',
      "c.go": 'package main\nvar base = "https://generativelanguage.googleapis.com/v1beta"\nvar path = "/models/gemini-1.5-flash:streamGenerateContent"\n',
    });
    expect(us.find((u) => u.file === "a.ts")).toMatchObject({ model: "gemini-1.0-pro", host: "vertex" });
    expect(us.find((u) => u.file === "b.py")).toMatchObject({ model: "anthropic.claude-3-sonnet-20240229-v1:0", host: "bedrock" });
    // a path piece joined to a base held elsewhere
    expect(us.find((u) => u.file === "c.go")).toMatchObject({ model: "gemini-1.5-flash", line: 3 });
  });
  it("config files too", async () => {
    const us = await scan({ "config/llm.yaml": `endpoint: ${GEM}\n# old: https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent\n` });
    expect(us.filter((u) => u.file === "config/llm.yaml").map((u) => u.model)).toEqual(["gemini-1.5-pro"]);
  });
  it("left alone: a model in a variable, an unknown model, a comment, a path without a model method", async () => {
    expect(urlModelsIn("https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro")).toEqual([]);
    expect(urlModelsIn("https://example.com/models/list:generateContent")).toHaveLength(1); // read, then rejected as no model below
    const us = await scan({
      "a.ts": 'const a = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;\n// https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent\nconst b = "https://example.com/models/my-model:generateContent";\nconst c = "https://generativelanguage.googleapis.com/v1beta/models";\n',
    });
    expect(us.filter((u) => u.file === "a.ts")).toEqual([]);
  });
});
