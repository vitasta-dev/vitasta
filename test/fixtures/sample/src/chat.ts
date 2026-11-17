import OpenAI from "openai";
import { anthropic } from "./lib/llm";
import axios from "axios";

const MODEL = "claude-sonnet-4-20250514";
const BASE = process.env.ANTHROPIC_URL || "https://api.anthropic.com";

export class ChatService {
  private client = new OpenAI();

  async assist(threadId: string) {
    // Assistants API (shut down 26 Aug 2026)
    return this.client.beta.threads.runs.create(threadId, { assistant_id: "asst_123" });
  }

  async complete(prompt: string) {
    return this.client.chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: prompt }] });
  }
}

// Cross-file client with a model constant and a parameter that version 2026-10-21 removes
export async function ask(q: string) {
  return anthropic.messages.create({ model: MODEL, max_tokens: 512, temperature: 0.2, messages: [{ role: "user", content: q }] });
}

// Raw HTTP with a base-URL constant
export async function raw(q: string) {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": "k", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-3-5-sonnet-20241022", max_tokens: 10, messages: [] }),
  });
  return res.json();
}

// axios instance with baseURL
const api = axios.create({ baseURL: "https://api.openai.com/v1" });
export const listModels = () => api.get("/models");

// Not ours: own routes and look-alike names must NOT match
export function handleResend() {
  return fetch("/admin/api/users");
}
const tailwind = "text-sm gpt-like";
