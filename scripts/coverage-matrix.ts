// Print the API coverage matrix from test/coverage/cells.ts, measured against the scanner as it is now.
// npm run coverage-matrix [-- --json]
import { probe } from "../test/coverage/probe.js";
import { CELLS } from "../test/coverage/cells.js";

const LANGS = ["js", "py", "rb", "php", "go", "java", "cs"];
const rows = new Map<string, Map<string, string>>();
const json: unknown[] = [];
for (const cell of CELLS) {
  const got = await probe(cell);
  const v = Object.values(got);
  const status = v.every(Boolean) ? "covered" : v.some(Boolean) ? "partial" : "empty";
  json.push({ provider: cell.p, lang: cell.lang, style: cell.style, status, was: cell.now });
  const key = `${cell.p} | ${cell.style}`;
  if (!rows.has(key)) rows.set(key, new Map());
  rows.get(key)!.set(cell.lang, status === "covered" ? "✅" : status === "partial" ? "🟡" : "⬜");
}
if (process.argv.includes("--json")) console.log(JSON.stringify(json));
else {
  console.log(`| provider | style | ${LANGS.join(" | ")} |`);
  console.log(`|---|---|${LANGS.map(() => "---").join("|")}|`);
  for (const [k, m] of rows) console.log(`| ${k} | ${LANGS.map((l) => m.get(l) ?? "—").join(" | ")} |`);
  const n = json.length;
  const c = json.filter((x: any) => x.status === "covered").length;
  console.log(`\n${c}/${n} cells covered`);
}
