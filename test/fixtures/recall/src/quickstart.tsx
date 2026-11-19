export const SNIPPET = `
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic();
const msg = await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 1024, messages: [] });
`;
