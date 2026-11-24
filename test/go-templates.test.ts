import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scanRepo } from "../src/scan/index.js";
import { templateUsages } from "../src/scan/gotemplates.js";

vi.setConfig({ testTimeout: 60_000 });

const scan = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-gotpl-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return (await scanRepo(d)).usages as any[];
};
const body = (model: string, extra = "") => `{\n  "model": ${model},\n  "messages": [{"role": "user", "content": "{{ .Prompt }}"}]${extra}\n}\n`;

describe("Go template defaults for a request body's model and settings", () => {
  it("a pipeline default, Sprig's function form, or/coalesce, and a plain literal", async () => {
    for (const v of [`"{{ .Model | default "gpt-4o" }}"`, `"{{ default "gpt-4o" .Model }}"`, `"{{ or .Model "gpt-4o" }}"`, `"{{ coalesce .Model "gpt-4o" }}"`, `"{{ .Values.model | default "gpt-4o" | quote }}"`, `"gpt-4o"`, `"{{ "gpt-4o" }}"`, `"{{ .Model | default \\"gpt-4o\\" }}"`]) {
      const us = await scan({ "templates/chat.json.tmpl": body(v) });
      const u = us.find((x) => x.file === "templates/chat.json.tmpl" && x.model === "gpt-4o");
      expect(u, v).toMatchObject({ provider: "openai", kind: "model-ref", line: 2, setting: true });
      // the span covers the literal itself, so a fix swaps just that
      const text = body(v);
      expect(text.slice(u.modelSpan.start, u.modelSpan.end).replace(/\\/g, "")).toMatch(/^"?gpt-4o"?$/);
    }
  });
  it("a template inside a Go raw string", async () => {
    const go = "package main\n\nimport \"text/template\"\n\nvar tpl = template.Must(template.New(\"b\").Parse(`{\"model\": \"{{ .Model | default \"claude-3-5-sonnet-20241022\" }}\", \"max_tokens\": 100}`))\n";
    const us = await scan({ "main.go": go });
    expect(us.find((u) => u.file === "main.go" && u.model === "claude-3-5-sonnet-20241022")).toMatchObject({ provider: "anthropic", line: 5 });
  });
  it("sampling settings with a literal or a default, on the URL's operation", async () => {
    const t = `# POST https://api.openai.com/v1/chat/completions\n{\n  "model": "gpt-4o",\n  "temperature": {{ .Temp | default 0.7 }},\n  "top_p": 0.9,\n  "max_tokens": {{ .Max }}\n}\n`;
    const us = await scan({ "req.tmpl": t });
    const p = (n: string) => us.find((u) => u.file === "req.tmpl" && u.params?.includes(n));
    expect(p("temperature")).toMatchObject({ provider: "openai", op: "POST /v1/chat/completions", line: 4 });
    expect(p("top_p")).toMatchObject({ line: 5 });
    expect(p("max_tokens")).toBeUndefined(); // no literal in it
  });
  it("Helm chart values default", async () => {
    const us = await scan({ "chart/templates/cm.yaml": "data:\n  config.yaml: |\n    model: {{ .Values.llm.model | default \"gpt-4o\" }}\n" });
    expect(us.find((u) => u.file === "chart/templates/cm.yaml")).toMatchObject({ model: "gpt-4o", line: 3 });
  });
  it("a setting with no provider signal is not reported (Helm values-style template), but a provider call in the rendering Go file is one", async () => {
    const helm = "data:\n  config.yaml: |\n    temperature: {{ .Values.llm.temperature | default 0.7 }}\n    top_p: 0.9\n";
    expect(templateUsages("chart/templates/cm.yaml", "config", helm, [])).toEqual([]);
    expect((await scan({ "chart/templates/cm.yaml": helm })).filter((u) => u.file.startsWith("chart/"))).toEqual([]);
    const tpl = 'var tpl = `{"temperature": {{ .T | default 0.7 }}}`';
    expect(templateUsages("r.go", "go", tpl, [])).toEqual([]);
    expect(templateUsages("r.go", "go", tpl, [], "openai")[0]).toMatchObject({ provider: "openai", params: ["temperature"], op: "POST /v1/chat/completions" });
  });
  it("nothing to report: no literal, an unknown model, a non-template file, a tests folder", async () => {
    expect(templateUsages("a.tmpl", "config", body(`"{{ .Model }}"`), [])).toEqual([]);
    expect(templateUsages("a.tmpl", "config", body(`"{{ .Model | default .Fallback }}"`), [])).toEqual([]);
    expect(templateUsages("a.tmpl", "config", body(`"{{ .Model | default "my-custom-model" }}"`), [])).toEqual([]);
    expect(templateUsages("a.tmpl", "config", body(`"gpt-{{ .Version }}"`), [])).toEqual([]);
    expect((await scan({ "notes.txt": body(`"gpt-4o"`) })).filter((u) => u.file === "notes.txt")).toEqual([]);
    expect((await scan({ "test/fixtures/a.tmpl": body(`"gpt-4o"`) })).filter((u) => u.file.endsWith("a.tmpl"))).toEqual([]);
  });
});
