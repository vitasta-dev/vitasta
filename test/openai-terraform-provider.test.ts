import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scanRepo } from "../src/scan/index.js";

vi.setConfig({ testTimeout: 120_000 });

const scan = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-oa-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return (await scanRepo(d)).usages as any[];
};

const GOMOD = "module example.com/tf\n\ngo 1.22\n";
const PROVIDER = `package provider
func Provider() *schema.Provider {
	return &schema.Provider{
		Schema: map[string]*schema.Schema{
			"api_url": {Type: schema.TypeString, Optional: true, Default: "https://api.openai.com/v1"},
		},
	}
}
`;
const opsAt = (us: any[], file: string) => us.filter((u) => u.file === file && u.op).map((u) => `${u.line} ${u.op}`);

describe("a Go Terraform-provider resource: c.APIURL joined to a path, with the base as the schema default", () => {
  it("(a) c.APIURL + \"/audio/translations\" is POST /v1/audio/translations, the client struct beside the call or in another file", async () => {
    const client = `package provider
import ("net/http";"bytes")
type Client struct { APIURL string; Key string }
func (c *Client) Translate(b []byte) (*http.Response, error) {
	req, _ := http.NewRequest("POST", c.APIURL+"/audio/translations", bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer "+c.Key)
	return http.DefaultClient.Do(req)
}
`;
    expect(opsAt(await scan({ "go.mod": GOMOD, "provider.go": PROVIDER, "client.go": client }), "client.go")).toContain("5 POST /v1/audio/translations");
    const split = client.replace("type Client struct { APIURL string; Key string }\n", "");
    expect(opsAt(await scan({ "go.mod": GOMOD, "provider.go": PROVIDER + "type Client struct {\n\tAPIURL string\n\tKey string\n}\n", "client.go": split }), "client.go")).toContain("4 POST /v1/audio/translations");
  });
  it("(b) a Prompt object set on the request struct is the Responses prompt param, at the line that sets it, with the field as another place", async () => {
    const src = `package provider
import ("net/http";"bytes";"encoding/json")
type PromptConfig struct {
	ID string \`json:"id"\`
	Version string \`json:"version,omitempty"\`
}
type apiRequest struct {
	Model string \`json:"model"\`
	Prompt *PromptConfig \`json:"prompt,omitempty"\`
}
type Client struct{}
func (c *Client) Respond(id, version string) (*http.Response, error) {
	apiReqData := apiRequest{Model: "gpt-4o"}
	apiReqData.Prompt = &PromptConfig{ID: id, Version: version}
	body, _ := json.Marshal(apiReqData)
	req, _ := http.NewRequest("POST", "https://api.openai.com/v1/responses", bytes.NewReader(body))
	return http.DefaultClient.Do(req)
}
`;
    const us = await scan({ "go.mod": GOMOD, "client.go": src });
    const p = us.find((u) => u.file === "client.go" && u.params?.includes("prompt") && u.op === "POST /v1/responses");
    expect(p).toBeTruthy();
    expect([p.line, ...(p.alsoLines ?? [])]).toEqual(expect.arrayContaining([15]));
  });
  it("negatives: no schema default for that field, a different provider's base, a path that isn't an operation", async () => {
    const call = (f: string, path: string) => `package provider\nimport "net/http"\ntype Client struct { ${f} string }\nfunc (c *Client) T() {\n\thttp.NewRequest("POST", c.${f}+"${path}", nil)\n}\n`;
    // the schema sets no such key
    expect(opsAt(await scan({ "go.mod": GOMOD, "provider.go": PROVIDER.replace("api_url", "region"), "client.go": call("APIURL", "/audio/translations") }), "client.go").filter((o) => /translations/.test(o))).toEqual([]);
    // not an operation
    expect(opsAt(await scan({ "go.mod": GOMOD, "provider.go": PROVIDER, "client.go": call("APIURL", "/widgets") }), "client.go")).toEqual([]);
    // a base that isn't a provider's
    expect(opsAt(await scan({ "go.mod": GOMOD, "provider.go": PROVIDER.replace("api.openai.com", "api.example.com"), "client.go": call("APIURL", "/audio/translations") }), "client.go")).toEqual([]);
  });
  it("a request that names its method says it: POST, not an unknown verb", async () => {
    const us = await scan({ "go.mod": GOMOD, "provider.go": PROVIDER, "client.go": `package provider\nimport "net/http"\ntype Client struct { APIURL string }\nfunc (c *Client) T() {\n\thttp.NewRequest("POST", c.APIURL+"/audio/translations", nil)\n}\n` });
    const u = us.find((x) => x.file === "client.go" && /translations/.test(x.op ?? ""));
    expect(u).toMatchObject({ op: "POST /v1/audio/translations", confidence: "likely" });
  });
});
