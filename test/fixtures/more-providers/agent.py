from upsonic import AutonomousAgent

agent = AutonomousAgent(
    model="anthropic/claude-sonnet-4-5",
    tools=[],
)
fallback = completion(model="bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0", messages=[])
