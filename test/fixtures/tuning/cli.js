const model = getArg("--model", "claude-sonnet-4-5-20250929");
yargs.option("judge-model", { default: "gpt-4o-mini" });
const Config = z.object({ model: z.string().default("gpt-4o") });
const model = { id: "gpt-5.1-codex", api: "openai-responses", provider: "openai" };
const embedder = new GeminiEmbedder("key", "text-embedding-004");
const user = { id: "gpt-4o", name: "someone" };
