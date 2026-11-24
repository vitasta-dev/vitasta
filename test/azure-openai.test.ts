import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findImpacts } from "../src/feed/match.js";
import { scanRepo } from "../src/scan/index.js";
import type { ChangeRecord } from "../src/types.js";

vi.setConfig({ testTimeout: 120_000 });

// the three draft records of the feed branch feed-drafts/azure-google-2026-11 (data/azure-openai.json), trimmed
const FEED = [
  {
    "id": "azure-openai-assistants-sunset-2026-08-26",
    "provider": "azure-openai",
    "type": "endpoint_shutdown",
    "title": "Azure OpenAI Assistants API is sunset (26 Aug 2026)",
    "selector": {
      "ops": [
        "* /openai/assistants",
        "* /openai/assistants/{}",
        "* /openai/threads",
        "* /openai/threads/{}",
        "* /openai/threads/{}/messages",
        "* /openai/threads/{}/runs",
        "* /openai/threads/{}/runs/{}",
        "* /openai/threads/runs"
      ]
    },
    "effective": "2026-08-26",
    "trigger": "date",
    "replacement": "the Responses API and Foundry Agent Service",
    "guide": "https://learn.microsoft.com/en-us/azure/foundry/how-to/navigate-from-classic",
    "sources": [
      {
        "url": "https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle"
      }
    ]
  },
  {
    "id": "azure-openai-on-your-data-retired-2026-10-14",
    "provider": "azure-openai",
    "type": "param_removed",
    "title": "Azure OpenAI On Your Data (data_sources on chat completions) is retired (14 Oct 2026)",
    "selector": {
      "ops": [
        "POST /openai/deployments/{}/chat/completions",
        "POST /openai/deployments/{}/extensions/chat/completions"
      ],
      "params": [
        "data_sources"
      ]
    },
    "effective": "2026-10-14",
    "trigger": "date",
    "replacement": "Foundry IQ (Azure AI Search); migration is not automatic",
    "guide": "https://learn.microsoft.com/en-us/azure/foundry-classic/openai/references/on-your-data",
    "sources": [
      {
        "url": "https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle"
      }
    ]
  },
  {
    "id": "azure-openai-realtime-preview-deprecated-2026-04-30",
    "provider": "azure-openai",
    "type": "endpoint_shutdown",
    "title": "Azure OpenAI Realtime preview protocol (/openai/realtime?api-version=\u2026-preview) is deprecated (30 Apr 2026)",
    "selector": {
      "ops": [
        "* /openai/realtime"
      ]
    },
    "effective": "2026-04-30",
    "trigger": "date",
    "replacement": "/openai/v1/realtime (and /openai/v1/realtime/client_secrets, /openai/v1/realtime/calls for WebRTC)",
    "guide": "https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-preview-api-migration-guide",
    "sources": [
      {
        "url": "https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle"
      }
    ]
  }
] as unknown as ChangeRecord[];

const AZ: Record<string, Record<string, string>> = {
py: { "a.py": `from openai import AzureOpenAI
client = AzureOpenAI(azure_endpoint="https://res.openai.azure.com", api_version="2024-05-01-preview", api_key="k")
def go():
    a = client.beta.assistants.create(model="gpt-4o-deploy", instructions="x")
    t = client.beta.threads.create()
    r = client.beta.threads.runs.create(thread_id=t.id, assistant_id=a.id)
    return client.chat.completions.create(
        model="gpt4-deploy",
        messages=[],
        extra_body={"data_sources": [{"type": "azure_search", "parameters": {}}]},
    )
` },
ts: { "a.ts": `import { AzureOpenAI } from "openai";
const client = new AzureOpenAI({ endpoint: "https://res.openai.azure.com", apiVersion: "2024-05-01-preview", apiKey: "k" });
export async function go() {
  const a = await client.beta.assistants.create({ model: "gpt-4o-deploy", instructions: "x" });
  const t = await client.beta.threads.create();
  return client.chat.completions.create({
    model: "gpt4-deploy",
    messages: [],
    // @ts-expect-error
    data_sources: [{ type: "azure_search", parameters: {} }],
  });
}
` },
js: { "a.js": `const { AzureOpenAI } = require("openai");
const client = new AzureOpenAI({ endpoint: "https://res.openai.azure.com", apiVersion: "2024-05-01-preview" });
async function go() {
  return client.beta.threads.runs.create("t", { assistant_id: "a" });
}
` },
cs: { "A.cs": `using Azure.AI.OpenAI;
using OpenAI.Assistants;
using OpenAI.Chat;
class A {
  void F() {
    AzureOpenAIClient client = new(new Uri("https://res.openai.azure.com"), new System.ClientModel.ApiKeyCredential("k"));
    AssistantClient ac = client.GetAssistantClient();
    var a = ac.CreateAssistant("gpt-4o-deploy");
    ChatClient chat = client.GetChatClient("gpt4-deploy");
    var options = new ChatCompletionOptions();
    options.AddDataSource(new AzureSearchChatDataSource());
    chat.CompleteChat(new ChatMessage[] {}, options);
  }
}
` },
java: { "A.java": `import com.azure.ai.openai.OpenAIClient;
import com.azure.ai.openai.OpenAIClientBuilder;
import com.azure.ai.openai.models.ChatCompletionsOptions;
class A {
  void f() {
    OpenAIClient client = new OpenAIClientBuilder().endpoint("https://res.openai.azure.com").buildClient();
    ChatCompletionsOptions options = new ChatCompletionsOptions(java.util.List.of());
    options.setDataSources(java.util.List.of());
    client.getChatCompletions("gpt4-deploy", options);
  }
}
` },
go: { "go.mod": "module x\n\ngo 1.22\n\nrequire github.com/Azure/azure-sdk-for-go/sdk/ai/azopenai v0.7.0\n", "a.go": `package main
import "github.com/Azure/azure-sdk-for-go/sdk/ai/azopenai"
func f() {
	client, _ := azopenai.NewClientWithKeyCredential("https://res.openai.azure.com", nil, nil)
	d := "gpt4-deploy"
	client.GetChatCompletions(ctx, azopenai.ChatCompletionsOptions{
		DeploymentName: &d,
		AzureExtensionsOptions: []azopenai.AzureChatExtensionConfigurationClassification{},
	}, nil)
}
` },
raw: {
"a.py": `import requests
def f():
    return requests.post("https://res.openai.azure.com/openai/deployments/gpt4/chat/completions?api-version=2024-02-01", json={"messages": [], "data_sources": []})
def g():
    return requests.post("https://res.openai.azure.com/openai/assistants?api-version=2024-05-01-preview", json={"model": "gpt4"})
def h(t):
    return requests.post(f"https://res.openai.azure.com/openai/threads/{t}/runs?api-version=2024-05-01-preview", json={})
`,
"b.ts": `export const f = () => fetch("https://res.cognitiveservices.azure.com/openai/threads?api-version=2024-05-01-preview", { method: "POST" });
export const ws = () => new WebSocket("wss://res.openai.azure.com/openai/realtime?api-version=2024-10-01-preview&deployment=gpt-4o-realtime");
export const foundry = () => fetch("https://res.services.ai.azure.com/openai/deployments/x/chat/completions?api-version=2024-02-01", { method: "POST" });
`},
neg: {
"a.py": `import requests
requests.post("https://api.openai.com/v1/assistants", json={})
requests.post("https://res.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview", json={})
requests.get("https://myacct.blob.core.windows.net/openai/assistants")
requests.get("https://management.azure.com/subscriptions/x/resourceGroups/y/providers/Microsoft.CognitiveServices/accounts/z")
`},
};

const scan = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-azure-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return scanRepo(d);
};
const az = (map: Awaited<ReturnType<typeof scan>>) => map.usages.filter((u) => u.provider === "azure-openai");
const ops = (map: Awaited<ReturnType<typeof scan>>) => az(map).map((u) => u.op).sort();
const hit = (map: Awaited<ReturnType<typeof scan>>) => [...new Set(findImpacts(map, FEED, "2026-11-25").map((f) => f.change.id.replace(/^azure-openai-/, "").replace(/-20\d\d-.*/, "")))].sort();

describe("azure-openai: the SDKs and raw HTTP", () => {
  it("Python AzureOpenAI: assistants, threads, runs and a chat with data_sources through extra_body", async () => {
    const m = await scan(AZ.py);
    expect(ops(m)).toEqual(["* /openai/assistants", "* /openai/threads", "* /openai/threads", "POST /openai/deployments/{deployment}/chat/completions"]);
    expect(az(m).find((u) => /chat/.test(u.op ?? ""))?.params).toContain("data_sources");
    expect(hit(m)).toEqual(["assistants-sunset", "on-your-data-retired"]);
  });
  it("TS and JS AzureOpenAI (from the openai package)", async () => {
    const ts = await scan(AZ.ts);
    expect(ops(ts)).toEqual(["* /openai/assistants", "* /openai/threads", "POST /openai/deployments/{deployment}/chat/completions"]);
    expect(hit(ts)).toEqual(["assistants-sunset", "on-your-data-retired"]);
    const js = await scan(AZ.js);
    expect(ops(js)).toEqual(["* /openai/threads"]);
  });
  it("the OpenAI-path copy of an Azure call keeps its model (Azure's model retirements) but no operation", async () => {
    const m = await scan(AZ.py);
    const o = m.usages.filter((u) => u.provider === "openai" && u.file === "a.py" && u.kind === "sdk");
    expect(o.length).toBeGreaterThan(0);
    for (const u of o) expect(u).toMatchObject({ host: "azure" });
    for (const u of o) expect(u.op).toBeUndefined();
    expect(o.some((u) => u.model === "gpt-4o-deploy")).toBe(true);
  });
  it("C# Azure.AI.OpenAI: assistants and a chat with an Azure Search data source", async () => {
    const m = await scan(AZ.cs);
    expect(ops(m)).toEqual(["* /openai/assistants", "POST /openai/deployments/{deployment}/chat/completions", "POST /openai/deployments/{deployment}/chat/completions"]);
    expect(az(m).filter((u) => u.params?.includes("data_sources")).map((u) => u.line)).toEqual([12]);
  });
  it("Java com.azure:azure-ai-openai and Go azopenai: client methods by name, with the data source options", async () => {
    expect(ops(await scan(AZ.java))).toEqual(["POST /openai/deployments/{deployment}/chat/completions"]);
    expect(az(await scan(AZ.java))[0].params).toEqual(["data_sources"]);
    const go = await scan(AZ.go);
    expect(ops(go)).toEqual(["POST /openai/deployments/{deployment}/chat/completions"]);
    expect(az(go)[0].params).toEqual(["data_sources"]);
    expect(hit(go)).toEqual(["on-your-data-retired"]);
  });
  it("raw HTTP to the Azure hosts (openai.azure.com, cognitiveservices.azure.com, services.ai.azure.com /openai/…), with the api-version and the Realtime URL", async () => {
    const m = await scan(AZ.raw);
    expect(ops(m)).toEqual(["* /openai/realtime", "POST /openai/assistants", "POST /openai/deployments/gpt4/chat/completions", "POST /openai/deployments/x/chat/completions", "POST /openai/threads", "POST /openai/threads/{id}/runs"]);
    expect(az(m).find((u) => u.op === "POST /openai/deployments/gpt4/chat/completions")).toMatchObject({ apiVersion: "url: 2024-02-01", params: expect.arrayContaining(["data_sources"]) });
    expect(az(m).find((u) => u.op === "* /openai/realtime")).toMatchObject({ apiVersion: "url: 2024-10-01-preview", file: "b.ts", line: 2 });
    expect(hit(m)).toEqual(["assistants-sunset", "on-your-data-retired", "realtime-preview-deprecated"]);
  });
});

describe("azure-openai: negatives", () => {
  it("a plain api.openai.com call stays OpenAI and matches none of the Azure records", async () => {
    const m = await scan({ "a.py": 'import requests\nrequests.post("https://api.openai.com/v1/assistants", json={})\n', "b.py": 'from openai import OpenAI\nc = OpenAI()\nc.beta.threads.create()\n' });
    expect(az(m)).toEqual([]);
    expect(m.usages.some((u) => u.provider === "openai" && u.op === "POST /v1/assistants")).toBe(true);
    expect(m.usages.some((u) => u.provider === "openai" && u.op === "* /v1/threads")).toBe(true);
    expect(hit(m)).toEqual([]);
  });
  it("an Azure host that isn't the OpenAI API gives nothing", async () => {
    const m = await scan(AZ.neg);
    expect(az(m)).toEqual([]);
    const other = await scan({ "a.py": 'import requests\nrequests.post("https://res.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview", json={})\nrequests.get("https://res.search.windows.net/indexes?api-version=2023-11-01")\nrequests.get("https://res.openai.azure.com/health")\n' });
    expect(az(other)).toEqual([]);
  });
  it("an AzureOpenAI call whose operation isn't Azure's (no /v1 path) is left as it was", async () => {
    const m = await scan({ "a.py": 'from openai import AzureOpenAI\nc = AzureOpenAI(azure_endpoint="https://r.openai.azure.com", api_version="2024-02-01")\nc.models.list()\n' });
    expect(az(m).map((u) => u.op)).toEqual(["GET /openai/models"]);
  });
});
