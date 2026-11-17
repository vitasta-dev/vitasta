// Settings: these should count
export const DEFAULT_MODEL = "gpt-4-turbo";
export const CLAUDE_MODELS = ["claude-3-opus-20240229", "claude-sonnet-5-5"] as const;
export type ChatModel = "gpt-4o" | "gpt-4.1";
const cfg = { model: process.env.MODEL ?? "claude-3-haiku-20240307" };
const m = anthropic("claude-3-5-sonnet-20240620");

// Not settings: these must not count
const PRICES = { "gpt-4o": { inputPerM: 2.5 }, "claude-3-opus-20240229": { inputPerM: 15 } };
const REASONING_MODEL_HINTS = ["o1", "o3", "gpt-5"];
const RETIRED_MODELS = { "gpt-4-0314": "gpt-4o" };
if (model === "gpt-4") console.log("old");
const label = "OCR (gpt-4o-mini vision)";

// Round 2 (from the second review)
export const SUPPORTED_MODELS = ["gpt-4o-mini", "o1-mini"] as const;
export const MODEL_REGISTRY = [{ name: "claude-3-haiku-20240307", provider: "anthropic" }];
export const MODELS = { "gpt-4-0125-preview": "GPT 4 Turbo" } as const;
const NO_SAMPLING_MODELS = new Set(["claude-opus-4-8", "o3"]);
const out = generateText(prompt, system, "claude-3-opus-20240229", 4000);
const n = countTokens("gpt-4o", text);
