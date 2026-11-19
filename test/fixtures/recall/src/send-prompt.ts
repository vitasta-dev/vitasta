import { Property } from "@activepieces/pieces-framework";

export const props = {
  model: Property.StaticDropdown({
    displayName: "Model",
    required: true,
    defaultValue: 'gpt-3.5-turbo',
    options: { options: [] },
  }),
};
