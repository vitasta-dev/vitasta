import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scanRepo } from "../src/scan/index.js";
import { roleFor } from "../src/scan/roles.js";
import { sqlSeedUsagesIn, tablePattern } from "../src/scan/sqlseeds.js";

vi.setConfig({ testTimeout: 60_000 });

const scan = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-sqlseed-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return (await scanRepo(d)).usages as any[];
};
const SQL = `-- seed
INSERT INTO llm_providers (name, model, temperature, top_p) VALUES
  ('openai', 'gpt-4o', 0.7, 1.0),
  ('other', 'my-own-model', 0.2, 1.0);
`;
const reader = `package main

import "github.com/openai/openai-go"

type LlmProvider struct{ Model string; Temperature float64 }

func run(p LlmProvider) {
	rows := db.Query("SELECT model, temperature FROM llm_providers")
	_ = rows
	client := openai.NewClient()
	client.Chat.Completions.New(ctx, openai.ChatCompletionNewParams{Model: openai.ChatModel(p.Model), Temperature: openai.Float(p.Temperature)})
}
`;
const rows = (us: any[]) => us.filter((u) => u.file.endsWith(".sql"));

describe("SQL seed rows for provider settings", () => {
  it("the table is read into a provider request: the model and temperature are configuration", async () => {
    const us = rows(await scan({ "db/migrations/001_seed.sql": SQL, "main.go": reader }));
    const m = us.find((u) => u.model === "gpt-4o");
    expect(m).toMatchObject({ provider: "openai", line: 3, sqlSeed: "linked", setting: true });
    expect(roleFor(m)).toBe("breaks");
    expect(SQL.slice(m.modelSpan.start, m.modelSpan.end)).toBe("gpt-4o");
    const t = us.find((u) => u.params?.includes("temperature"));
    expect(t).toMatchObject({ op: "POST /v1/chat/completions", line: 3 });
    expect(us.some((u) => u.params?.includes("top_p"))).toBe(true);
    // an unknown model name isn't a model
    expect(us.some((u) => u.line === 4 && u.model)).toBe(false);
  });
  it("linked even in a seeds/ folder (which is otherwise recorded data)", async () => {
    const us = rows(await scan({ "db/seeds/llm.sql": SQL, "main.go": reader }));
    expect(roleFor(us.find((u) => u.model === "gpt-4o"))).toBe("breaks");
  });
  it("no code reads the table into a request: a note", async () => {
    for (const code of [{}, { "main.go": reader.replace(/llm_providers/g, "other_table").replace(/LlmProvider/g, "Other") }, { "main.go": "package main\n// llm_providers is read here\nfunc f() { db.Query(\"select * from llm_providers\") }\n" }]) {
      const us = rows(await scan({ "db/migrations/001_seed.sql": SQL, ...code }));
      const m = us.find((u) => u.model === "gpt-4o");
      expect(m, JSON.stringify(Object.keys(code))).toMatchObject({ recorded: true });
      expect(roleFor(m)).toBe("recorded");
      expect(m.sqlSeed).toBeUndefined();
    }
  });
  it("price and capability tables, big model lists, and rows without a model column are not settings", async () => {
    const us = await scan({
      "a.sql": "INSERT INTO model_prices (model, input_price) VALUES ('gpt-4o', 2.5);\n",
      "b.sql": `INSERT INTO llm_models (model) VALUES ${["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-3.5-turbo", "o3", "o4-mini", "gpt-4-turbo"].map((m) => `('${m}')`).join(", ")};\n`,
      "c.sql": "INSERT INTO users (name, email) VALUES ('gpt-4o', 'a@b.c');\n",
      "main.go": reader,
    });
    for (const f of ["a.sql", "b.sql"]) for (const u of us.filter((x) => x.file === f)) expect(u.listed, f).toBe(true);
    expect(us.some((u) => u.file === "c.sql")).toBe(false);
  });
  it("name matching and parsing helpers", () => {
    const re = tablePattern("public.llm_providers")!;
    for (const t of ["llm_providers", "LlmProvider", "llmProviders", "LlmProviders"]) expect(re.test(`x ${t} y`), t).toBe(true);
    expect(re.test("xllm_providersy")).toBe(false);
    expect(sqlSeedUsagesIn("a.sql", "INSERT INTO t (model) VALUES ('it''s');\n")).toEqual([]);
  });
});
