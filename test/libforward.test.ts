import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const FILES: Record<string, string> = {
  "package.json": "{ \"name\": \"claude-helper\", \"version\": \"1.0.0\", \"main\": \"dist/index.js\", \"dependencies\": { \"@anthropic-ai/sdk\": \"^0.60.0\" } }\n",
  "src/types.ts": "export interface GenerateOptions {\n  model?: string;\n  temperature?: number;\n  topP?: number;\n  maxTokens?: number;\n}\n",
  "src/index.ts": "import Anthropic from \"@anthropic-ai/sdk\";\nimport type { GenerateOptions } from \"./types\";\n\nconst client = new Anthropic();\nexport async function generate(prompt: string, options: GenerateOptions = {}) {\n  return client.messages.create({\n    model: options.model ?? \"claude-sonnet-4-5\",\n    max_tokens: 1024,\n    messages: [{ role: \"user\", content: prompt }],\n    ...options,\n  });\n}\n"
};
const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-libfwd-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};

describe("C: a published library forwarding its callers' settings", () => {
  it("a provider call spreading an options parameter: the options type's settings, as possible", async () => {
    const us = (await scanRepo(await repo(FILES))).usages.filter((u: any) => u.file === "src/types.ts");
    expect(us.map((u: any) => `${u.line}:${u.params[0]}:${u.confidence}`)).toEqual(["3:temperature:possible", "4:top_p:possible"]);
  });
  it("not in an app (a private package)", async () => {
    const priv = { ...FILES, "package.json": JSON.stringify({ name: "app", private: true, main: "x.js" }) };
    const us = (await scanRepo(await repo(priv))).usages.filter((u: any) => u.file === "src/types.ts");
    expect(us).toEqual([]);
  });
});
