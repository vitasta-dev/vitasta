import Anthropic from "@anthropic-ai/sdk";
import { AzureOpenAI } from "openai";

const createClient = (apiKey: string) => new Anthropic({ apiKey });

export async function testKey(apiKey: string) {
  const client = createClient(apiKey);
  return client.messages.create({ model: "claude-3-haiku-20240307", max_tokens: 8, messages: [] });
}

// Azure deployments follow Azure's retirement schedule, not OpenAI's
const azure = new AzureOpenAI({ apiVersion: "2024-10-21" });
export const azureChat = () => azure.chat.completions.create({ model: "gpt-4", messages: [] });
