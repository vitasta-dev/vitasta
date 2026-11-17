import Anthropic from "@anthropic-ai/sdk";

// Shared client used by other files
export const anthropic = new Anthropic({
  defaultHeaders: { "anthropic-version": "2023-06-01" },
});

export const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";
