import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";
import { findImpacts, loadFeed } from "../src/feed/match.js";
import { haveTestFeed, TEST_FEED } from "./feed-data.js";

// these read feed records: the frozen test feed, absent from the public export (see test/feed-data.ts)
const itFeed = it.skipIf(!haveTestFeed);

// 24 Nov: Ruby client hops, a Ruby library's option-group body, version-constant uses, SDK endpoint classes
const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-csrb-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const usages = async (files: Record<string, string>) => (await scanRepo(await repo(files))).usages as any[];

describe("Ruby: a client through attr_reader, an instance variable and a builder method", () => {
  it("client.threads.create on a client built in build_client", async () => {
    const us = await usages({
      "Gemfile": "gem 'ruby-openai'\n",
      "app/services/assistant.rb": `class Assistant
  attr_reader :client

  def initialize
    @client = build_client
  end

  def create_thread
    client.threads.create
  end

  def list
    c = build_client # may raise
    c.assistants.list
  end

  private

  def build_client
    OpenAI::Client.new(access_token: ENV["KEY"])
  end
end
`,
    });
    const ops = us.filter((u) => u.provider === "openai" && u.file === "app/services/assistant.rb").map((u) => `${u.line} ${u.op}`);
    expect(ops.some((o) => o.startsWith("9 ") && /threads/.test(o))).toBe(true);
    expect(ops.some((o) => o.startsWith("14 ") && /assistants/.test(o))).toBe(true);
  });
});

describe("Ruby: a request body built from a declared option group", () => {
  const adapter = `module Lib
  module Anthropic
    class Adapter
      schema do
        chat_options do
          model         String
          temperature   Float, in: 0.0..1.0
          top_p         Float,
                        array: false
          reasoning do
            budget      Integer
          end
        end
      end
    end
  end
end
`;
  const methods = `module Lib
  module Anthropic
    module ChatRequestMethods
      CHAT_REQUEST_URI = "https://api.anthropic.com/v1/messages"
      def chat_request_body(conversation, options = nil)
        result = options[ :chat_options ]&.compact || {}
        result
      end
    end
  end
end
`;
  it("each declared key, and the body line; not another adapter's group in a sibling folder", async () => {
    const us = await usages({
      "lib/adapters/anthropic/adapter.rb": adapter, "lib/adapters/anthropic/chat_request_methods.rb": methods,
      "lib/adapters/mistral/adapter.rb": adapter.replace(/Anthropic/g, "Mistral"),
    });
    const a = us.filter((u) => u.provider === "anthropic" && u.op === "POST /v1/messages");
    expect(a.some((u) => u.file.endsWith("anthropic/adapter.rb") && u.line === 7 && u.params[0] === "temperature")).toBe(true);
    expect(a.some((u) => u.file.endsWith("anthropic/adapter.rb") && u.line === 8 && u.params[0] === "top_p")).toBe(true);
    const body = a.find((u) => u.file.endsWith("chat_request_methods.rb") && u.line === 6);
    expect(body?.params).toEqual(["model", "temperature", "top_p", "reasoning"]);
    expect(a.some((u) => u.file.includes("/mistral/"))).toBe(false);
    expect(a.some((u) => u.params.includes("budget") || u.params.includes("array"))).toBe(false);
  });
});

describe("Version-constant uses", () => {
  it("C.NAME, new C() where C returns it, and a subclass's base property", async () => {
    const us = await usages({
      "ShopifyLib/Infrastructure/DefaultShopifyApiVersion.cs": 'namespace ShopifyLib.Infrastructure;\npublic sealed record DefaultShopifyApiVersion\n{\n    public const string DefaultVersion = "2026-07";\n    public string Version => DefaultVersion;\n}\n',
      "ShopifyLib/Services/ShopifyService.cs": 'namespace ShopifyLib.Services;\npublic abstract class ShopifyService\n{\n    public virtual string APIVersion => _v ?? DefaultShopifyApiVersion.DefaultVersion;\n    string Url(string path) => $"https://{shop}.myshopify.com/admin/api/{APIVersion}/{path}";\n}\n',
      "ShopifyLib/Services/PartnerService.cs": "namespace ShopifyLib.Services;\npublic class PartnerService : ShopifyService\n{\n    public override string APIVersion => _p ?? base.APIVersion;\n}\n",
      "ShopifyLib/Factories/ShopifyFactory.cs": "namespace ShopifyLib.Factories;\npublic class ShopifyFactory\n{\n    object Make() => new Service(DefaultShopifyApiVersion.DefaultVersion);\n    object Other() => new DefaultShopifyApiVersion();\n}\n",
    });
    const at = us.filter((u) => u.kind === "version-pin" && /2026-07/.test(u.apiVersion ?? "")).map((u) => `${u.file.split("/").pop()}:${u.line}`);
    for (const x of ["DefaultShopifyApiVersion.cs:4", "ShopifyService.cs:4", "PartnerService.cs:4", "ShopifyFactory.cs:4", "ShopifyFactory.cs:5"]) expect(at).toContain(x);
  });
});

describe("SDK endpoint classes", () => {
  const files = {
    "OpenAI/OpenAISettings.cs": 'namespace OpenAI;\ninternal static class Settings\n{\n    internal const string Domain = "api.openai.com";\n    internal const string ApiVersion = "v1";\n}\n',
    "OpenAI/Common/BaseEndpoint.cs": 'using OpenAI;\nnamespace OpenAI.Common;\npublic abstract class BaseEndpoint\n{\n    protected abstract string Root { get; }\n    protected string GetUrl(string endpoint = "")\n    {\n        var route = $"{Root}{endpoint}";\n        return route;\n    }\n}\n',
    "OpenAI/Assistants/AssistantsEndpoint.cs": 'using OpenAI;\nnamespace OpenAI.Assistants;\npublic sealed class AssistantsEndpoint : BaseEndpoint\n{\n    protected override string Root => "assistants";\n    public async Task List() { using var r = await GetAsync(GetUrl()); }\n    public async Task Get(string id) { using var r = await GetAsync(GetUrl($"/{id}")); }\n}\n',
    "OpenAI/Audio/AudioEndpoint.cs": 'using OpenAI;\nnamespace OpenAI.Audio;\npublic sealed class AudioEndpoint : BaseEndpoint\n{\n    protected override string Root => "audio";\n    public async Task Translate() { using var r = await PostAsync(GetUrl("/translations"), null); }\n}\n',
  };
  it("the override names the endpoint, each verb call an operation", async () => {
    const us = await usages(files);
    const ops = us.filter((u) => u.provider === "openai").map((u) => `${u.file.split("/").pop()}:${u.line} ${u.op}`);
    expect(ops).toContain("AssistantsEndpoint.cs:5 * /v1/assistants");
    expect(ops).toContain("AssistantsEndpoint.cs:7 GET /v1/assistants/{id}");
    expect(ops).toContain("AudioEndpoint.cs:6 POST /v1/audio/translations");
  });
  itFeed("a class's calls fold into its path-property finding for the same change", async () => {
    const d = await repo(files);
    const feed = await loadFeed(TEST_FEED);
    const fs = findImpacts(await scanRepo(d), feed, "2026-11-23").filter((f: any) => f.usage.file.endsWith("AssistantsEndpoint.cs"));
    const ids = [...new Set(fs.map((f: any) => f.change.id))];
    for (const id of ids) {
      const mine = fs.filter((f: any) => f.change.id === id);
      expect(mine.length).toBe(1);
      expect(mine[0].usage.line).toBe(5);
    }
  });
});
