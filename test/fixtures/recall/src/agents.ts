import { Agent } from "@mastra/core/agent";

export const writer = new Agent({ name: "writer", instructions: "Write.", model: 'openai/gpt-4.1' });
export const router = new Agent({ name: "router", instructions: "Route.", model: "mastra/openai/gpt-5-mini" });
