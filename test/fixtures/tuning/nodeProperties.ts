// Made-up node definition in the style of workflow tools: model settings described as properties
export const properties = [
  {
    displayName: "Model",
    name: "model",
    type: "resourceLocator",
    default: { mode: "list", value: "claude-sonnet-4-5-20250929" },
  },
  { displayName: "Fallback", name: "fallbackModel", type: "options", default: "claude-3-5-haiku-20241022" },
  { displayName: "Temperature", name: "temperature", type: "number", default: { mode: "list", value: "claude-3-opus-20240229" } },
];
export const notADescriptor = { value: "claude-3-7-sonnet-20250219" };
