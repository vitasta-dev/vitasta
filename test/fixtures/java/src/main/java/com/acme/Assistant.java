package com.acme;

import com.anthropic.client.AnthropicClient;
import com.anthropic.client.okhttp.AnthropicOkHttpClient;
import com.anthropic.models.messages.Message;
import com.anthropic.models.messages.MessageCreateParams;
import com.anthropic.models.messages.Model;
import com.openai.client.OpenAIClient;
import com.openai.client.okhttp.OpenAIOkHttpClient;
import com.openai.models.ChatModel;
import com.openai.models.chat.completions.ChatCompletionCreateParams;
import java.net.URI;
import java.net.http.HttpRequest;
import software.amazon.awssdk.services.bedrockruntime.model.ConverseRequest;

public class Assistant {
    private static final String ANTHROPIC = "https://api.anthropic.com";
    private final AnthropicClient claude = AnthropicOkHttpClient.fromEnv();
    private final OpenAIClient openai = OpenAIOkHttpClient.builder().fromEnv().build();

    public Message ask(String q) {
        MessageCreateParams params = MessageCreateParams.builder()
            .model(Model.CLAUDE_3_5_SONNET_20241022)
            .maxTokens(1024)
            .temperature(0.2)
            .addUserMessage(q)
            .build();
        return claude.messages().create(params);
    }

    public Object chat(String q) {
        return openai.chat().completions().create(ChatCompletionCreateParams.builder()
            .model(ChatModel.GPT_4_1)
            .addUserMessage(q)
            .build());
    }

    public HttpRequest raw(String body) {
        return HttpRequest.newBuilder(URI.create(ANTHROPIC + "/v1/messages"))
            .header("anthropic-version", "2023-06-01")
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build();
    }

    public ConverseRequest bedrock() {
        return ConverseRequest.builder().modelId("us.anthropic.claude-sonnet-4-20250514-v1:0").build();
    }
}
