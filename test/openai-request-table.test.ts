import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scanRepo } from "../src/scan/index.js";

vi.setConfig({ testTimeout: 120_000 });

const scan = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-oa-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return (await scanRepo(d)).usages as any[];
};

const GOMOD = "module example.com/analyzer\n\ngo 1.22\n";
const rows = (us: any[], file: string) => us.filter((u) => u.file === file && u.op).map((u) => `${u.line} ${u.op}`);

describe("a request table: {Method, Endpoint} probes joined to a base constant elsewhere", () => {
  it("Go: each entry whose method and path are a provider operation is reported at its line", async () => {
    const us = await scan({
      "go.mod": GOMOD,
      "consts.go": `package analyzer\nconst BASE_URL = "https://api.openai.com"\n`,
      "probes.go": `package analyzer
import "net/http"
type probe struct { Method, Endpoint string }
var probes = []probe{
	{"GET", "/v1/models"},
	{"GET", "/v1/assistants"},
	{"GET", "/v1/threads/1"},
	{"POST", "/v1/evals"},
	{Method: "DELETE", Endpoint: "/v1/assistants/asst_1"},
}
func Run(client *http.Client) {
	for _, p := range probes {
		req, _ := http.NewRequest(p.Method, BASE_URL+p.Endpoint, nil)
		client.Do(req)
	}
}
`,
    });
    const r = rows(us, "probes.go");
    expect(r).toEqual(expect.arrayContaining(["6 GET /v1/assistants", "7 GET /v1/threads/1", "8 POST /v1/evals", "9 DELETE /v1/assistants/asst_1"]));
  });
  it("TS and Python: the same shape (object rows, tuples)", async () => {
    const ts = await scan({ "base.ts": `export const BASE_URL = "https://api.openai.com";\n`, "probes.ts": `import { BASE_URL } from "./base";\nconst probes = [\n  { method: "GET", path: "/v1/assistants" },\n  { path: "/v1/threads/abc", method: "POST" },\n];\nexport const run = () => probes.map((p) => fetch(BASE_URL + p.path, { method: p.method }));\n` });
    expect(rows(ts, "probes.ts")).toEqual(expect.arrayContaining(["3 GET /v1/assistants", "4 POST /v1/threads/abc"]));
    const py = await scan({ "base.py": `BASE_URL = "https://api.openai.com"\n`, "probes.py": `import requests\nfrom base import BASE_URL\nPROBES = [\n    ("GET", "/v1/assistants"),\n    ("POST", "/v1/evals"),\n]\ndef run():\n    for m, p in PROBES:\n        requests.request(m, BASE_URL + p)\n` });
    expect(rows(py, "probes.py")).toEqual(expect.arrayContaining(["4 GET /v1/assistants", "5 POST /v1/evals"]));
  });
  it("negatives: a route table the app serves, a table in a file that sends nothing, an unknown path, a verb the operation lacks", async () => {
    const base = { "go.mod": GOMOD, "consts.go": `package analyzer\nconst BASE_URL = "https://api.openai.com"\n` };
    // routes the repo registers itself
    const routes = await scan({ ...base, "r.go": `package analyzer\nimport "net/http"\ntype route struct{ Method, Path string }\nvar routes = []route{\n\t{"GET", "/v1/assistants"},\n}\nfunc Serve(mux *http.ServeMux) {\n\tmux.HandleFunc("/v1/assistants", nil)\n\thttp.ListenAndServe(":80", mux)\n}\n` });
    expect(rows(routes, "r.go")).toEqual([]);
    // a table, but nothing here sends a request
    const idle = await scan({ ...base, "t.go": `package analyzer\nvar docs = [][2]string{\n\t{"GET", "/v1/assistants"},\n}\n` });
    expect(rows(idle, "t.go")).toEqual([]);
    // not an operation / not that verb
    const other = await scan({ ...base, "o.go": `package analyzer\nimport "net/http"\nvar p = [][2]string{\n\t{"GET", "/v1/widgets"},\n\t{"PATCH", "/v1/assistants"},\n}\nfunc Run(c *http.Client) { http.NewRequest(p[0][0], BASE_URL+p[0][1], nil) }\n` });
    expect(rows(other, "o.go")).toEqual([]);
  });
});
