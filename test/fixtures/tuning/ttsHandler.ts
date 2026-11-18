import { GEMINI_TTS_MODELS, DEFAULT_CHAT_MODELS } from "./ttsModels";
export function usesGenerateContent(model: string) {
  return (GEMINI_TTS_MODELS as readonly string[]).includes(model);
}
export const choices = DEFAULT_CHAT_MODELS.map((m) => ({ label: m }));
