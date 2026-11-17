import OpenAI from "openai";

// The OpenAI SDK pointed at Groq's compatible endpoint
const groq = new OpenAI({ baseURL: "https://api.groq.com/openai/v1", apiKey: process.env.GROQ_API_KEY });

export async function ask(q: string) {
  return groq.chat.completions.create({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: q }] });
}
