import OpenAI from "openai";
const client = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_API_KEY });
const r = await client.chat.completions.create({ model: "z-ai/glm-5.1", messages: [] });
