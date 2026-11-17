import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";
import type { ApiMap } from "../src/types.js";

let map: ApiMap;
beforeAll(async () => {
  map = await scanRepo(resolve(import.meta.dirname, "fixtures/polyglot"));
});
const of = (dir: string) => map.usages.filter((u) => u.file.startsWith(dir)).map((u) => `${u.kind}:${u.line}:${u.model ?? u.op ?? u.apiVersion}`).sort();

describe("basic Go, Ruby, PHP and C# support", () => {
  it("reads go.mod, Gemfile, composer.json and .csproj", () => {
    const deps = map.sdks.map((s) => `${s.lang}:${s.name}@${s.version ?? ""}`).sort();
    expect(deps).toEqual([
      "cs:OpenAI@2.1.0", "cs:Stripe.net@45.0.0",
      "go:github.com/anthropics/anthropic-sdk-go@v1.2.0", "go:github.com/stripe/stripe-go@v76.10.0",
      "php:openai-php/client@^0.10", "php:stripe/stripe-php@^13.0",
      "rb:ruby-openai@~> 7.0", "rb:stripe@",
    ]);
  });

  it("Go: model settings, HTTP calls and version headers; not comments or labels", () => {
    expect(of("go/")).toEqual([
      "http:7:POST /v1/messages",
      "model-ref:4:claude-3-opus-20240229",
      "model-ref:9:claude-sonnet-4-20250514",
      "version-pin:8:anthropic-version: 2023-06-01",
    ]);
  });

  it("Ruby: hash settings and model lists; not sentences", () => {
    expect(of("rb/")).toEqual(["model-ref:2:gpt-4-0613", "model-ref:3:gpt-3.5-turbo", "model-ref:3:gpt-4o", "model-ref:6:claude-3-haiku-20240307", "model-ref:7:claude-sonnet-5-5"]);
  });

  it("PHP: array settings and Graph API versions in URLs", () => {
    expect(of("php/")).toEqual(["http:6:POST /v20.0/me/feed", "model-ref:3:gpt-3.5-turbo-0125"]);
  });

  it("C#: named arguments and GetChatClient; not plain strings", () => {
    expect(of("cs/")).toEqual(["model-ref:2:gpt-4-turbo", "model-ref:3:gpt-4o-mini"]);
  });
});
