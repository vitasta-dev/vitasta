from enum import Enum


class ModelType(str, Enum):
    GPT_4O = "gpt-4o"
    O1 = "o1"


LLM_PRESETS = (
    ("OpenAI", "https://api.openai.com/v1", "gpt-4o-mini"),
    ("Groq", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile"),
)
ALIASES = {"gpt-4o-0806": "gpt-4o-2024-08-06", "mini": "gpt-4o-mini-2024-07-18"}


def fallback_groq_models():
    return ["llama-3.1-8b-instant", "llama-3.1-70b-versatile"]


def run(m):
    if m in ["gpt-4", "gpt-4o"]:
        return get_chat_model("gpt-4o")
