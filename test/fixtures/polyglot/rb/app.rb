client = OpenAI::Client.new
client.chat(parameters: { model: "gpt-4-0613", messages: [] })
MODELS = ["gpt-3.5-turbo", "gpt-4o"]
puts "use gpt-4 for this"
SUPPORTED_MODELS = [
  "claude-3-haiku-20240307",
  "claude-sonnet-5-5",
]
