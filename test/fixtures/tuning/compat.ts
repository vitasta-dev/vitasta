export const TOOL_SCHEMA_COMPATIBILITY = [
  { provider: "OpenAI", models: ["gpt-4o", "gpt-4o-mini"] },
  { provider: "Anthropic", models: ["claude-sonnet-4-5"] },
];
export const COMPUTER_USE_MODELS = new Set(["claude-sonnet-4-5", "claude-opus-4-1"]);
export function canUseComputer(model: string) {
  return COMPUTER_USE_MODELS.has(model);
}
export const PICKER_MODELS = ["gpt-4o", "gpt-4.1"];
export function picker() {
  return PICKER_MODELS.map((m) => ({ value: m }));
}
export const agent = { model: "google/gemini-2.5-flash" };
