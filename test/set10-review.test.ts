import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";
import { findImpacts, loadFeed } from "../src/feed/match.js";

// Review: (24 Nov): generic fixes on hand-written code (never set 10's)
const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-s10r-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const usages = async (files: Record<string, string>) => (await scanRepo(await repo(files))).usages as any[];
const findings = async (files: Record<string, string>) => findImpacts(await scanRepo(await repo(files)), await loadFeed(`${process.env.HOME}/vitasta/feed/data`), "2026-11-23") as any[];

describe("1. a URL that interpolates its ids", () => {
  it("C# $\"https://api.openai.com/v1/threads/{threadId}/messages\" is the threads operation", async () => {
    const us = await usages({ "Assets/Client.cs": 'public class Client\n{\n    public void Add(string threadId)\n    {\n        string url = $"https://api.openai.com/v1/threads/{threadId}/messages";\n    }\n}\n' });
    expect(us.find((u) => u.provider === "openai" && u.line === 5)?.op).toMatch(/\/v1\/threads\/\{id\}\/messages$/);
  });
});

describe("4. Meta", () => {
  it("a Graph path built from an ad object's variable is a Marketing call", async () => {
    const us = await usages({ "a.py": 'import requests\nGRAPH = "https://graph.facebook.com/v24.0"\n\ndef add(audience_id, p, t):\n    return requests.post(f"{GRAPH}/{audience_id}/users", json=p)\n\ndef posts(page_id, t):\n    return requests.get(f"{GRAPH}/{page_id}/posts")\n' });
    expect(us.find((u) => u.line === 5 && u.kind === "http")?.provider).toBe("meta-marketing");
    expect(us.find((u) => u.line === 8 && u.kind === "http")?.provider).toBe("meta");
  });
  it("a JSP link that interpolates its client id", async () => {
    const us = await usages({ "web/login.jsp": '<%@ page contentType="text/html" %>\n<a href="https://www.facebook.com/v12.0/dialog/oauth?client_id=<%= appId %>">Login</a>\n' });
    expect(us.some((u) => u.provider === "meta" && u.line === 2 && /v12\.0/.test(u.apiVersion ?? ""))).toBe(true);
  });
});

describe("3. a relay's route group", () => {
  it("v1 := r.Group(\"/v1\"); v1.POST(\"/edits\", …) is /v1/edits on the upstream", async () => {
    const us = await usages({ "router/router.go": 'package router\n\nconst upstream = "https://api.openai.com"\n\nfunc Setup(r *gin.Engine, h gin.HandlerFunc) {\n\tv1 := r.Group("/v1")\n\tv1.POST("/edits", h)\n\tv1.POST("/engines/:model/embeddings", h)\n}\n' });
    const ops = us.filter((u) => u.provider === "openai").map((u) => `${u.line} ${u.op}`);
    expect(ops).toContain("7 POST /v1/edits");
    expect(ops).toContain("8 POST /v1/engines/{id}/embeddings");
  });
});

describe("5. a base URL constant used through a namespace import", () => {
  it("each file that builds its URL from lib.API_BASE_URL is a finding of its own", async () => {
    const fs = await findings({
      "src/lib.js": 'export const API_BASE_URL = "https://googleads.googleapis.com/v23";\n',
      "src/components/Campaigns.js": 'import * as lib from "../lib";\nexport async function load(id) {\n  return fetch(`${lib.API_BASE_URL}/customers/${id}/googleAds:search`, { method: "POST" });\n}\n',
    });
    expect(fs.filter((f) => f.change.id.startsWith("googleads-api-v23")).map((f) => `${f.usage.file}:${f.usage.line}`).sort()).toEqual(["src/components/Campaigns.js:3", "src/lib.js:1"]);
  });
});

describe("precision: a provider SDK copied into the repo", () => {
  it("gives one non-failing note, not a finding per line", async () => {
    const us = await usages({
      "package.json": '{"name":"app","dependencies":{"@anthropic-ai/sdk":"file:./packages/anthropic-sdk"}}',
      "packages/anthropic-sdk/package.json": '{"name":"@anthropic-ai/sdk","version":"0.60.0"}',
      "packages/anthropic-sdk/src/messages.ts": 'export async function create(b: any) {\n  return fetch("https://api.anthropic.com/v1/messages", {\n    method: "POST",\n    body: JSON.stringify({ model: b.model, temperature: b.temperature, top_p: b.top_p }),\n  });\n}\n',
    });
    const v = us.filter((u) => u.file.startsWith("packages/anthropic-sdk/"));
    expect(v.length).toBe(1);
    expect(v[0].role).toBe("recorded");
  });
});

describe("precision: same-named constants classes in different namespaces", () => {
  it("Google's Constants.AuthorizationEndpoint isn't Facebook's", async () => {
    const us = await usages({
      "src/Auth.Facebook/Constants.cs": 'namespace Auth.Facebook\n{\n    internal static class Constants\n    {\n        public const string AuthorizationEndpoint = "https://www.facebook.com/v10.0/dialog/oauth";\n    }\n}\n',
      "src/Auth.Facebook/FacebookOptions.cs": "namespace Auth.Facebook\n{\n    public class FacebookOptions\n    {\n        public string AuthorizationEndpoint { get; set; } = Constants.AuthorizationEndpoint;\n    }\n}\n",
      "src/Auth.Google/Constants.cs": 'namespace Auth.Google\n{\n    internal static class Constants\n    {\n        public const string AuthorizationEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";\n    }\n}\n',
      "src/Auth.Google/GoogleOptions.cs": "namespace Auth.Google\n{\n    public class GoogleOptions\n    {\n        public string AuthorizationEndpoint { get; set; } = Constants.AuthorizationEndpoint;\n    }\n}\n",
    });
    const meta = us.filter((u) => u.provider === "meta").map((u) => u.file);
    expect(meta).toContain("src/Auth.Facebook/FacebookOptions.cs");
    expect(meta).not.toContain("src/Auth.Google/GoogleOptions.cs");
  });
});

describe("facebook-messenger gem: each class's pinned Graph version, by the lockfile's release", () => {
  const app = 'require "facebook/messenger"\ninclude Facebook::Messenger\n\nFacebook::Messenger::Subscriptions.subscribe(access_token: ENV["T"])\nBot.deliver({ recipient: { id: 1 }, message: { text: "hi" } }, access_token: ENV["T"])\n';
  const lock = (v: string) => `GEM\n  remote: https://rubygems.org/\n  specs:\n    facebook-messenger (${v})\n\nDEPENDENCIES\n  facebook-messenger\n`;
  it("2.0.1 calls v3.2; 2.2.0 calls v20.0", async () => {
    for (const [v, want] of [["2.0.1", "v3.2"], ["2.2.0", "v20.0"]]) {
      const us = (await usages({ "Gemfile": 'gem "facebook-messenger"\n', "Gemfile.lock": lock(v), "app/bot.rb": app })).filter((u) => u.provider === "meta");
      expect(us.filter((u) => u.file === "app/bot.rb").map((u) => `${u.line}:${u.apiVersion}`).sort()).toEqual([`4:default: ${want}`, `5:default: ${want}`]);
    }
  });
});
