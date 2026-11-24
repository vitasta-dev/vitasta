import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-fix679-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};

describe("fix 6: paths named through a transport, or as routing data", () => {
  it("a transport joining an OpenAI base with its endpoint parameter; the caller's path is the operation", async () => {
    const us = (await scanRepo(await repo({
      "openai/transport/index.ts": "export async function apiRequest(this: any, method: string, endpoint: string, parameters?: any) {\n  const baseUrl = this.creds.url || 'https://api.openai.com/v1';\n  return this.helpers.request({ method, uri: `${baseUrl}${endpoint}`, ...parameters });\n}\n",
      "openai/actions/translate.ts": "import { apiRequest } from '../transport';\n\nexport async function execute(this: any) {\n  return await apiRequest.call(this, 'POST', '/audio/translations', { option: {} });\n}\n",
    }))).usages;
    expect(us.find((u: any) => u.file === "openai/actions/translate.ts" && u.op)).toMatchObject({ line: 4, op: "POST /v1/audio/translations", provider: "openai" });
  });
  it("a routed request description, with the base URL in the node that imports it", async () => {
    const us = (await scanRepo(await repo({
      "OpenAi/TextDescription.ts": "export const textOperations = [\n  {\n    name: 'Edit',\n    routing: {\n      request: {\n        method: 'POST',\n        url: '/v1/edits',\n      },\n    },\n  },\n];\n",
      "OpenAi/OpenAi.node.ts": "import { textOperations } from './TextDescription';\n\nexport const description = {\n  requestDefaults: { baseURL: '={{ $credentials.url ?? \"https://api.openai.com\" }}' },\n  properties: [...textOperations],\n};\n",
    }))).usages;
    expect(us.find((u: any) => u.file === "OpenAi/TextDescription.ts" && u.op)).toMatchObject({ line: 7, op: "POST /v1/edits" });
  });
});

describe("fix 7 and fix 9", () => {
  it("a Graph version read from configuration by key, put into a URL", async () => {
    const us = (await scanRepo(await repo({
      "src/config/env.config.ts": "export const load = () => ({\n  WA_BUSINESS: {\n    URL: process.env.WA_URL || 'https://graph.facebook.com',\n    VERSION: process.env.WA_VERSION || 'v18.0',\n  },\n});\n",
      "src/whatsapp.service.ts": "import axios from 'axios';\nexport class WhatsAppBusinessService {\n  async post(m: any) {\n    const base = this.configService.get<WaBusiness>('WA_BUSINESS').URL;\n    const version = this.configService.get<WaBusiness>('WA_BUSINESS').VERSION;\n    const url = `${base}/${version}/${this.number}/messages`;\n    return axios.post(url, m);\n  }\n}\n",
    }))).usages;
    expect(us.find((u: any) => u.file === "src/whatsapp.service.ts" && u.apiVersion)).toMatchObject({ line: 5, apiVersion: "setter: v18.0", provider: "meta" });
  });
  it("a request header pin also stands for the URL built next to it", async () => {
    const us = (await scanRepo(await repo({
      "runs.js": "const axios = require('axios');\nasync function retrieveRun({ thread_id, run_id, openai }) {\n  const { apiKey, baseURL } = openai;\n  let url = `${baseURL}/threads/${thread_id}/runs/${run_id}`;\n\n  let headers = {\n    Authorization: `Bearer ${apiKey}`,\n    'OpenAI-Beta': 'assistants=v1',\n  };\n  return axios.get(url, { headers });\n}\nmodule.exports = { retrieveRun };\n",
    }))).usages;
    expect(us.find((u: any) => u.apiVersion?.startsWith("openai-beta"))?.alsoLines).toEqual([4]);
  });
});
