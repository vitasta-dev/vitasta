import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

const client = new BedrockRuntimeClient({ region: "us-east-1" });
export const reply = await client.send(new ConverseCommand({ modelId: "us.meta.llama3-1-405b-instruct-v1:0", messages: [] }));
export const fast = await client.send(new ConverseCommand({ modelId: "deepseek.v3.1", messages: [] }));
