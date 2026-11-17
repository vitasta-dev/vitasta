export const MODEL_COLORS: Record<string, string> = {
  "claude-sonnet-4-5": "#2563eb",
  "claude-haiku-4-5-20251001": "#10b981",
};
export const MODELS = {
  "claude-sonnet-4-5": "Claude Sonnet 4.5",
};
export const ANTHROPIC_MODELS = [
  { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5" },
];
export type AnthropicModel = "claude-sonnet-4-5-20250929" | "claude-haiku-4-5-20251001";
export const agents = [{ model: "claude-sonnet-4-5", name: "researcher" }];
