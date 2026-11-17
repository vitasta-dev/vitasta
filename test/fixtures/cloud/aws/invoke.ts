import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

const client = new BedrockRuntimeClient({ region: "us-east-1" });
const MODEL = "global.anthropic.claude-sonnet-4-20250514-v1:0";

export async function ask(text: string) {
  return client.send(new ConverseCommand({ modelId: MODEL, messages: [{ role: "user", content: [{ text }] }] }));
}
