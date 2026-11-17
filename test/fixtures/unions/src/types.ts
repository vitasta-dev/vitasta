export type ChatModel = "gpt-4o" | "gpt-3.5-turbo-0613";
export interface Options {
  model: "gpt-4-0613" | "gpt-4o-mini";
  fallbackModel?: ("gpt-4-32k" | "gpt-4o");
  label: "gpt-4-0314" | "other";
}
export class Settings {
  model: "gpt-4-1106-preview" | "gpt-4o" = "gpt-4o";
}
export function run(model: "gpt-3.5-turbo-16k" | "gpt-4o", tokenLimitModel: "gpt-4-0314") {
  return model;
}
type Pricing = Record<"gpt-4-0613" | "gpt-4o", number>;
