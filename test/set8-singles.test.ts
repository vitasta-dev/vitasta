import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

// Category 5 of the blind, as generic rules (hand-written code, not set 8's)
const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-s8s-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const usages = async (files: Record<string, string>) => (await scanRepo(await repo(files))).usages as any[];

const goClient = (urls: string) => `package llm

import (
	"bytes"
	"encoding/json"
	"net/http"
)

type ChatRequest struct {
	Model       string  \`json:"model"\`
	Temperature float64 \`json:"temperature,omitempty"\`
}

func Send(apiType, baseURL string, req ChatRequest) (*http.Response, error) {
	body, _ := json.Marshal(req)
${urls}
	r, _ := http.NewRequest("POST", url, bytes.NewReader(body))
	return http.DefaultClient.Do(r)
}
`;

describe("Go: a struct marshalled as the body of a provider request", () => {
  it("its json-tagged fields are Anthropic's settings when the function sends to /v1/messages (possible with a branch)", async () => {
    const us = await usages({ "llm/client.go": goClient('\turl := baseURL + "/v1/chat/completions"\n\tif apiType == "anthropic" {\n\t\turl = "https://api.anthropic.com/v1/messages"\n\t}') });
    const t = us.find((u) => u.provider === "anthropic" && u.params?.includes("temperature"));
    expect(t?.line).toBe(11);
    expect(t?.confidence).toBe("possible");
  });
  it("not when the function only sends to OpenAI", async () => {
    const us = await usages({ "llm/client.go": goClient('\turl := "https://api.openai.com/v1/chat/completions"') });
    expect(us.filter((u) => u.provider === "anthropic")).toEqual([]);
  });
});

describe("a relay's route for a provider path", () => {
  const router = 'package relay\n\nimport "net/http"\n\nfunc Register(mux *http.ServeMux, h http.Handler) {\n\tmux.Handle("/v1/audio/translations", h)\n}\n';
  it("is that provider's operation when the package names its host", async () => {
    const us = await usages({ "relay/router.go": router, "relay/upstream.go": 'package relay\n\nconst OpenAIBase = "https://api.openai.com"\n' });
    expect(us.find((u) => u.provider === "openai" && u.file === "relay/router.go")?.op).toBe("* /v1/audio/translations");
  });
  it("not without a provider host in the package", async () => {
    const us = await usages({ "relay/router.go": router });
    expect(us.filter((u) => u.file === "relay/router.go")).toEqual([]);
  });
});

describe("PHP: a bare version number joined after a literal /v", () => {
  it("the property's line is the finding, its own file's URL lines alsoLines; a same-named property elsewhere too", async () => {
    const us = await usages({
      "src/FbApi.php": "<?php\nnamespace App;\n\nclass FbApi\n{\n    public static $fb_api_version = '14.0';\n\n    public function me(string $t): string\n    {\n        return file_get_contents(\"https://graph.facebook.com/v\" . self::$fb_api_version . \"/me?access_token=\" . $t);\n    }\n}\n",
      "src/Insights.php": "<?php\nnamespace App;\n\nclass Insights\n{\n    private static $fb_api_version = '14.0';\n\n    public function get(string $id): string\n    {\n        return file_get_contents('https://graph.facebook.com/v' . FbApi::$fb_api_version . '/' . $id);\n    }\n}\n",
    });
    const at = us.filter((u) => u.provider === "meta" && /14\.0/.test(u.apiVersion ?? "")).map((u) => `${u.file}:${u.line}`);
    expect(at).toContain("src/FbApi.php:6");
    expect(at).toContain("src/Insights.php:6");
    expect(us.find((u) => u.file === "src/FbApi.php" && u.line === 6)?.alsoLines).toEqual([10]);
  });
});

describe("a published client library's API version constant", () => {
  const constants = 'package com.acme.client;\n\npublic final class ApiInfo {\n    public static final String VERSION = "2026-10";\n    public static final String RELEASED = "2026-10";\n}\n';
  const pom = (extra: string, desc = "Shopify Admin API GraphQL client") => `<project><modelVersion>4.0.0</modelVersion><groupId>com.acme</groupId><artifactId>admin-graphql-client</artifactId><version>1.0.0</version>${extra}<description>${desc}</description></project>`;
  const files = (p: string) => ({ "client/pom.xml": p, "client/src/main/java/com/acme/client/ApiInfo.java": constants });
  it("is the library's default version (possible), when its manifest names the provider", async () => {
    const us = (await usages(files(pom("")))).filter((u) => u.provider === "shopify");
    expect(us.map((u) => `${u.line}:${u.confidence}`)).toEqual(["4:possible"]);
  });
  it("not in an application module, nor when nothing names the provider", async () => {
    expect((await usages(files(pom("<packaging>war</packaging>")))).filter((u) => u.provider === "shopify")).toEqual([]);
    expect((await usages(files(pom("", "GraphQL client")))).filter((u) => u.provider === "shopify")).toEqual([]);
  });
});
