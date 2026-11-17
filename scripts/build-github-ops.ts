/**
 * Build src/data/github-ops.json: Octokit method → REST operation, generated from GitHub's published OpenAPI spec.
 * Octokit's method names come from the spec's operationIds: "issues/list-for-repo" → octokit.rest.issues.listForRepo.
 *
 *   npx tsx scripts/build-github-ops.ts
 */
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SPEC = "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json";
const camel = (s: string) => s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

const res = await fetch(SPEC, { headers: { "user-agent": "vitasta-scanner-build/0.0.1" } });
if (!res.ok) throw new Error(`spec → ${res.status}`);
const spec = (await res.json()) as { paths: Record<string, Record<string, { operationId?: string }>> };
const ops: Record<string, string> = {};
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (!op?.operationId || !["get", "post", "put", "patch", "delete"].includes(method)) continue;
    const [ns, name] = op.operationId.split("/");
    if (!ns || !name) continue;
    ops[`${camel(ns)}.${camel(name)}`] = `${method.toUpperCase()} ${path}`;
  }
}
const out = join(dirname(fileURLToPath(import.meta.url)), "../src/data/github-ops.json");
await writeFile(out, JSON.stringify(Object.fromEntries(Object.entries(ops).sort()), null, 0) + "\n");
console.log(`${Object.keys(ops).length} Octokit methods`);
