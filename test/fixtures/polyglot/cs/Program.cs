using OpenAI.Chat;
var client = new ChatClient(model: "gpt-4-turbo", apiKey: key);
var other = openAi.GetChatClient("gpt-4o-mini");
string greeting = "hello gpt-4o";
