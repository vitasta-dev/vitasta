MODELS = {
    "gpt-5.3-codex": ModelInfo(id="gpt-5.3-codex", name="GPT-5.3 Codex", provider="openai"),
    "gpt-4o": ModelInfo(id="gpt-4o", name="GPT-4o", provider="openai"),
}

supervisor = supervisor_configs["gpt-4o-mini"]
cost = MODEL_PRICES["gpt-4o-mini"]
