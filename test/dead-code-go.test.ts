import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scanRepo } from "../src/scan/index.js";

vi.setConfig({ testTimeout: 120_000 });

const scan = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-deadgo-"));
  for (const [p, t] of Object.entries({ "go.mod": "module example.com/app\n\ngo 1.22\n", ...files })) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return ((await scanRepo(d)).usages as any[]).filter((u) => u.provider === "openai");
};
const deadAt = (us: any[], file: string) => [...new Set(us.filter((u) => u.file === file).map((u) => !!u.dead))];

const CLIENT = (pkg = "assistants") => `package ${pkg}

import (
	"bytes"
	"net/http"
)

// AssistantClient talks to the Assistants API.
type AssistantClient struct {
	key string
}

// NewAssistantClient builds a client.
func NewAssistantClient(key string) *AssistantClient {
	return &AssistantClient{key: key}
}

func (c *AssistantClient) CreateThread() (*http.Response, error) {
	req, _ := http.NewRequest("POST", "https://api.openai.com/v1/threads", bytes.NewReader(nil))
	req.Header.Set("OpenAI-Beta", "assistants=v2")
	return http.DefaultClient.Do(req)
}

func (c *AssistantClient) Run(threadID string) (*http.Response, error) {
	req, _ := http.NewRequest("POST", "https://api.openai.com/v1/threads/"+threadID+"/runs", bytes.NewReader(nil))
	req.Header.Set("OpenAI-Beta", "assistants=v2")
	return http.DefaultClient.Do(req)
}
`;
const MAIN = `package main\n\nfunc main() {\n\tprintln("hi")\n}\n`;

describe("dead code: exported Go code nothing refers to, in an app (not a library)", () => {
  it("the blind-set-18 shape: an unused client type, its constructor and its methods", async () => {
    for (const path of ["internal/assistants/client.go", "assistants/client.go", "cmd/tool/helper.go"]) {
      const us = await scan({ "main.go": MAIN, [path]: path.startsWith("cmd/") ? CLIENT("main") : CLIENT() });
      expect(us.some((u) => u.file === path), path).toBe(true);
      expect(deadAt(us, path), path).toEqual([true]);
    }
    const us = await scan({ "main.go": MAIN, "internal/a/client.go": CLIENT("a") });
    const u = us.find((x) => x.file === "internal/a/client.go" && /threads/.test(x.op ?? ""));
    expect(u.reason).toMatch(/AssistantClient/);
    expect(["likely", "possible"]).toContain(u.confidence);
  });
  it("an exported function nothing calls is dead; one used by another package, or by a test, is live", async () => {
    const fn = (name: string) => `package util\n\nimport "net/http"\n\nfunc ${name}() {\n\thttp.Post("https://api.openai.com/v1/threads", "application/json", nil)\n}\n`;
    expect(deadAt(await scan({ "main.go": MAIN, "internal/util/u.go": fn("Unused") }), "internal/util/u.go")).toEqual([true]);
    expect(deadAt(await scan({ "main.go": "package main\nimport \"example.com/app/internal/util\"\nfunc main() { util.Used() }\n", "internal/util/u.go": fn("Used") }), "internal/util/u.go")).toEqual([false]);
    expect(deadAt(await scan({ "main.go": MAIN, "internal/util/u.go": fn("Tested"), "internal/util/u_test.go": "package util\nimport \"testing\"\nfunc TestX(t *testing.T) { Tested() }\n" }), "internal/util/u.go")).toEqual([false]);
  });
  it("negatives: the constructor or type used elsewhere, an interface assertion, a registration call", async () => {
    const used = "package main\nimport \"example.com/app/internal/assistants\"\nfunc main() { c := assistants.NewAssistantClient(\"k\"); c.CreateThread() }\n";
    expect(deadAt(await scan({ "main.go": used, "internal/assistants/client.go": CLIENT() }), "internal/assistants/client.go")).toEqual([false]);
    const assertion = CLIENT() + "\ntype Threads interface{ CreateThread() (*http.Response, error) }\n\nvar _ Threads = (*AssistantClient)(nil)\n";
    expect(deadAt(await scan({ "main.go": MAIN, "internal/assistants/client.go": assertion }), "internal/assistants/client.go")).toEqual([false]);
    const reg = "package main\nimport \"example.com/app/internal/assistants\"\nfunc init() { registry.Register(&assistants.AssistantClient{}) }\nfunc main() {}\n";
    expect(deadAt(await scan({ "main.go": reg, "internal/assistants/client.go": CLIENT() }), "internal/assistants/client.go")).toEqual([false]);
    // a type used in a struct field elsewhere
    const field = "package main\nimport \"example.com/app/internal/assistants\"\ntype App struct{ c *assistants.AssistantClient }\nfunc main() {}\n";
    expect(deadAt(await scan({ "main.go": field, "internal/assistants/client.go": CLIENT() }), "internal/assistants/client.go")).toEqual([false]);
  });
  it("a library module (no main package, or a pkg/ API) keeps its exported API live", async () => {
    expect(deadAt(await scan({ "assistants/client.go": CLIENT() }), "assistants/client.go")).toEqual([false]);
    expect(deadAt(await scan({ "main.go": MAIN, "pkg/assistants/client.go": CLIENT() }), "pkg/assistants/client.go")).toEqual([false]);
    // an internal/ path is never imported from outside, even in a library module
    expect(deadAt(await scan({ "internal/assistants/client.go": CLIENT() }), "internal/assistants/client.go")).toEqual([true]);
  });
});
