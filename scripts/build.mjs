// Build the publishable package: compile to dist/ and copy runtime data (provider rules, not the change feed).
import { cpSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
rmSync(join(root, "dist"), { recursive: true, force: true });
execFileSync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: root, stdio: "inherit" });
for (const d of ["data", "providers"]) cpSync(join(root, "src", d), join(root, "dist", d), { recursive: true });

// No feed is bundled: dates come from the lookup service (or --feed). See src/feed/lookup.ts.
