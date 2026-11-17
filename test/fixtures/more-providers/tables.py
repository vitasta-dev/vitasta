CONTEXT_SIZES = {
    "claude-sonnet-4-5@20250929": 200000,
}
PRICES = {
    "claude-sonnet-4-5@20250929": {"input_tokens_per_million": 3.0},
}
CATALOG = [
    {"value": "claude-sonnet-4-5@20250929", "label": "Sonnet 4.5", "tier": "Legacy"},
]
ALIASES = {
    "claude-sonnet-4-5": "claude-sonnet-4-5@20250929",
}

def make_generator(region: str, model: str = "claude-sonnet-4-5@20250929"):
    return region, model
