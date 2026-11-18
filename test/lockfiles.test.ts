import { describe, expect, it } from "vitest";
import { installedFor, minFor, rangeAllows, versionOk } from "../src/scan/lockfiles.js";

const MINS = ["2.0.107", "3.0.125", "4.0.67"];
const repo = (files: Record<string, string>) => (p: string) => files[p];

describe("versions with a fix, by release line", () => {
  it("compares within the version's own line", () => {
    expect(versionOk("3.0.23", MINS)).toBe(false);
    expect(versionOk("3.0.125", MINS)).toBe(true);
    expect(versionOk("3.0.143", MINS)).toBe(true);
    expect(versionOk("2.0.115", MINS)).toBe(true);
    expect(versionOk("4.0.66", MINS)).toBe(false);
    expect(versionOk("1.2.12", MINS)).toBe(false);
    expect(versionOk("5.0.0", MINS)).toBe(true);
    expect(minFor("3.0.23", MINS)).toBe("3.0.125");
    expect(minFor("1.2.0", MINS)).toBe("2.0.107");
  });

  it("knows when a range can resolve to a good version", () => {
    expect(rangeAllows("^3.0.0", MINS)).toBe(true);
    expect(rangeAllows("~3.0.20", MINS)).toBe(true);
    expect(rangeAllows("3.0.23", MINS)).toBe(false);
    expect(rangeAllows(">=3.0.0 <3.0.100", MINS)).toBe(false);
    expect(rangeAllows("^1.2.0", MINS)).toBe(false);
    expect(rangeAllows("^1.2.0 || ^3.0.0", MINS)).toBe(true);
    expect(rangeAllows("3.0.x", MINS)).toBe(true);
    expect(rangeAllows("*", MINS)).toBe(true);
    expect(rangeAllows("workspace:*", MINS)).toBeUndefined();
    // PEP 440 and Poetry
    expect(rangeAllows(">=0.40,<0.50", ["0.45.0"])).toBe(true);
    expect(rangeAllows("==0.40.0", ["0.45.0"])).toBe(false);
    expect(rangeAllows("~=0.40.0", ["0.45.0"])).toBe(false);
    expect(rangeAllows("~=0.40", ["0.45.0"])).toBe(true);
  });
});

describe("reading what a place in the repo installs", () => {
  const pkg = (deps: Record<string, string>) => JSON.stringify({ dependencies: deps });

  it("bun.lock at the root, the range from the nearest package.json", () => {
    const read = repo({
      "package.json": pkg({ "@ai-sdk/anthropic": "^3.0.0" }),
      "bun.lock": '{\n  "lockfileVersion": 1,\n  "packages": {\n    "@ai-sdk/anthropic": ["@ai-sdk/anthropic@3.0.23", "", { "dependencies": {} }, "sha512-x"],\n  },\n}\n',
    });
    expect(installedFor(read, "src/run.ts", "npm", "@ai-sdk/anthropic")).toEqual({ range: "^3.0.0", manifest: "package.json", version: "3.0.23", lockfile: "bun.lock" });
  });

  it("package-lock v3 for a workspace member, with the member's own copy preferred", () => {
    const read = repo({
      "apps/web/package.json": pkg({ "@ai-sdk/anthropic": "^3.0.100" }),
      "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/@ai-sdk/anthropic": { version: "3.0.30" }, "apps/web/node_modules/@ai-sdk/anthropic": { version: "3.0.140" } } }),
    });
    expect(installedFor(read, "apps/web/src/a.ts", "npm", "@ai-sdk/anthropic")?.version).toBe("3.0.140");
  });

  it("pnpm importers and yarn blocks", () => {
    const pnpm = repo({
      "package.json": pkg({ "@ai-sdk/anthropic": "^3.0.0" }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '@ai-sdk/anthropic':\n        specifier: ^3.0.0\n        version: 3.0.40(zod@3.25.76)\n",
    });
    expect(installedFor(pnpm, "x.ts", "npm", "@ai-sdk/anthropic")?.version).toBe("3.0.40");
    const yarn = repo({
      "package.json": pkg({ "@ai-sdk/anthropic": "^3.0.0" }),
      "yarn.lock": '"@ai-sdk/anthropic@^3.0.0":\n  version "3.0.130"\n  resolved "https://x"\n\n"@ai-sdk/anthropic@^2.0.0":\n  version "2.0.50"\n',
    });
    expect(installedFor(yarn, "x.ts", "npm", "@ai-sdk/anthropic")?.version).toBe("3.0.130");
  });

  it("no lockfile: only the range; a binary lockfile is reported as unreadable; undeclared is undefined", () => {
    expect(installedFor(repo({ "package.json": pkg({ "@ai-sdk/anthropic": "^3.0.0" }) }), "a.ts", "npm", "@ai-sdk/anthropic")).toEqual({ range: "^3.0.0", manifest: "package.json" });
    expect(installedFor(repo({ "package.json": pkg({ "@ai-sdk/anthropic": "^3.0.0" }), "bun.lockb": "\u0000" }), "a.ts", "npm", "@ai-sdk/anthropic")?.unreadableLock).toBe("bun.lockb");
    expect(installedFor(repo({ "package.json": pkg({ ai: "^6" }) }), "a.ts", "npm", "@ai-sdk/anthropic")).toBeUndefined();
  });

  it("Python: poetry/uv locks and pinned requirements", () => {
    const uv = repo({ "pyproject.toml": '[project]\ndependencies = ["Anthropic>=0.40"]\n', "uv.lock": '[[package]]\nname = "anthropic"\nversion = "0.42.0"\n\n[[package]]\nname = "httpx"\nversion = "0.28.1"\n' });
    expect(installedFor(uv, "app/main.py", "pypi", "anthropic")).toEqual({ range: ">=0.40", manifest: "pyproject.toml", version: "0.42.0", lockfile: "uv.lock" });
    const req = repo({ "requirements.txt": "httpx==0.28.1\nanthropic==0.39.0\n" });
    expect(installedFor(req, "main.py", "pypi", "anthropic")?.version).toBe("0.39.0");
  });
});
