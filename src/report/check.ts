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
    const groups = groupFindings(fs.filter((f) => !f.usage.grouped));
    out.push("| | Model / API | Where | When | Move to |", "|---|---|---|---|---|");
    // a large catalog: one row per file, listing the retired ids
    const catalogs = new Map<string, Finding[]>();
    for (const f of fs) if (f.usage.grouped) catalogs.set(f.usage.file, [...(catalogs.get(f.usage.file) ?? []), f]);
    for (const [file, cs] of catalogs) {
      const ids = cs[0].usage.grouped!.ids;
      const ls = [...new Set(cs.map((f) => f.usage.line))].sort((a, b) => a - b);
      out.push(`| ${ICON[cs[0].status]} | ${cell(`${cs.length} catalog entries: ${ids.slice(0, 6).join(", ")}${ids.length > 6 ? ", …" : ""}`)} | ${cell(code(`${file}:${ls.slice(0, 5).join(",")}${ls.length > 5 ? ",…" : ""}`))} | | |`);
    }
    for (const g of groups.slice(0, 30)) out.push(row(g.first, g.lines));
    if (groups.length > 30) out.push(`| | | …and ${groups.length - 30} more | | |`);
    out.push("");
  };
  // two tiers: what needs action in this PR, then what else it touches (catalogs, dead or unused
  // code, a provider not shown at the request, docs), which never fails the check
  const tierOf = (f: Finding) => f.usage.tier ?? "action";
  const action = result.introduced.filter((f) => tierOf(f) === "action");
  const also = result.introduced.filter((f) => tierOf(f) === "also");
  if (action.length) {
    out.push("**Action needed in this pull request**", "");
    table(action);
  }
  if (also.length) {
    out.push(`<details><summary>Also in this pull request (${groupFindings(also).length}; never fails the check)</summary>`, "");
    table(also);
    out.push("</details>", "");
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
