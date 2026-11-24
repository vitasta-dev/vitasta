import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scanRepo } from "../src/scan/index.js";

vi.setConfig({ testTimeout: 60_000 });

const scan = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-gomap-"));
  for (const [p, t] of Object.entries({ "go.mod": "module x\n\ngo 1.22\n", ...files })) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return (await scanRepo(d)).usages as any[];
};
// (a key another rule already reports at the same line is that rule's: the lines and keys are what matters)
const mine = (us: any[]) => [...new Set(us.filter((u) => u.params?.length && /marshals as the body/.test(u.reason ?? "")).map((u) => `${u.line}:${u.params[0]}`))];
const keys = (us: any[], file = "a.go") => [...new Set(us.filter((u) => u.file === file && u.params?.length && u.op).map((u) => `${u.line}:${u.params[0]}`))];
const wrap = (body: string, url = '"https://api.anthropic.com/v1/messages"') => `package main

import ("bytes"; "encoding/json"; "net/http")

func (c *Client) Ask(prompt string) error {
${body}
	b, _ := json.Marshal(payload)
	req, _ := http.NewRequest("POST", ${url}, bytes.NewReader(b))
	_, err := http.DefaultClient.Do(req)
	return err
}
`;

describe("Go map-literal request bodies", () => {
  it("the map's own top-level keys are the request's params, at their lines (any, interface{}, index assignment)", async () => {
    for (const ty of ["any", "interface{}"]) {
      const us = await scan({ "a.go": wrap(`\tpayload := map[string]${ty}{\n\t\t"model": "claude-3-5-sonnet-20241022",\n\t\t"temperature": c.Temperature,\n\t\t"messages": []map[string]string{{"role": "user", "content": prompt}},\n\t}\n\tpayload["top_p"] = c.TopP`) });
      expect(keys(us), ty).toEqual(expect.arrayContaining(["8:temperature", "11:top_p"]));
      expect(us.find((u) => u.line === 8 && u.params?.[0] === "temperature")).toMatchObject({ provider: "anthropic", op: "POST /v1/messages" });
      // keys of a nested map are not the request's
      expect(keys(us)).not.toContain("9:role");
    }
  });
  it("a package-constant URL, json.NewEncoder().Encode, and a helper that returns the map", async () => {
    const c = await scan({ "a.go": `package main\nimport ("bytes";"encoding/json";"net/http")\nconst apiURL = "https://api.anthropic.com/v1/messages"\nfunc ask(t float64) {\n\tpayload := map[string]any{\n\t\t"temperature": t,\n\t}\n\tb, _ := json.Marshal(payload)\n\thttp.NewRequest(http.MethodPost, apiURL, bytes.NewReader(b))\n}\n` });
    expect(mine(c)).toEqual(["6:temperature"]);
    const e = await scan({ "a.go": `package main\nimport ("encoding/json";"net/http")\nfunc ask(t float64) {\n\tpayload := map[string]any{"temperature": t, "top_p": 0.9}\n\tpr, pw := io.Pipe()\n\tgo json.NewEncoder(pw).Encode(payload)\n\thttp.Post("https://api.openai.com/v1/chat/completions", "application/json", pr)\n}\n` });
    expect(mine(e).sort()).toEqual(["4:temperature", "4:top_p"]);
    const h = await scan({ "a.go": `package main\nimport ("bytes";"encoding/json";"net/http")\nfunc build(t float64) map[string]any {\n\treturn map[string]any{\n\t\t"temperature": t,\n\t}\n}\nfunc ask(t float64) {\n\tb, _ := json.Marshal(build(t))\n\thttp.Post("https://api.anthropic.com/v1/messages", "application/json", bytes.NewReader(b))\n}\n` });
    // (found at the helper's key line; an earlier rule may report it first, b21's narrowed setter guard lets it)
    expect(keys(h)).toContain("5:temperature");
  });
  it("negatives: an Ollama request, a map that isn't marshalled, a map with no provider URL", async () => {
    const ollama = await scan({ "a.go": `package main\nimport ("bytes";"encoding/json";"net/http")\nfunc (o *Ollama) Gen(p string) {\n\tpayload := map[string]any{"model": "llama3", "prompt": p, "options": map[string]any{"temperature": 0.2}}\n\tb, _ := json.Marshal(payload)\n\thttp.Post(o.BaseURL+"/api/generate", "application/json", bytes.NewReader(b))\n}\n` });
    expect(keys(ollama)).toEqual([]);
    expect(mine(ollama)).toEqual([]);
    const unmarshalled = await scan({ "a.go": wrap(`\tpayload := map[string]any{"temperature": 0.1}\n\tother := map[string]any{"top_k": 3}\n\t_ = other`) });
    expect(mine(unmarshalled)).not.toContain("7:top_k"); // only the marshalled map counts
    const noUrl = await scan({ "a.go": wrap(`\tpayload := map[string]any{"temperature": 0.1}`, "o.URL") });
    expect(mine(noUrl)).toEqual([]);
  });
  it("a function that also sends elsewhere is possible, not likely", async () => {
    const us = await scan({ "a.go": wrap(`\tpayload := map[string]any{"temperature": 0.1}\n\t_ = "https://api.openai.com/v1/chat/completions"`) });
    const confs = us.filter((u) => u.params?.[0] === "temperature" && /marshals/.test(u.reason ?? "")).map((u) => u.confidence);
    // (the key must come from this rule here)
    expect(confs.length).toBeGreaterThan(0);
    expect(new Set(confs)).toEqual(new Set(["possible"]));
  });
});
