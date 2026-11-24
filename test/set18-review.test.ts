import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

// Review: (24 Nov): generic fixes on hand-written code (never set 18's)
const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-s18r-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const usages = async (files: Record<string, string>) => (await scanRepo(await repo(files))).usages as any[];

describe("Go request structs: the finding is where the method sets the value", () => {
  it("a struct right above the method: the method's line, with the tag line as a place", async () => {
    const src = 'package llm\n\nimport (\n\t"bytes"\n\t"encoding/json"\n\t"net/http"\n)\n\ntype MessageRequest struct {\n\tModel       string  `json:"model"`\n\tTemperature float64 `json:"temperature,omitempty"`\n\tTopP        float64 `json:"top_p,omitempty"`\n}\n\nfunc ChatWithReasoning(p string, t float64) (*http.Response, error) {\n\tr := MessageRequest{Model: "claude-sonnet-4-5", Temperature: 1.0, TopP: t}\n\tb, _ := json.Marshal(r)\n\treturn http.Post("https://api.anthropic.com/v1/messages", "application/json", bytes.NewReader(b))\n}\n';
    const us = await usages({ "go.mod": "module x\n", "llm/a.go": src });
    const t = us.filter((u) => u.params?.includes("temperature") && u.op === "POST /v1/messages");
    expect(t.map((u) => u.line)).toContain(16);
    expect(t.map((u) => u.line)).not.toContain(11);
  });
  it("a struct the function doesn't set a field of: the tag line, as before", async () => {
    const src = 'package llm\n\nimport (\n\t"bytes"\n\t"encoding/json"\n\t"net/http"\n)\n\ntype MessageRequest struct {\n\tTemperature float64 `json:"temperature,omitempty"`\n}\n\nfunc Send(r MessageRequest) (*http.Response, error) {\n\tb, _ := json.Marshal(r)\n\treturn http.Post("https://api.anthropic.com/v1/messages", "application/json", bytes.NewReader(b))\n}\n';
    const us = await usages({ "go.mod": "module x\n", "llm/a.go": src });
    expect(us.some((u) => u.line === 10 && u.params?.includes("temperature"))).toBe(true);
  });
});
