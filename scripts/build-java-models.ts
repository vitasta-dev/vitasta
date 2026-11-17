/**
 * Build src/data/java-model-constants.json: Java SDK model constants (Model.CLAUDE_SONNET_4_5, ChatModel.GPT_4O)
 * → the model ID string, taken from the SDKs' own Kotlin source across many releases. Old code uses constants
 * that newer SDKs have removed, so we union every sampled release.
 *
 *   npx tsx scripts/build-java-models.ts      (needs `gh` logged in for the tags list)
 */
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCES = [
  { provider: "anthropic", cls: "Model", repo: "anthropics/anthropic-sdk-java", path: "anthropic-java-core/src/main/kotlin/com/anthropic/models/messages/Model.kt", oldPath: "anthropic-java-core/src/main/kotlin/com/anthropic/models/Model.kt" },
  { provider: "openai", cls: "ChatModel", repo: "openai/openai-java", path: "openai-java-core/src/main/kotlin/com/openai/models/ChatModel.kt" },
];

const CONST = /val\s+([A-Z][A-Z0-9_]*)\s*=\s*(?:\w+\(JsonField\.of|of)\(\s*"([^"]+)"\s*\)/g;

function tags(repo: string): string[] {
  const out = execFileSync("gh", ["api", "--paginate", `repos/${repo}/tags`, "--jq", ".[].name"], { encoding: "utf8" });
  return out.split("\n").filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
}

async function fetchText(url: string): Promise<string | undefined> {
  const res = await fetch(url, { headers: { "user-agent": "vitasta-scanner-build/0.0.1" } });
  return res.ok ? res.text() : undefined;
}

async function main(): Promise<void> {
  const result: Record<string, Record<string, Record<string, string>>> = {};
  for (const src of SOURCES) {
    const all = tags(src.repo);
    // Every release would be hundreds of requests; sample one per minor version plus main.
    const byMinor = new Map<string, string>();
    for (const t of all) byMinor.set(t.replace(/\.\d+$/, ""), t);
    const refs = ["main", ...byMinor.values()];
    const map: Record<string, string> = {};
    let files = 0;
    for (const ref of refs) {
      let text: string | undefined;
      for (const p of [src.path, src.oldPath].filter(Boolean) as string[]) {
        text = await fetchText(`https://raw.githubusercontent.com/${src.repo}/${ref}/${p}`);
        if (text) break;
      }
      if (!text) continue;
      files++;
      for (const m of text.matchAll(CONST)) map[m[1]] ??= m[2];
    }
    result[src.provider] = { ...(result[src.provider] ?? {}), [src.cls]: Object.fromEntries(Object.entries(map).sort()) };
    console.log(`${src.repo}: ${files}/${refs.length} versions read, ${Object.keys(map).length} constants`);
  }
  const out = join(dirname(fileURLToPath(import.meta.url)), "../src/data/java-model-constants.json");
  await writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), ...result }, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
