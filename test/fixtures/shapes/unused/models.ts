export enum OpenAIModel {
  GPT4o = "gpt-4o",
  GPT4oMini = "gpt-4o-mini",
}
export const defaultModels: Record<string, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4.1",
};
const PRICES = { "gpt-4o": { input: 2.5, output: 10 } };
export function cheap(model: string) {
  return ["gpt-4o-mini", "gpt-4.1-mini"].includes(model);
}
const label = normalizeModelName("gpt-4o");
const loop = new LLMLoop("sk-x", "gpt-4o-mini", "system");
const recorded = { id: "chatcmpl-1", object: "chat.completion", model: "gpt-4o", choices: [], usage: { total_tokens: 3 } };
