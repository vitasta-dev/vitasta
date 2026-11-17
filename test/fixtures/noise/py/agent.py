import os

MODEL = os.environ.get("OPENAI_MODEL", "gpt-4-turbo")       # setting
FALLBACKS = ["gpt-4o", "gpt-4.1"]                            # a list of models in a repo that uses OpenAI: listed
CONTEXT_WINDOWS = {"gpt-4o": 128000}                         # table: not a setting
for m in ("gpt-4o", "o3"):                                   # a loop over models: listed
    src = f'client.chat.completions.create(model="{m}")'
llm = ChatOpenAI(model="gpt-3.5-turbo")                      # setting (keyword)
from openai import OpenAI
relay = OpenAI(base_url="https://relay.example.com/v1")
relay.chat.completions.create(model="gpt-4-turbo", messages=[])
