from mistralai import Mistral
from slack_sdk import WebClient

client = Mistral(api_key="x")
slack = WebClient(token="y")


def summarise(text):
    r = client.chat.complete(model="mistral-medium-3-5", messages=[{"role": "user", "content": text}])
    slack.chat_postMessage(channel="#general", text=r.choices[0].message.content)
    slack.files_upload(channels="#general", file="out.txt")
