import { code, fence, text, url } from "./escape.js";
import type { ApiMap, Finding } from "../types.js";

const STATUS: Record<Finding["status"], string> = {
  broken: "🔴 Broken now",
  urgent: "🟠 Due within 30 days",
  upcoming: "🟡 Upcoming",
  "on-upgrade": "🔵 Breaks when you upgrade",
};

function when(f: Finding): string {
  if (f.status === "on-upgrade") return `when you move to the new API version (${f.change.effective})`;
  if (f.change.earliest) {
    return f.daysLeft <= 0
      ? `any day now: the earliest shutdown date (${f.change.effective}) has passed`
      : `not before ${f.change.effective} (${f.daysLeft} days left at the earliest)`;
  }
  if (f.daysLeft <= 0) return `since ${f.change.effective} (${-f.daysLeft} days ago)`;
  return `on ${f.change.effective} (${f.daysLeft} days left)`;
}

interface Group {
  first: Finding;
  lines: number[];
  confidence: Finding["usage"]["confidence"];
}

const RANK = { certain: 0, likely: 1, possible: 2 } as const;

/** One entry per (change, model or operation, file): recorded data can repeat the same model hundreds of times. */
export function groupFindings(findings: Finding[]): Group[] {
  const byKey = new Map<string, Group>();
  for (const f of findings) {
    const u = f.usage;
    const key = `${f.change.id}|${u.model ?? u.op ?? ""}|${u.file}|${u.listed ? "listed" : ""}`;
    const g = byKey.get(key);
    if (!g) {
      byKey.set(key, { first: f, lines: [u.line], confidence: u.confidence });
    } else {
      if (!g.lines.includes(u.line)) g.lines.push(u.line);
      if (RANK[u.confidence] < RANK[g.confidence]) g.confidence = u.confidence;
    }
  }
  for (const g of byKey.values()) g.lines.sort((a, b) => a - b);
  return [...byKey.values()];
}

/** `after` adds a line under each finding (the App uses it for a "not an issue" checkbox). */
export function renderMarkdown(map: ApiMap, findings: Finding[], repoLabel: string, opts?: { after?: (f: Finding) => string | undefined }): string {
  const lines: string[] = [];
  lines.push(`# Vitasta impact report: ${repoLabel}`, "");
  lines.push(`Scanned ${map.filesScanned} source files on ${new Date(map.scannedAt).toLocaleDateString("en-CA")}.`, "");

  const groups = groupFindings(findings);
  const count = (s: Finding["status"]) => groups.filter((g) => g.first.status === s);
  lines.push("| Status | Issues | Places in code |", "|---|---|---|");
  for (const s of Object.keys(STATUS) as Finding["status"][]) {
    const gs = count(s);
    lines.push(`| ${STATUS[s]} | ${gs.length} | ${gs.reduce((n, g) => n + g.lines.length, 0)} |`);
  }
  lines.push("");

  if (groups.length) {
    lines.push("## What breaks", "");
    for (const g of groups) {
      const f = g.first;
      const u = f.usage;
      const where = u.host ? ` on ${{ bedrock: "Amazon Bedrock", vertex: "Vertex AI", azure: "Azure" }[u.host]}` : "";
      const title =
        f.change.type === "model_retirement" && u.model
          ? `${code(u.model)}${where} ${f.change.earliest ? "can be retired" : f.daysLeft <= 0 ? "is retired" : "is being retired"}`
          : text(f.change.title);
      lines.push(`### ${STATUS[f.status]}: ${title}`);
      const shown = g.lines.slice(0, 8).join(", ");
      const more = g.lines.length > 8 ? ` and ${g.lines.length - 8} more` : "";
      const times = g.lines.length > 1 ? ` (${g.lines.length} places)` : "";
      lines.push(`- **Where:** ${code(u.file)} line${g.lines.length > 1 ? "s" : ""} ${shown}${more}${times}${u.op ? ` → ${code(u.op)}` : ""}`);
      lines.push(`- **When:** ${when(f)}`);
      if (u.proxy) lines.push(`- **Note:** this client talks to ${code(u.proxy)}, not ${u.provider} directly. The date applies if that server forwards to ${u.provider}.`);
      if (f.change.pending) lines.push("- **Source:** newly announced and not yet double-checked by a person at Vitasta. Check the guide before acting.");
      if (f.change.unconfirmed) lines.push("- **Source:** found by comparing the provider's published API spec over time; not yet announced in a changelog. Worth checking before acting.");
      if (f.change.replacement) lines.push(`- **Move to:** ${text(f.change.replacement)}`);
      if (f.change.guide) lines.push(`- **Guide:** ${url(f.change.guide)}`);
      lines.push(`- **Confidence:** ${g.confidence}${u.inTest ? " (test, example or fixture file)" : ""}`);
      if (u.listed) lines.push("- **Note:** offered in a model list, picker or type, not called here. It breaks for whoever picks it.");
      lines.push("", fence(u.snippet), "");
      const extra = opts?.after?.(f);
      if (extra) lines.push(extra, "");
    }
  } else {
    lines.push("No known upcoming breaking changes affect this repo.", "");
  }

  if (findings.some((f) => f.usage.host === "azure")) {
    lines.push(
      "> **Azure note:** on Azure the `model` value is your deployment's name. Azure findings assume the deployment is named after the model it runs; check the model behind each deployment in the Azure portal.",
      "",
    );
  }
  const geminiUnknown = map.usages.filter((u) => u.provider === "google" && u.model && !u.host);
  if (geminiUnknown.length && map.usages.some((u) => u.provider === "google" && u.host === "vertex")) {
    lines.push(
      `> **Check:** this repo uses both Vertex AI and the Gemini API. ${geminiUnknown.length} Gemini model references were checked against the Gemini API schedule; if they run on Vertex, Vertex's dates apply instead.`,
      "",
    );
  }

  lines.push("## API map", "");
  if (map.sdks.length) {
    lines.push("SDKs in manifests:", "");
    for (const s of map.sdks) lines.push(`- ${s.provider}: ${code(s.name)}${s.version ? ` ${code(s.version)}` : ""} (${code(s.manifest)})`);
    lines.push("");
  }
  const counts = new Map<string, number>();
  for (const u of map.usages) counts.set(`${u.provider} ${u.kind}`, (counts.get(`${u.provider} ${u.kind}`) ?? 0) + 1);
  lines.push("| Provider / kind | Count |", "|---|---|");
  for (const [k, v] of [...counts].sort()) lines.push(`| ${k} | ${v} |`);
  lines.push("");
  return lines.join("\n");
}
