import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scanRepo } from "../src/scan/index.js";

vi.setConfig({ testTimeout: 120_000 });

const providers = async (files: Record<string, string>, file: string) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-mktpaths-"));
  for (const [p, t] of Object.entries({ "go.mod": "module x\n\ngo 1.22\n", ...files })) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  const us = ((await scanRepo(d)).usages as any[]).filter((u) => u.file === file && /graph|facebook/i.test(u.snippet ?? "") && u.apiVersion);
  expect(us.length).toBeGreaterThan(0);
  return [...new Set(us.map((u) => u.provider))];
};

const GO = (calls: string) => `package ads
import ("fmt";"net/http";"io")
const baseURL = "https://graph.facebook.com/v24.0"
type Client struct{ token string }
func (c *Client) doGet(path string) (*http.Response, error) {
	return http.Get(baseURL + "/" + path + "?access_token=" + c.token)
}
func (c *Client) doPost(path string, body io.Reader) (*http.Response, error) {
	return http.Post(baseURL + "/" + path, "application/json", body)
}
var _ = fmt.Sprintf
${calls}
`;

describe("a Graph base URL joined to Marketing endpoints is the Marketing record", () => {
  it("Go: a base used by doGet / doPost wrappers called with act_*/campaigns, adsets, ads, insights", async () => {
    const calls = `func (c *Client) Campaigns(id string) { c.doGet(fmt.Sprintf("act_%s/campaigns", id)) }
func (c *Client) AdSets(id string) { c.doGet(fmt.Sprintf("act_%s/adsets", id)) }
func (c *Client) Insights(id string) { c.doGet("act_" + id + "/insights") }
func (c *Client) CreateAd(id string, b io.Reader) { c.doPost("act_"+id+"/ads", b) }`;
    expect(await providers({ "client.go": GO(calls) }, "client.go")).toEqual(["meta-marketing"]);
  });
  it("Go, TS and Python: the path joined to the base directly", async () => {
    expect(await providers({ "c.go": `package a\nimport "net/http"\nconst base = "https://graph.facebook.com/v24.0"\nfunc f(id string) { http.Get(base + "/act_" + id + "/campaigns") }\nfunc g(id string) { http.Get(base + "/" + id + "/insights") }\n` }, "c.go")).toEqual(["meta-marketing"]);
    expect(await providers({ "c.ts": `const BASE = "https://graph.facebook.com/v24.0";\nexport const f = (id: string) => fetch(BASE + "/act_" + id + "/adsets");\nexport const g = (id: string) => fetch(BASE + "/" + id + "/ads");\n` }, "c.ts")).toEqual(["meta-marketing"]);
    expect(await providers({ "c.py": `import requests\nBASE = "https://graph.facebook.com/v24.0"\ndef f(i):\n    return requests.get(BASE + "/act_" + i + "/campaigns")\ndef g(i):\n    return requests.get(BASE + "/" + i + "/insights")\n` }, "c.py")).toEqual(["meta-marketing"]);
  });
  it("negatives: Graph paths (me, accounts, messages), a minority of Marketing paths, no joined path at all", async () => {
    expect(await providers({ "c.go": `package a\nimport "net/http"\nconst base = "https://graph.facebook.com/v24.0"\nfunc a() { http.Get(base + "/me/accounts") }\nfunc b(id string) { http.Post(base + "/" + id + "/messages", "", nil) }\nfunc c() { http.Get(base + "/me/feed") }\nfunc d(id string) { http.Get(base + "/" + id + "/insights") }\n` }, "c.go")).toEqual(["meta"]);
    expect(await providers({ "c.go": `package a\nconst base = "https://graph.facebook.com/v24.0"\nvar _ = base\n` }, "c.go")).toEqual(["meta"]);
    // a base that carries its own Graph path isn't a bare base
    expect(await providers({ "c.ts": `const URL_ = "https://graph.facebook.com/v24.0/me";\nexport const f = () => fetch(URL_ + "/campaigns");\n` }, "c.ts")).toEqual(["meta"]);
  });
});
