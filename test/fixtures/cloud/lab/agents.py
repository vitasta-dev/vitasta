from anthropic import AnthropicVertex
from google import genai

vertex_claude = AnthropicVertex(region="us-east5", project_id="my-project")


def summarize(text: str):
    return vertex_claude.messages.create(
        model="claude-sonnet-4-5@20250929",
        max_tokens=256,
        messages=[{"role": "user", "content": text}],
    )


client = genai.Client(vertexai=True, project="my-project", location="us-central1")


def classify(text: str):
    return client.models.generate_content(model="gemini-2.5-flash", contents=text)
