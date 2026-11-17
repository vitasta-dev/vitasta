#!/usr/bin/env node
/**
 * Vitasta MCP server: lets coding agents (Claude Code, Cursor, Codex, …) ask
 * "what in this repo calls an API or model that's retiring?" and "when does model X retire, and what replaces it?"
 *
 * Runs locally over stdio and reads the repo on disk. Dates come from a local feed (--feed) or, without one, from
 * the Vitasta lookup service, which receives only model names, API operations and versions: never code, file
 * names or the repo name. All tools are read-only.
 *
 *   claude mcp add vitasta -- npx tsx /path/to/scanner/src/mcp.ts [--feed /path/to/feed/data]
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { defaultFeedDir, daysBetween } from "./feed/match.js";
import { feedSource, impactsFrom } from "./feed/lookup.js";
import { normalizeModel } from "./providers.js";
import { groupFindings } from "./report/markdown.js";
import { scanRepo } from "./scan/index.js";

const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const SOURCE = feedSource(arg("--feed") ?? defaultFeedDir());
const today = () => new Date().toLocaleDateString("en-CA");

function repoPath(path: string): string {
  const p = resolve(path);
  if (!existsSync(p) || !statSync(p).isDirectory()) throw new Error(`not a directory: ${path}`);
  return p;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

const server = new McpServer({ name: "vitasta", version: "0.0.1" });

server.registerTool(
  "check_repo",
  {
    title: "Check a repo for retiring APIs and models",
    description:
      "Scan a local repository for calls to AI model and platform APIs (OpenAI, Anthropic, Gemini, Bedrock, Vertex, Azure, Stripe, GitHub, Shopify, Meta, Twilio and more) and report every place that uses a model, endpoint, parameter or API version that is retired or retiring, with the date and the recommended replacement. Read-only.",
    inputSchema: {
      path: z.string().describe("Path to the repository root"),
      within_days: z.number().int().min(0).max(3650).optional().describe("Only report changes effective within this many days (retired ones always included)"),
      include_tests: z.boolean().optional().describe("Include test, example and fixture files (default false)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: SOURCE.remote },
  },
  async ({ path, within_days, include_tests }) => {
    const map = await scanRepo(repoPath(path));
    let findings = await impactsFrom(SOURCE, map, today());
    if (!include_tests) findings = findings.filter((f) => !f.usage.inTest);
    if (within_days !== undefined) findings = findings.filter((f) => f.daysLeft <= within_days);
    const groups = groupFindings(findings);
    if (!groups.length) return text(`No retired or retiring APIs found in ${map.filesScanned} files (${map.usages.length} API usages checked).`);
    const lines = groups.map((g) => {
      const f = g.first;
      const u = f.usage;
      const when = f.status === "on-upgrade" ? `on upgrade to API version ${f.change.effective}` : f.daysLeft <= 0 ? `since ${f.change.effective}` : `${f.change.earliest ? "not before" : "on"} ${f.change.effective} (${f.daysLeft} days)`;
      return `- [${f.status}] ${u.file}:${g.lines.join(",")}: ${u.model ?? u.op ?? u.apiVersion ?? ""}${u.host ? ` on ${u.host}` : ""}${u.proxy ? ` via ${u.proxy}` : ""}. ${f.change.title}, ${when}.${f.change.replacement ? ` Move to: ${f.change.replacement}.` : ""}${f.change.guide ? ` Guide: ${f.change.guide}` : ""}`;
    });
    return text(`${groups.length} issue(s) in ${map.filesScanned} files:\n${lines.join("\n")}`);
  },
);

server.registerTool(
  "api_usage",
  {
    title: "List the APIs a repo uses",
    description: "List every third-party API call, model ID and pinned API version found in a local repository, grouped by provider. Read-only.",
    inputSchema: { path: z.string().describe("Path to the repository root"), provider: z.string().optional().describe("Only this provider, e.g. openai") },
    annotations: { readOnlyHint: true, openWorldHint: SOURCE.remote },
  },
  async ({ path, provider }) => {
    const map = await scanRepo(repoPath(path));
    const usages = map.usages.filter((u) => !provider || u.provider === provider);
    const byProvider = new Map<string, string[]>();
    for (const u of usages.slice(0, 500)) {
      const line = `${u.file}:${u.line} ${u.kind}${u.op ? ` ${u.op}` : ""}${u.model ? ` model=${u.model}` : ""}${u.apiVersion ? ` ${u.apiVersion}` : ""}${u.host ? ` host=${u.host}` : ""}`;
      byProvider.set(u.provider, [...(byProvider.get(u.provider) ?? []), line]);
    }
    const sdks = map.sdks.map((s) => `${s.provider}: ${s.name} ${s.version ?? ""} (${s.manifest})`);
    return text([`SDKs: ${sdks.join("; ") || "none"}`, ...[...byProvider].map(([p, ls]) => `\n## ${p} (${ls.length})\n${ls.join("\n")}`)].join("\n"));
  },
);

server.registerTool(
  "model_status",
  {
    title: "When does a model retire?",
    description: "Look up a model ID (e.g. claude-sonnet-4-5, gpt-4o, gemini-2.0-flash, us.anthropic.claude-3-7-sonnet-20250219-v1:0) and return its retirement dates on each platform (provider API, Bedrock, Vertex, Azure) and the recommended replacement.",
    inputSchema: { model: z.string().min(2).max(200) },
    annotations: { readOnlyHint: true, openWorldHint: SOURCE.remote },
  },
  async ({ model }) => {
    const hits = await SOURCE.forModel(normalizeModel(model));
    if (!hits.length) return text(`No retirement is announced for ${model} in the Vitasta feed.`);
    return text(
      hits
        .sort((a, b) => a.effective.localeCompare(b.effective))
        .map((c) => {
          const d = daysBetween(today(), c.effective);
          const where = c.selector.hosts?.join("/") ?? `${c.provider} API`;
          return `- ${where}: ${c.title}; ${c.earliest ? "not before" : ""} ${c.effective} (${d <= 0 ? `${-d} days ago` : `in ${d} days`}).${c.replacement ? ` Replacement: ${c.replacement}.` : ""} Source: ${c.sources[0]?.url ?? ""}${c.pending ? " (newly announced; not yet double-checked)" : ""}`;
        })
        .join("\n"),
    );
  },
);

server.registerTool(
  "upcoming_changes",
  {
    title: "Upcoming API and model retirements",
    description: "List announced retirements, shutdowns and API version sunsets coming up, optionally for one provider.",
    inputSchema: {
      provider: z.string().optional().describe("e.g. anthropic, openai, google, stripe, shopify, meta, github"),
      within_days: z.number().int().min(1).max(3650).optional().describe("Default 90"),
    },
    annotations: { readOnlyHint: true, openWorldHint: SOURCE.remote },
  },
  async ({ provider, within_days }) => {
    const horizon = within_days ?? 90;
    const list = (await SOURCE.upcoming(provider, horizon, today())).map((c) => ({ c, d: daysBetween(today(), c.effective) }));
    if (!list.length) return text(`Nothing announced in the next ${horizon} days${provider ? ` for ${provider}` : ""}.`);
    return text(list.map(({ c, d }) => `- ${c.effective} (${d} days) ${c.provider}${c.selector.hosts ? `/${c.selector.hosts.join("/")}` : ""}: ${c.title}${c.replacement ? ` → ${c.replacement}` : ""}${c.pending ? " (not yet double-checked)" : ""}`).join("\n"));
  },
);

await server.connect(new StdioServerTransport());
