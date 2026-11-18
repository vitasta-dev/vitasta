import os
from openai import OpenAI, AzureOpenAI
from pydantic import BaseModel, Field

if API_TYPE == "openai":
    model = os.getenv("MODEL_VERSION", "gpt-4o-2024-11-20")
elif API_TYPE == "azure":
    client = AzureOpenAI()
    model = os.getenv("MODEL_VERSION", "gpt-4o-2024-08-06")


class Settings(BaseModel):
    qa_model: str = Field(default="gpt-4.1-mini", description="QA model")


def vision(model_id):
    return model_id.lower().startswith(("gpt-5", "gpt-4o", "o3"))


def tokens(api_model):
    if any(x in api_model.lower() for x in ("gpt-5", "o1", "o3")):
        return 1


PREFIXES = ("gpt-4o", "gpt-4.1")


def is_new(name):
    return name.startswith(PREFIXES)
