export const PRICES: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
};
export const VISION_MODELS = ["gpt-4o", "claude-sonnet-4-5"];
export const supportsVision = (m: string) => VISION_MODELS.includes(m);
