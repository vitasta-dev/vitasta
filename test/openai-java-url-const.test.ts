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

const J = "src/main/java/app/Api.java";
const ops = (us: any[]) => us.filter((u) => u.file === J && u.provider === "openai" && u.op).map((u) => u.op);

describe("Java Assistants: a URL constant POSTed through RestTemplate, OkHttp and HttpClient", () => {
  const cls = (imports: string, body: string) => `package app;\n${imports}\npublic class Api {\n  private static final String THREADS_URL = "https://api.openai.com/v1/threads";\n${body}\n}\n`;
  const shapes: [string, string][] = [
    ["RestTemplate", cls("import org.springframework.web.client.RestTemplate;", `  RestTemplate rt = new RestTemplate();\n  public String createThread() {\n    return rt.postForObject(THREADS_URL, null, String.class);\n  }`)],
    ["OkHttp", cls("import okhttp3.*;", `  OkHttpClient client = new OkHttpClient();\n  public String createThread() throws Exception {\n    Request req = new Request.Builder().url(THREADS_URL).post(RequestBody.create(new byte[0])).header("OpenAI-Beta", "assistants=v2").build();\n    return client.newCall(req).execute().body().string();\n  }`)],
    ["HttpClient", cls("import java.net.http.*;\nimport java.net.URI;", `  HttpClient client = HttpClient.newHttpClient();\n  public String createThread() throws Exception {\n    HttpRequest req = HttpRequest.newBuilder().uri(URI.create(THREADS_URL)).POST(HttpRequest.BodyPublishers.noBody()).header("OpenAI-Beta", "assistants=v2").build();\n    return client.send(req, HttpResponse.BodyHandlers.ofString()).body();\n  }`)],
  ];
  for (const [name, src] of shapes) {
    it(`${name}: POST /v1/threads is found`, async () => {
      expect(ops(await scan({ [J]: src }))).toContain("POST /v1/threads");
    });
  }
  it("negative: a constant that isn't posted anywhere still isn't a request with a method", async () => {
    const us = await scan({ [J]: cls("", "  public String url() { return THREADS_URL; }") });
    expect(ops(us).filter((o) => o.startsWith("POST"))).toEqual([]);
  });
});
