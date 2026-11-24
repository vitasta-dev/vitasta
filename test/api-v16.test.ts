import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-v16-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const versions = (us: any[], file: string, provider: string) => us.filter((u) => u.file === file && u.provider === provider && u.role === "breaks" && u.apiVersion).map((u) => `${u.line} ${u.apiVersion}`);

describe("v16: test sets follow-ups (categories only)", () => {
  it("Go: a version constant below an import block of github.com paths is still the provider's", async () => {
    const d = await repo({
      "connectors/whatsapp/client.go": "package whatsapp\n\nimport (\n\t\"fmt\"\n\n\t\"github.com/acme/platform/pkg/connector\"\n)\n\nconst apiVersion = \"v21.0\"\n\nfunc url(p string) string {\n\treturn fmt.Sprintf(\"https://graph.facebook.com/%s/%s/messages\", apiVersion, p)\n}\n",
      "connectors/shopify/client.go": "package shopify\n\nimport (\n\t\"fmt\"\n\n\t\"github.com/acme/platform/pkg/connector\"\n)\n\nconst apiVersion = \"2024-10\"\n\nfunc url(s string) string {\n\treturn fmt.Sprintf(\"https://%s.myshopify.com/admin/api/%s/orders.json\", s, apiVersion)\n}\n",
    });
    const us = (await scanRepo(d)).usages;
    expect(versions(us, "connectors/whatsapp/client.go", "meta")).toContain("9 const: v21.0");
    expect(versions(us, "connectors/shopify/client.go", "shopify")).toContain("9 const: 2024-10");
  });
  it("a version named for something else (app, schema, protocol) isn't Meta's, even in a file about Facebook", async () => {
    const d = await repo({
      "cmd/fbsync/main.go": "package main\n\n// fbsync copies Facebook page posts\nconst (\n\tappVersion      = \"v2.1\"\n\tprotocolVersion = \"v2.1\"\n\tgraphVersion    = \"v21.0\"\n)\n\nvar base = \"https://graph.facebook.com/\" + graphVersion\n",
    });
    const v = versions((await scanRepo(d)).usages, "cmd/fbsync/main.go", "meta");
    expect(v.join(" ")).not.toMatch(/v2\.1/);
    expect(v).toContain("7 const: v21.0");
  });
  it("C#: a local read from config isn't the send; the request key is", async () => {
    const d = await repo({
      "Services/ClaudeClient.cs": "using System.Net.Http;\n\npublic class ClaudeClient {\n  public async Task<string> Ask(string p) {\n    var temperature = _config.Temperature;\n    var body = new Dictionary<string, object> { [\"model\"] = \"claude-sonnet-4-5\", [\"max_tokens\"] = 100 };\n    if (Supports(\"temperature\")) body[\"temperature\"] = temperature;\n    var res = await _http.PostAsync(\"https://api.anthropic.com/v1/messages\", Json(body));\n    return await res.Content.ReadAsStringAsync();\n  }\n}\n",
    });
    const s = (await scanRepo(d)).usages.filter((u: any) => u.file === "Services/ClaudeClient.cs" && u.provider === "anthropic" && u.role === "breaks" && u.params?.includes("temperature")).map((u: any) => u.line);
    expect(s).not.toContain(5);
    expect(s).toContain(7);
  });
});
