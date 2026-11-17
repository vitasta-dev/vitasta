import { cell, code, text } from "./escape.js";
import type { CheckResult } from "../check.js";
import type { ApiMap, Finding } from "../types.js";
import { groupFindings } from "./markdown.js";

const ICON: Record<Finding["status"], string> = { broken: "🔴", urgent: "🟠", upcoming: "🟡", "on-upgrade": "🔵" };

function row(f: Finding, lines: number[]): string {
  const u = f.usage;
  const when =
    f.status === "on-upgrade" ? `on upgrade to ${f.change.effective}` : f.daysLeft <= 0 ? (f.change.earliest ? "any day" : `since ${f.change.effective}`) : `in ${f.daysLeft} days`;
  const where = cell(code(`${u.file}:${lines.slice(0, 5).join(",")}${lines.length > 5 ? ",…" : ""}`));
  return `| ${ICON[f.status]} | ${u.model ? cell(code(u.model)) : u.op ? cell(code(u.op)) : ""} | ${where} | ${when} | ${f.change.replacement ? text(f.change.replacement) : ""} |`;
}

/** Markdown for a check run / job summary: what this PR introduces first, then known issues. */
export function renderCheckSummary(result: CheckResult, map: ApiMap): string {
  const out: string[] = [`### Vitasta: ${result.title}`, ""];
  const table = (fs: Finding[]) => {
    const groups = groupFindings(fs);
    out.push("| | Model / API | Where | When | Move to |", "|---|---|---|---|---|");
    for (const g of groups.slice(0, 30)) out.push(row(g.first, g.lines));
    if (groups.length > 30) out.push(`| | | …and ${groups.length - 30} more | | |`);
    out.push("");
  };
  if (result.introduced.length) {
    out.push("**In this pull request**", "");
    table(result.introduced);
  }
  if (result.existing.length) {
    out.push(`<details><summary>Known issues elsewhere in the repo (${groupFindings(result.existing).length})</summary>`, "");
    table(result.existing);
    out.push("</details>", "");
  }
  const files = new Set(map.usages.map((u) => u.file)).size;
  out.push(`<sub>Scanned ${map.filesScanned} source files; ${map.usages.length} API usages in ${files} files. Only lines changed in this pull request can fail the check.</sub>`);
  return out.join("\n");
}
