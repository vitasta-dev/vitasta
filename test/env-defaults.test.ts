import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hasOwnDefault } from "../src/scan/envdefaults.js";
import { scanRepo } from "../src/scan/index.js";
import { roleFor } from "../src/scan/roles.js";

vi.setConfig({ testTimeout: 60_000 });

const scan = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-envdef-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return (await scanRepo(d)).usages as any[];
};
const at = (us: any[], file: string) => us.find((u) => u.file === file && u.model === "gpt-4o");
const py = (read: string) => `import os\nfrom openai import OpenAI\nc = OpenAI()\nm = ${read}\nc.chat.completions.create(model=m, messages=[])\n`;

describe("own-default detection", () => {
  it("recognises the default forms and the bare ones", () => {
    for (const r of [`", "gpt-4o")`, `"] ?? "x"`, `"]||"x"`, ` ?? "x"`, `") or "x"`, `") { "x" }`]) expect(hasOwnDefault(r), r).toBe(true);
    for (const r of [`")`, `"]`, ` + 1`, `")\n`, ` }`]) expect(hasOwnDefault(r), r).toBe(false);
  });
});

describe(".env.example values count only when code reads the variable without its own default", () => {
  const env = ".env.example";
  const line = "OPENAI_MODEL=gpt-4o\n";
  it("read with no default: stays the app's default (breaks)", async () => {
    const u = at(await scan({ [env]: line, "app.py": py(`os.environ["OPENAI_MODEL"]`) }), env);
    expect(u.envShadowed).toBeUndefined();
    expect(u.envUnread).toBeUndefined();
    expect(roleFor(u)).toBe("breaks");
  });
  it("every read has its own default: a note", async () => {
    for (const read of [`os.getenv("OPENAI_MODEL", "gpt-4.1")`, `os.environ.get("OPENAI_MODEL") or "gpt-4.1"`]) {
      const u = at(await scan({ [env]: line, "app.py": py(read) }), env);
      expect(u.envShadowed, read).toBe(true);
      expect(roleFor(u)).toBe("users-copy");
    }
    const js = `import OpenAI from "openai";\nconst c = new OpenAI();\nawait c.chat.completions.create({ model: process.env.OPENAI_MODEL ?? "gpt-4.1", messages: [] });\n`;
    expect(at(await scan({ [env]: line, "a.ts": js }), env).envShadowed).toBe(true);
    expect(at(await scan({ [env]: line, "application.properties": "x=${OPENAI_MODEL:gpt-4.1}\n" , "A.java": "class A {}" }), env).envShadowed).toBe(true);
  });
  it("one bare read among defaults keeps it real; no read at all leaves it as it was", async () => {
    const both = py(`os.environ["OPENAI_MODEL"]`) + py(`os.getenv("OPENAI_MODEL", "x")`);
    expect(at(await scan({ [env]: line, "app.py": both }), env).envShadowed).toBeUndefined();
    const u = at(await scan({ [env]: line, "app.py": py(`"gpt-4.1"`) }), env);
    expect(u.envUnread).toBeUndefined();
    expect(u.envShadowed).toBeUndefined();
  });
  it("a read through a config placeholder counts: bare is real, with a default is a note", async () => {
    expect(at(await scan({ [env]: line, "src/main/resources/application.yml": "ai:\n  model: ${OPENAI_MODEL}\n" }), env).envShadowed).toBeUndefined();
    expect(at(await scan({ [env]: line, "src/main/resources/application.yml": "ai:\n  model: ${OPENAI_MODEL:gpt-4.1}\n" }), env).envShadowed).toBe(true);
    // another file that merely sets the variable isn't a read
    expect(at(await scan({ [env]: line, "k8s/dep.yaml": "env:\n  - OPENAI_MODEL=gpt-4o\n" }), env).envShadowed).toBeUndefined();
  });
  it("a plain .env (the real one) is left alone", async () => {
    const u = at(await scan({ ".env": line, "app.py": py(`os.getenv("OPENAI_MODEL", "x")`) }), ".env");
    expect(u.envShadowed).toBeUndefined();
  });
});

describe("docker-compose environment entries override code defaults only for a service that runs that code", () => {
  const code = py(`os.getenv("OPENAI_MODEL", "gpt-4.1")`);
  const compose = (svc: string) => `services:\n${svc}`;
  const web = `  web:\n    build: ./api\n    environment:\n      - OPENAI_MODEL=gpt-4o\n`;
  it("a service built from the folder that reads it: the compose value is real, default or not", async () => {
    const u = at(await scan({ "docker-compose.yml": compose(web), "api/app.py": code }), "docker-compose.yml");
    expect(u.envShadowed).toBeUndefined();
    expect(roleFor(u)).toBe("breaks");
  });
  it("no code reads the variable at all: the entry stays as it was (the image may read it)", async () => {
    const img = `  bot:\n    image: bot\n    environment:\n      OPENAI_MODEL: gpt-4o\n`;
    expect(at(await scan({ "docker-compose.yml": compose(img) }), "docker-compose.yml").envShadowed).toBeUndefined();
  });
  it("an image-only service, or a build folder whose code doesn't read it, while the repo's reads all have defaults: a note", async () => {
    const img = `  redis:\n    image: some/proxy:1\n    environment:\n      OPENAI_MODEL: gpt-4o\n`;
    const u1 = at(await scan({ "docker-compose.yml": compose(img), "api/app.py": code }), "docker-compose.yml");
    expect(u1.envShadowed).toBe(true);
    expect(u1.reason).toMatch(/only pulls an image/);
    const other = `  web:\n    build:\n      context: ./worker\n    environment:\n      - OPENAI_MODEL=gpt-4o\n`;
    const u2 = at(await scan({ "docker-compose.yml": compose(other), "api/app.py": code, "worker/w.py": "print(1)\n" }), "docker-compose.yml");
    expect(u2.envShadowed).toBe(true);
    expect(u2.reason).toMatch(/no code in service web/);
  });
  it("a bind-mounted repo folder counts as running its code", async () => {
    const mount = `  web:\n    image: python:3.12\n    volumes:\n      - ./api:/app\n    environment:\n      OPENAI_MODEL: gpt-4o\n`;
    expect(at(await scan({ "docker-compose.yml": compose(mount), "api/app.py": code }), "docker-compose.yml").envShadowed).toBeUndefined();
  });
});
