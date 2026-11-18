export const REGISTRY = {
  "o4-mini": { id: "o4-mini", provider: "azure-openai-responses", contextWindow: 200000 },
  "gpt-4.1": { id: "gpt-4.1", provider: "azure-openai-responses", contextWindow: 1000000 },
};
export const GITHUB_MODELS = [
  { name: "openai/o1-mini", label: "o1-mini", provider: "Github" },
  { name: "openai/gpt-4o", label: "gpt-4o", provider: "Github" },
];
export const OPENAI_MODELS = ["gpt-4o", "gpt-4o-mini"];
export type ClaudeModel = "claude-opus-4-5" | "claude-sonnet-4-5";
