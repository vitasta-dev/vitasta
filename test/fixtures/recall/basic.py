from agno.agent import Agent
from agno.models.anthropic import Claude

agent = Agent(model=Claude(id="claude-sonnet-4-5-20250929"), markdown=True)
