import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChangeRecord } from "../src/types.js";

let client: Client;
const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0].text);

beforeAll(async () => {
  const feed = await mkdtemp(join(tmpdir(), "vitasta-feed-"));
  const soon = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
  const records: ChangeRecord[] = [
    {
      id: "openai-gpt-4o-test", provider: "openai", type: "model_retirement", title: "gpt-4o retires",
      effective: soon, selector: { models: ["gpt-4o"] }, replacement: "gpt-5", sources: [{ url: "https://example.com" }],
    } as ChangeRecord,
  ];
  await writeFile(join(feed, "openai.json"), JSON.stringify(records));
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({ command: "npx", args: ["tsx", resolve(import.meta.dirname, "../src/mcp.ts"), "--feed", feed] }),
  );
}, 60_000);

afterAll(async () => client?.close());

describe("MCP server", () => {
  it("lists read-only tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["api_usage", "check_repo", "model_status", "upcoming_changes"]);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
  });

  it("checks a repo and names file, line, date and replacement", async () => {
    const out = text(await client.callTool({ name: "check_repo", arguments: { path: resolve(import.meta.dirname, "fixtures/sample") } }));
    // Repo text (file names, models) comes as JSON strings: no line breaks or hidden characters from the repo
    expect(out).toMatch(/\[urgent\] "src\/chat\.ts":\d+: "gpt-4o"/);
    expect(out).toContain("Move to: gpt-5");
  });

  it("answers model_status and upcoming_changes from the feed", async () => {
    expect(text(await client.callTool({ name: "model_status", arguments: { model: "gpt-4o" } }))).toContain("Replacement: gpt-5");
    expect(text(await client.callTool({ name: "model_status", arguments: { model: "gpt-9" } }))).toContain("No retirement");
    expect(text(await client.callTool({ name: "upcoming_changes", arguments: { provider: "openai", within_days: 30 } }))).toContain("gpt-4o retires");
  });

  it("refuses a path that isn't a directory", async () => {
    const r = await client.callTool({ name: "check_repo", arguments: { path: "/nonexistent/xyz" } });
    expect(r.isError).toBe(true);
  });

  it("scans only inside its allowed folders: not elsewhere, not / or the home folder (review F4)", async () => {
    const outside = await mkdtemp(join(tmpdir(), "vitasta-outside-"));
    for (const path of [outside, "/", homedir()]) {
      const r = await client.callTool({ name: "check_repo", arguments: { path } });
      expect(r.isError, path).toBe(true);
      expect(text(r)).toMatch(/outside the folders|won't scan/);
    }
  });
});
