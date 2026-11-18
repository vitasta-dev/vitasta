export const anthropicModels = {
  "claude-3-opus-20240229": { maxTokens: 4096, contextWindow: 200000, supportsImages: true },
  "claude-sonnet-4-5": { maxTokens: 8192, contextWindow: 200000, supportsImages: true },
};
export const anthropicPricing = {
  "claude-3-opus-20240229": { input: 15, output: 75 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
};
