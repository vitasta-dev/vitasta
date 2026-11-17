import OpenAI from "openai";
const client = new OpenAI();
const TUTOR_PROMPT_ID = "pmpt_697cea54d5cc81949af709b0578e7c2e03cdab38bfa23520";
export async function run() {
  const response = await client.responses.create({
    prompt: {
      id: "pmpt_689b7a77a77881949cce76f379c95b4d07b6014ec8a9f3bf",
      variables: { emails: "x" },
    },
  });
  const pmpt_embeds = "pmpt_embeds";
  return response;
}
