import boto3

client = boto3.client("bedrock-runtime")
client.converse(modelId="mistral.mistral-7b-instruct-v0:2", messages=[])
client.converse(modelId="qwen.qwen3-coder-30b-a3b-instruct", messages=[])
