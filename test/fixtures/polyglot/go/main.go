package main

// "claude-3-opus-20240229" in a comment must not count
const DefaultModel = "claude-3-opus-20240229"

func main() {
	req, _ := http.NewRequest(http.MethodPost, "https://api.anthropic.com/v1/messages", nil)
	req.Header.Set("anthropic-version", "2023-06-01")
	params := Params{Model: "claude-sonnet-4-20250514", MaxTokens: 10}
	label := "gpt-4o"
	_ = params; _ = label
}
