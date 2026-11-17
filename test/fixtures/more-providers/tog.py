from together import Together
client = Together()
r = client.chat.completions.create(model="MiniMaxAI/MiniMax-M3", messages=[])
