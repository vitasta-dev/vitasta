package config

type ProvidersConfig struct {
	OpenRouter ProviderConfig `mapstructure:"openrouter"`
}

func DefaultConfig() *Config {
	return &Config{Defaults: AgentDefaults{Model: "anthropic/claude-sonnet-4-5"}}
}
