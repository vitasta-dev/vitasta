#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { annotationFor, evaluatePr, gitChangedLines, gitPrefix, workflowCommand } from "./check.js";
import { renderCheckSummary } from "./report/check.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defaultFeedDir } from "./feed/match.js";
import { feedSource, impactsFrom, lookupNotice, LookupError } from "./feed/lookup.js";
import { renderMarkdown } from "./report/markdown.js";
import { scanRepo } from "./scan/index.js";

const USAGE = `vitasta scan <path | https://github.com/owner/repo> [options]
vitasta check <path> --base <git ref> [--feed <dir>] [--github]

check: scan, then judge only the lines changed since <base> (like a PR check).
       Exits 1 if the change adds a call to something retired or due within 30 days.
       --github prints GitHub Actions annotations and writes the job summary.

Options:
  --feed <dir>     use a local change feed (default: $VITASTA_FEED). Without one, dates are looked up
                   on app.vitasta.dev: only model names, API operations and versions are sent,
                   never code, file names or the repo name
  --json <file>    write the API map and findings as JSON
  --md <file>      write the impact report as Markdown (default: print to stdout)
  --today <date>   pretend today is YYYY-MM-DD (for testing)
  --map-only       print the API map, skip the feed`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [cmd, target] = process.argv.slice(2);
  if (cmd === "check" && target) return check(target);
  if (cmd !== "scan" || !target) {
    console.error(USAGE);
    process.exit(2);
  }

  let root = target;
  let label = target;
  if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(target)) {
    const slug = target.replace("https://github.com/", "").replace(/\/$/, "");
    // Clones live outside the project so nothing (tests, tooling) ever picks up their code. We only read them.
    const cacheDir = process.env.VITASTA_CACHE ?? join(homedir(), ".cache", "vitasta", "repos");
    root = join(cacheDir, slug.replace("/", "__"));
    label = slug;
    if (!existsSync(root)) {
      await mkdir(cacheDir, { recursive: true });
      // Read-only clone: no hooks, no LFS filters, no submodules, symlinks checked out as plain files
      execFileSync(
        "git",
        ["-c", "core.hooksPath=/dev/null", "-c", "core.symlinks=false", "-c", "protocol.file.allow=never", "-c", "filter.lfs.smudge=", "-c", "filter.lfs.process=",
          "clone", "--depth", "1", "--quiet", "--no-recurse-submodules", target, root],
        { stdio: "inherit", env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1", GIT_TERMINAL_PROMPT: "0" } },
      );
    }
  }

  const map = await scanRepo(resolve(root), { onWarn: (m) => console.error(`warn: ${m}`) });
  if (process.argv.includes("--map-only")) {
    console.log(JSON.stringify(map, null, 2));
    return;
  }

  const src = sourceFromArgs();
  // Local calendar date, not UTC, so "days left" matches the user's own clock
  const today = arg("--today") ?? new Date().toLocaleDateString("en-CA");
  const findings = await impactsFrom(src, map, today);

  const json = arg("--json");
  if (json) await writeFile(json, JSON.stringify({ map, findings }, null, 2));
  const md = renderMarkdown(map, findings, label);
  const mdOut = arg("--md");
  if (mdOut) await writeFile(mdOut, md);
  else console.log(md);
}

async function check(target: string): Promise<void> {
  const base = arg("--base");
  if (!base) {
    console.error("check needs --base <git ref>, e.g. --base origin/main");
    process.exit(2);
  }
  const root = resolve(target);
  const map = await scanRepo(root, { onWarn: (m) => console.error(`warn: ${m}`) });
  const src = sourceFromArgs();
  const today = arg("--today") ?? new Date().toLocaleDateString("en-CA");
  const findings = await impactsFrom(src, map, today);
  const result = evaluatePr(findings, gitChangedLines(root, base), map.config?.policy.failOn, map.config?.policy.minConfidence);

  const summary = renderCheckSummary(result, map);
  if (process.argv.includes("--github")) {
    // Annotations need paths from the top of the repo
    const prefix = gitPrefix(root);
    for (const f of result.introduced) {
      const a = annotationFor(f, true, map.config?.policy.failOn, map.config?.policy.minConfidence);
      console.log(workflowCommand({ ...a, path: prefix + a.path }));
    }
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
  }
  console.log(summary);
  if (result.conclusion === "failure") process.exit(1);
}

function sourceFromArgs() {
  const src = feedSource(arg("--feed") ?? defaultFeedDir());
  const notice = lookupNotice(src);
  if (notice) console.error(notice);
  return src;
}

// Exit codes: 0 ok, 1 the check failed (a PR adds a retired call), 2 usage or lookup problem, 3 internal error.
// A crash must never look like "this PR adds a retired call".
main().catch((e) => {
  if (e instanceof LookupError) {
    console.error(`vitasta: ${e.message}`);
    // In CI the dates being unreachable shouldn't block a pull request: warn and pass
    if (process.argv[2] === "check" && process.argv.includes("--github")) {
      console.log(`::warning title=Vitasta::Couldn't look up retirement dates (${e.message.replace(/[\r\n%]/g, " ")}). Not blocking this pull request.`);
      process.exit(0);
    }
    process.exit(2);
  }
  console.error(e);
  process.exit(3);
});
