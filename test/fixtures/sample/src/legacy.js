const { Configuration, OpenAIApi } = require("openai");

const openai = new OpenAIApi(new Configuration({ apiKey: process.env.KEY }));

async function run() {
  return openai.createChatCompletion({ model: "gpt-3.5-turbo", messages: [] });
}

module.exports = { run };
