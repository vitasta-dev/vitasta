import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const FILES: Record<string, string> = {
  "rbv/app/pages.rb": "require \"net/http\"\n\nclass Pages\n  def list(token)\n    Net::HTTP.get(URI(\"#{Fb::Config::GRAPH_URL}/me/accounts?access_token=#{token}\"))\n  end\n\n  def me(token)\n    Net::HTTP.get(URI(\"https://graph.facebook.com/#{Fb::Config::API_VERSION}/me?access_token=#{token}\"))\n  end\nend\n",
  "rbv/lib/fb/config.rb": "module Fb\n  module Config\n    API_VERSION = \"v19.0\"\n    GRAPH_URL = \"https://graph.facebook.com/#{API_VERSION}\"\n  end\nend\n"
};

describe("Ruby: module constants named through their modules in another file", () => {
  it("Fb::Config::API_VERSION in a URL, and Fb::Config::GRAPH_URL (a URL built from it) as one more line", async () => {
    const d = await mkdtemp(join(tmpdir(), "vitasta-rbvals-"));
    for (const [p, t] of Object.entries(FILES)) {
      await mkdir(dirname(join(d, p)), { recursive: true });
      await writeFile(join(d, p), t);
    }
    const us = (await scanRepo(d)).usages.filter((u: any) => u.file === "rbv/app/pages.rb" && u.apiVersion);
    expect(us.map((u: any) => `${u.line}:${u.apiVersion}:${(u.alsoLines ?? []).join(",")}`)).toEqual(["9:url: v19.0:5"]);
  });
});
