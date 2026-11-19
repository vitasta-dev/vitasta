from openai import AsyncOpenAI

DEFAULT_MODEL = 'gpt-4.1-mini'


class OpenAIGenericClient:
    def __init__(self, client: AsyncOpenAI | None = None):
        self.client = client or AsyncOpenAI()
