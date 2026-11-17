import { execFileSync } from "node:child_process";
import type { Finding } from "./types.js";

/** file → set of line numbers added or changed in the new version */
export type ChangedLines = Map<string, Set<number>>;

/** Undo git's C-style quoting of unusual paths: "b/caf\303\251.ts" → b/café.ts */
function unquote(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const bytes: number[] = [];
  const s = p.slice(1, -1);
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "\\") {
      bytes.push(...Buffer.from(s[i], "utf8"));
      continue;
    }
    const oct = /^[0-7]{3}/.exec(s.slice(i + 1));
    if (oct) {
      bytes.push(parseInt(oct[0], 8));
      i += 3;
    } else {
      bytes.push(simple[s[i + 1]] ?? s.charCodeAt(i + 1));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Parse `git diff --unified=0` output into the lines added on the new side. Hunk bodies are skipped by count, so an
 * added line that itself starts with "++ " is never mistaken for a file header.
 */
export function parseUnifiedDiff(diff: string): ChangedLines {
  const out: ChangedLines = new Map();
  let file: string | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of diff.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("-")) oldLeft--;
      else if (line.startsWith("+")) newLeft--;
      else if (line.startsWith(" ")) (oldLeft--, newLeft--);
      // "\ No newline at end of file" takes no count
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = unquote(line.slice(4).replace(/\t$/, ""));
      file = p === "/dev/null" ? undefined : p.replace(/^b\//, "");
      if (file && !out.has(file)) out.set(file, new Set());
      continue;
    }
    const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      oldLeft = m[1] === undefined ? 1 : Number(m[1]);
      const start = Number(m[2]);
      newLeft = m[3] === undefined ? 1 : Number(m[3]);
      if (file) for (let i = 0; i < newLeft; i++) out.get(file)!.add(start + i);
    }
  }
  return out;
}

/**
 * Lines changed between `base` and HEAD (merge-base diff, like a PR), with paths relative to `repo`: scanning a
 * subfolder of a monorepo gives paths relative to that folder, and so does this diff.
 */
export function gitChangedLines(repo: string, base: string): ChangedLines {
  if (base.startsWith("-") || /\s/.test(base)) throw new Error(`not a git ref: ${base}`);
  // Prefixes, colour and renames pinned so the user's own git config can't change what we parse
  const diff = execFileSync("git", ["-c", "core.quotePath=false", "-c", "diff.noprefix=false", "-C", repo, "diff", "--relative", "--unified=0", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", `${base}...HEAD`, "--"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseUnifiedDiff(diff);
}

/** The scanned folder's path inside its git repo ("" at the top, "packages/api/" in a monorepo). */
export function gitPrefix(repo: string): string {
  return execFileSync("git", ["-C", repo, "rev-parse", "--show-prefix"], { encoding: "utf8" }).trim();
}

export interface CheckResult {
  /** Findings on lines this PR adds or changes */
  introduced: Finding[];
  /** Findings that already existed before this PR */
  existing: Finding[];
  conclusion: "success" | "failure" | "neutral";
  title: string;
}

/**
 * A PR fails the check if it adds or changes a line that calls something already retired, due within
 * 30 days, or removed in an API version the code is moving to. Older problems are reported but don't block:
 * a PR shouldn't fail for code it didn't touch.
 */
const CONFIDENCE = { certain: 0, likely: 1, possible: 2 } as const;

/**
 * Whether a finding may fail a PR. Never for test files or a model that's only offered in a list or type (`listed`),
 * and never when the date itself isn't solid: a feed record
 * no person has checked yet (`pending`) or one inferred only from spec diffs (`unconfirmed`).
 */
export function canBlock(f: Finding, failOn: Finding["status"][] = ["broken", "urgent"], minConfidence: Finding["usage"]["confidence"] = "possible"): boolean {
  return !f.usage.inTest && !f.usage.listed && !f.change.pending && !f.change.unconfirmed && failOn.includes(f.status) && CONFIDENCE[f.usage.confidence] <= CONFIDENCE[minConfidence];
}

export function evaluatePr(findings: Finding[], changed: ChangedLines, failOn: Finding["status"][] = ["broken", "urgent"], minConfidence: Finding["usage"]["confidence"] = "possible"): CheckResult {
  const touches = (f: Finding) => {
    const lines = changed.get(f.usage.file);
    return !!lines && (lines.has(f.usage.line) || !!f.usage.alsoLines?.some((l) => lines.has(l)));
  };
  const introduced = findings.filter(touches);
  const existing = findings.filter((f) => !introduced.includes(f));
  const blocking = introduced.filter((f) => canBlock(f, failOn, minConfidence));
  const conclusion = blocking.length ? "failure" : introduced.length || existing.length ? "neutral" : "success";
  const title = blocking.length
    ? `This PR adds ${blocking.length} call${blocking.length > 1 ? "s" : ""} to retired or soon-retiring APIs`
    : introduced.length
      ? `This PR touches ${introduced.length} API usage${introduced.length > 1 ? "s" : ""} with announced changes`
      : existing.length
        ? `No new problems; ${existing.length} known issue${existing.length > 1 ? "s" : ""} elsewhere in the repo`
        : "No API retirements affect this repo";
  return { introduced, existing, conclusion, title };
}

export interface Annotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "failure" | "warning" | "notice";
  title: string;
  message: string;
}

export function annotationFor(f: Finding, introduced: boolean, failOn?: Finding["status"][], minConfidence?: Finding["usage"]["confidence"]): Annotation {
  const u = f.usage;
  const blocking = introduced && canBlock(f, failOn, minConfidence);
  const when =
    f.status === "on-upgrade"
      ? `breaks when you move to API version ${f.change.effective}`
      : f.daysLeft <= 0
        ? f.change.earliest ? `can be shut down any day (earliest date ${f.change.effective} has passed)` : `retired since ${f.change.effective}`
        : `${f.change.earliest ? "not before" : "on"} ${f.change.effective} (${f.daysLeft} days)`;
  return {
    path: u.file,
    start_line: u.line,
    end_line: u.line,
    annotation_level: blocking ? "failure" : f.status === "broken" || f.status === "urgent" ? "warning" : "notice",
    title: (f.change.type === "model_retirement" && u.model
      ? `${u.model}${u.host ? ` on ${{ bedrock: "Amazon Bedrock", vertex: "Vertex AI", azure: "Azure" }[u.host]}` : ""} ${f.change.earliest ? "can be retired" : f.daysLeft <= 0 ? "is retired" : "is being retired"}`
      : `${u.model ? `${u.model}: ` : ""}${f.change.title}`
    ).slice(0, 255),
    message: [
      `${when}.`,
      f.change.pending ? "Newly announced; not yet double-checked by Vitasta, so it won't fail this check." : "",
      f.change.unconfirmed ? "Inferred from the provider's API spec; not yet announced, so it won't fail this check." : "",
      f.change.replacement ? `Move to: ${f.change.replacement}.` : "", f.change.guide ? `Guide: ${f.change.guide}` : ""]
      .filter(Boolean)
      .join(" "),
  };
}

/** GitHub Actions workflow commands: ::error file=…,line=…,title=…::message */
export function workflowCommand(a: Annotation): string {
  const level = a.annotation_level === "failure" ? "error" : a.annotation_level === "warning" ? "warning" : "notice";
  const esc = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const prop = (s: string) => esc(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
  return `::${level} file=${prop(a.path)},line=${a.start_line},title=${prop(a.title)}::${esc(a.message)}`;
}
