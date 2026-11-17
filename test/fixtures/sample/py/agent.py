import os
import openai
import httpx
from anthropic import Anthropic

CLAUDE = os.environ.get("CLAUDE_MODEL", "claude-3-opus-20240229")


class Agent:
    def __init__(self) -> None:
        self.client = Anthropic()

    def think(self, prompt: str):
        return self.client.messages.create(
            model=CLAUDE,
            max_tokens=1024,
            top_p=0.9,
            messages=[{"role": "user", "content": prompt}],
        )


def legacy(prompt: str):
    # openai<1.0 style
    return openai.ChatCompletion.create(model="gpt-4", messages=[{"role": "user", "content": prompt}])


def raw_http():
    with httpx.Client(base_url="https://api.openai.com/v1") as c:
        return c.post("/assistants", json={"model": "gpt-4o", "name": "helper"})


def typed(client: Anthropic):
    return client.messages.create(model="claude-opus-4-1-20250805", max_tokens=10, messages=[])
