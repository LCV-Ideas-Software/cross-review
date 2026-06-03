# API Keys

All runtime credentials must come from Windows environment variables.

## Required Variables

```powershell
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "<OPENAI_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "<ANTHROPIC_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("GEMINI_API_KEY", "<GEMINI_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", "<DEEPSEEK_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("GROK_API_KEY", "<GROK_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("PERPLEXITY_API_KEY", "<PERPLEXITY_API_KEY>", "User")
```

Restart any terminal, editor, app or MCP host after changing these variables.

## Optional Model Overrides

Use overrides only when you intentionally want to pin a model rather than use automatic best-model selection.

```powershell
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_MODEL", "gpt-5.5", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_REASONING_EFFORT", "xhigh", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_MODEL", "claude-opus-4-8", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_REASONING_EFFORT", "xhigh", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GEMINI_MODEL", "gemini-2.5-pro", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_DEEPSEEK_MODEL", "deepseek-v4-pro", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_DEEPSEEK_REASONING_EFFORT", "max", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GROK_MODEL", "grok-4.3", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PERPLEXITY_MODEL", "sonar-reasoning-pro", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PERPLEXITY_REASONING_EFFORT", "high", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PERPLEXITY_SEARCH_CONTEXT_SIZE", "low", "User")
```

## Safety

- Do not create `.env` files containing real secrets.
- Do not paste keys into prompts, issues, logs, screenshots or README files.
- If a key is accidentally committed, revoke it immediately and rotate it at the provider.
