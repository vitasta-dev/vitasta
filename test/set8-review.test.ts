import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";
import { findImpacts, loadFeed } from "../src/feed/match.js";
import { haveTestFeed, TEST_FEED } from "./feed-data.js";

// these read feed records: the frozen test feed, absent from the public export (see test/feed-data.ts)
const itFeed = it.skipIf(!haveTestFeed);

// Review: (24 Nov): generic fixes, each tested on hand-written code (never set 8's)
const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-s8r-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const findings = async (files: Record<string, string>) => {
  const feed = await loadFeed(TEST_FEED);
  return findImpacts(await scanRepo(await repo(files)), feed, "2026-11-23") as any[];
};
const usages = async (files: Record<string, string>) => (await scanRepo(await repo(files))).usages as any[];

describe("b. sampling settings in a request built for another provider", () => {
  const conv = (dest: string) => `import type Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
const openai = new OpenAI();
const anthropic = new Anthropic();

export function toRequest(body: Anthropic.MessageCreateParams) {
  return {
    model: body.model,
    temperature: body.temperature,
  };
}

export async function relay(body: Anthropic.MessageCreateParams) {
  return ${dest}(toRequest(body));
}
`;
  it("not when the converted request goes to OpenAI", async () => {
    const us = await usages({ "src/convert.ts": conv("openai.responses.create") });
    expect(us.filter((u) => u.provider === "anthropic" && u.params?.includes("temperature"))).toEqual([]);
  });
  it("Python: a payload passed to chat.completions.create isn't Anthropic's", async () => {
    const us = await usages({ "conv.py": 'import anthropic\nfrom openai import OpenAI\nclient = OpenAI()\n\ndef to_chat(req: anthropic.types.MessageCreateParams):\n    payload = {\n        "model": req["model"],\n        "temperature": req.get("temperature"),\n    }\n    return client.chat.completions.create(**payload)\n' });
    expect(us.filter((u) => u.provider === "anthropic" && u.params?.includes("temperature"))).toEqual([]);
  });
});

describe("a. an OpenAI-Beta assistants header on a client", () => {
  const php = (call: string) => `<?php
namespace App;
use OpenAI;
class Ai
{
    private $client;
    public function __construct(string $key)
    {
        $this->client = OpenAI::factory()->withApiKey($key)
            ->withHttpHeader('OpenAI-Beta', 'assistants=v2')
            ->make();
    }
    public function ask(string $q)
    {
        return $this->client->${call};
    }
}
`;
  const assistants = (fs: any[]) => fs.filter((f) => f.change.id.startsWith("openai-assistants-api-shutdown") && f.usage.file === "src/Ai.php");
  itFeed("whose calls are all chat()->create isn't an Assistants call", async () => {
    expect(assistants(await findings({ "composer.json": '{"require":{"openai-php/client":"^0.10"}}', "src/Ai.php": php("chat()->create(['model' => 'gpt-4.1', 'messages' => []])") }))).toEqual([]);
  });
  itFeed("whose calls include assistants()->create is", async () => {
    expect(assistants(await findings({ "composer.json": '{"require":{"openai-php/client":"^0.10"}}', "src/Ai.php": php("assistants()->create(['model' => 'gpt-4.1'])") })).length).toBeGreaterThan(0);
  });
});

describe("1. view templates", () => {
  it("FB.init's version in a layout's script and a Graph URL in an href, at their real lines", async () => {
    const us = await usages({
      "app/views/layouts/application.html.erb": "<html>\n<script>\n  FB.init({ appId: '<%= ENV[\"FB\"] %>', xfbml: true, version: 'v2.8' });\n</script>\n<a href=\"https://graph.facebook.com/v3.0/me/picture\">pic</a>\n</html>\n",
    });
    const at = us.filter((u) => u.provider === "meta").map((u) => `${u.line}:${u.apiVersion}`);
    expect(at.some((x) => x.startsWith("3:") && x.includes("v2.8"))).toBe(true);
    expect(at.some((x) => x.startsWith("5:") && x.includes("v3.0"))).toBe(true);
    expect(us.find((u) => u.line === 5)?.snippet).toContain("<a href=");
  });
});

describe("2. API paths in constants, the host configured elsewhere", () => {
  it("Java: /v1/assistants and /v1/threads constants with a base URL defaulting to api.openai.com", async () => {
    const us = await usages({
      "src/main/java/a/Assistants.java": `package a;
import org.springframework.beans.factory.annotation.Value;
public class Assistants {
    private static final String ASSISTANTS_PATH = "/v1/assistants";
    private final WebClient web;
    public Assistants(WebClient.Builder b, @Value("\${openai.base-url:https://api.openai.com}") String baseUrl) {
        this.web = b.baseUrl(baseUrl).build();
    }
    public Mono<String> create(Object body) {
        return web.post().uri(ASSISTANTS_PATH).bodyValue(body).retrieve().bodyToMono(String.class);
    }
}
`,
    });
    const u = us.find((x) => x.provider === "openai" && x.line === 4);
    expect(u?.op).toBe("POST /v1/assistants");
    expect(u?.alsoLines).toEqual([10]);
  });
  it("not without a provider host in the file or its directory", async () => {
    const us = await usages({ "src/main/java/a/Other.java": 'package a;\npublic class Other {\n    private static final String P = "/v1/assistants";\n    String f() { return http.post(base + P); }\n}\n' });
    expect(us.filter((x) => x.provider === "openai")).toEqual([]);
  });
});

describe("3. the defining line is the finding, the request lines its alsoLines", () => {
  itFeed("JS constant, Python f-string base, Java @Value default", async () => {
    const fs = await findings({
      "dao.js": 'const GRAPH_BASE = "https://graph.facebook.com/v12.0";\n\nfunction a() { return 1; }\nfunction b() { return 2; }\n\nasync function me(token) {\n  const res = await fetch(`${GRAPH_BASE}/me?access_token=${token}`);\n  return res.json();\n}\n',
      "client.py": 'import requests\n\nAPI_VERSION = "v14.0"\nBASE = f"https://graph.facebook.com/{API_VERSION}"\n\n\ndef helper():\n    return 1\n\n\ndef get_page(page_id, token):\n    return requests.get(f"{BASE}/{page_id}", params={"access_token": token}).json()\n',
      "src/main/java/a/Graph.java": 'package a;\nimport org.springframework.beans.factory.annotation.Value;\npublic class Graph {\n    @Value("${facebook.graph.url:https://graph.facebook.com/v13.0}")\n    private String graphUrl;\n    private final RestTemplate rest = new RestTemplate();\n    public String a() { return "a"; }\n    public String b() { return "b"; }\n    public String me(String token) {\n        return rest.getForObject(graphUrl + "/me?access_token=" + token, String.class);\n    }\n}\n',
    });
    const at = (file: string) => fs.filter((f) => f.usage.file === file && f.usage.provider === "meta").map((f) => ({ line: f.usage.line, also: f.usage.alsoLines ?? [] }));
    expect(at("dao.js")).toEqual([{ line: 1, also: [7] }]);
    expect(at("client.py")).toEqual([{ line: 3, also: [4, 12] }]);
    expect(at("src/main/java/a/Graph.java")).toEqual([{ line: 4, also: [10] }]);
  });
});

describe("d. callers of a repo wrapper that fixes a version inside it", () => {
  itFeed("are the wrapper finding's other places (alsoAt), not findings of their own", async () => {
    const fs = await findings({
      "package.json": '{"name":"x"}',
      "src/lib/graph.ts": 'export async function graphGet(path: string, token: string) {\n  const res = await fetch(`https://graph.facebook.com/v12.0/${path}?access_token=${token}`);\n  return res.json();\n}\n',
      "src/pages.ts": 'import { graphGet } from "./lib/graph";\nexport async function pages(t: string) {\n  return graphGet("me/accounts", t);\n}\n',
      "src/me.ts": 'import { graphGet } from "./lib/graph";\nexport async function me(t: string) {\n  return graphGet("me", t);\n}\n',
    });
    const meta = fs.filter((f) => f.usage.provider === "meta");
    expect(meta.map((f) => f.usage.file)).toEqual(["src/lib/graph.ts"]);
    expect([...(meta[0].usage.alsoAt ?? [])].sort()).toEqual(["src/me.ts:3", "src/pages.ts:3"]);
  });
});
