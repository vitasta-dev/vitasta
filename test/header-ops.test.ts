import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { findImpacts } from "../src/feed/match.js";
import { scanRepo } from "../src/scan/index.js";
import type { ChangeRecord } from "../src/types.js";

// an OpenAI-Beta: assistants header on a request whose URL traces to another API isn't an
// Assistants call; when the URL can't be traced, or traces to the Assistants API, it still is
const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-hdr-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const rec: ChangeRecord = { id: "asst", provider: "openai", type: "endpoint_removed", title: "Assistants API shuts down", selector: { ops: ["* /v1/assistants", "* /v1/threads"], headers: ["openai-beta: assistants=*"] }, effective: "2026-08-26", trigger: "date", sources: [] };
const helper = (endpoints: string) => `package a;
class OpenAIUtils {
  ${endpoints}
  static String base() { return "https://api.openai.com/v1"; }
  static String call(String key, String endpoint) {
    String url = base() + endpoint;
    return Unirest.get(url).header("Authorization", "Bearer " + key).header("OpenAI-Beta", "assistants=v2").asString();
  }
}
`;
const hits = async (files: Record<string, string>) => findImpacts(await scanRepo(await repo(files)), [rec], "2026-11-23").filter((f) => f.usage.kind === "version-pin");

describe("API-meaning headers and the request's traced operation", () => {
  it("the header on /models requests isn't an Assistants call", async () => {
    const r = await hits({ "src/OpenAIUtils.java": helper('static final String MODELS = "/models";'), "src/Use.java": "package a;\nclass Use { void go() { OpenAIUtils.call(k, OpenAIUtils.MODELS); } }\n" });
    expect(r).toEqual([]);
  });
  it("the header on /assistants requests is", async () => {
    const fs = findImpacts(await scanRepo(await repo({ "src/OpenAIUtils.java": helper('static final String ASSISTANTS = "/assistants";'), "src/Use.java": "package a;\nclass Use { void go() { OpenAIUtils.call(k, OpenAIUtils.ASSISTANTS); } }\n" })), [rec], "2026-11-23");
    // the header's line is reported for the change: its own finding, or a line of the
    // ASSISTANTS path finding a few lines above it
    const lines = fs.filter((f) => f.usage.file === "src/OpenAIUtils.java").flatMap((f) => [f.usage.line, ...(f.usage.alsoLines ?? [])]);
    expect(lines).toContain(7);
  });
});

describe("one finding per endpoint class", () => {
  it("a library's calls into its own endpoint class aren't extra findings", () => {
    const map: any = { root: ".", scannedAt: "2026-11-23T00:00:00Z", filesScanned: 2, sdks: [], usages: [
      { provider: "openai", kind: "version-pin", lang: "cs", file: "OpenAI/Assistants/AssistantsEndpoint.cs", line: 19, apiVersion: "openai-beta: assistants=v2", confidence: "certain" },
      { provider: "openai", kind: "sdk", lang: "cs", file: "OpenAI/Assistants/AssistantExtensions.cs", line: 22, op: "* /v1/assistants", sdkCall: "ModifyAssistantAsync", confidence: "likely", reason: "an openai SDK AssistantsEndpoint.ModifyAssistantAsync call" },
      { provider: "openai", kind: "sdk", lang: "cs", file: "App/Use.cs", line: 5, op: "* /v1/assistants", sdkCall: "CreateAssistantAsync", confidence: "likely", reason: "an openai SDK client.CreateAssistantAsync call" },
    ] };
    const r = findImpacts(map, [rec], "2026-11-23").map((f) => `${f.usage.file}:${f.usage.line}`);
    expect(r).toEqual(expect.arrayContaining(["OpenAI/Assistants/AssistantsEndpoint.cs:19", "App/Use.cs:5"]));
    expect(r).not.toContain("OpenAI/Assistants/AssistantExtensions.cs:22");
  });
});

