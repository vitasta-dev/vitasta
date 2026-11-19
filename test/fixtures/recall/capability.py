from pydantic_ai import Agent

def make_agent():
    return Agent("anthropic:claude-sonnet-4-5", system_prompt="Answer briefly.")
