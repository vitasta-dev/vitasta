import boto3
from langchain_aws import ChatBedrockConverse

bedrock = boto3.client("bedrock-runtime", region_name="us-east-1")


def ask(prompt: str):
    return bedrock.converse(
        modelId="us.anthropic.claude-3-7-sonnet-20250219-v1:0",
        messages=[{"role": "user", "content": [{"text": prompt}]}],
    )


llm = ChatBedrockConverse(model_id="anthropic.claude-3-5-sonnet-20241022-v2:0", temperature=0)
