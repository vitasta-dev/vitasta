import OpenAI from "openai";
const client = new OpenAI();
export const a = () => client.chat.completions.create({ model: "gpt-4", messages: [] });
export const b = () => client.chat.completions.create({ model: "gpt-3.5-turbo", messages: [] });
export const bill = () => fetch("https://billing.acme.internal/v1/invoices", { method: "POST", body: "{}" });
