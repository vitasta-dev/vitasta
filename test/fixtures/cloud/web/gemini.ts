import { GoogleGenAI } from "@google/genai";

// Gemini API (AI Studio key), not Vertex
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export const answer = (q: string) => ai.models.generateContent({ model: "gemini-2.0-flash", contents: q });
