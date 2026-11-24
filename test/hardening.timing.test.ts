import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { safePattern } from "../src/config.js";
import { scanRepo } from "../src/scan/index.js";

// Wall-clock limits from the 18 Nov review. They run on their own, one file at a time (vitest.timing.config.ts,
// npm run test:timing), so a parallel test run's load can't trip them; a failure here is a real slowdown.
const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-hard-"));
  for (const [p, t] of Object.entries(files)) await writeFile(join(d, p), t);
  return d;
};
const timed = async (f: () => Promise<unknown>) => {
  const t = Date.now();
  await f();
  return Date.now() - t;
};

describe("18 Nov review: scans stay fast and contained on hostile repos", () => {
  it("F1: long bounded repeats are refused, and a repo's patterns share a time budget", async () => {
    expect(() => safePattern("\\w*\\w*\\w{0,250}!", "p")).toThrow(/up to 32/);
    const tokens = Array.from({ length: 10 }, () => `model: ${"a".repeat(250)}`).join("\n");
    const d = await repo({ ".vitasta.yml": 'providers:\n  - id: acme\n    hosts: [api.acme.example]\n    modelPattern: "\\\\w*\\\\w*\\\\w{0,32}!"\n', "settings.yml": tokens });
    expect(await timed(() => scanRepo(d))).toBeLessThan(8000);
  }, 30_000);

  it("F2: a long line, a long YAML list and a script full of installs scan in linear time", async () => {
    const d = await repo({
      "main.go": `package main\nvar x = ${"a".repeat(40_000)} + "gpt-4o"\n`,
      "models.yml": `models:\n${Array.from({ length: 5000 }, (_, i) => `  - gpt-4o-${i}`).join("\n")}\n`,
      "run.sh": "pip ".repeat(16_000),
    });
    expect(await timed(() => scanRepo(d))).toBeLessThan(8000);
  }, 30_000);
  it("F3 (24 Nov): long word runs, long whitespace and many blank lines scan in linear time in every language", async () => {
    // a desktop app's embedded blob, a padded line, a generated file's blank lines: each once inside a string and once
    // as bare text, next to a provider URL so the URL rules run on the file
    const word = "A".repeat(150_000), space = `x${" ".repeat(60_000)}= 1`, blank = "\n".repeat(20_000);
    const body = (pre: string) => `${pre}\n"${word}"\n${word}\n${space}\n${blank}stripe\n`;
    const d = await repo({
      "A.cs": body('using System.Net.Http;\nclass A { static string U = "https://api.openai.com/v1/chat/completions"; }'),
      "B.java": body('class B { String u = "https://api.openai.com/v1/chat/completions"; }'),
      "c.py": body('import openai\nu = "https://api.openai.com/v1/chat/completions"'),
      "d.rb": body('require "openai"\nu = "https://api.openai.com/v1/chat/completions"'),
      "e.ts": body('import OpenAI from "openai";\nconst u = "https://api.openai.com/v1/chat/completions";'),
      "f.php": body('<?php\n$u = "https://api.stripe.com/v1/payment_intents";'),
      "package.json": '{"dependencies":{"openai":"^4.0.0"}}\n',
      "requirements.txt": "openai>=1.0\n",
    });
    expect(await timed(() => scanRepo(d))).toBeLessThan(15000);
  }, 120_000);

  it("F4 (24 Nov): a 5,000-line C# file with nested classes, many constants and long member lines", async () => {
    const rows: string[] = ["using System;", "using System.Net.Http;", "namespace Desk", "{", "  public partial class Brain", "  {", '    public const string Fastest = "claude-haiku-5-5";', '    private const string Url = "https://api.anthropic.com/v1/messages";'];
    for (let i = 0; rows.length < 5000; i++) {
      rows.push(`    public static class Area${i}`, "    {");
      for (let j = 0; j < 20; j++) {
        const ids = Array.from({ length: 12 }, (_, k) => `alpha${i}_${j}_${k}, beta${k}, gamma${k}`).join(", ");
        rows.push(`      public static readonly System.Collections.Generic.List<string> Field${j} = Make(${ids});`, `      public const string Path${j} = "/v1/area${i}/item${j}";`, `      public static string Model${j} = Fastest;`);
      }
      rows.push("    }");
    }
    rows.push("  }", "}");
    const big = rows.join("\n") + "\n";
    const d = await repo({ "Desk.csproj": '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Anthropic.SDK" Version="5.0.0" /></ItemGroup></Project>\n', "Brain.cs": big, "Brain2.cs": big.replace("namespace Desk", "namespace Desk2"), "Brain3.cs": big.replace("namespace Desk", "namespace Desk3") });
    expect(await timed(() => scanRepo(d))).toBeLessThan(15000);
  }, 120_000);
});
