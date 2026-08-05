# Cross Review v2 - Token Streaming Smoke

Date: 30/04/2026, America/Sao_Paulo
Runtime under test: local `cross-review-v2` source, package version `2.2.0`

## Purpose

This report records a real provider token-streaming smoke test for
`cross-review-v2`. It verifies that the four peer adapters use provider-native
streaming APIs and emit session token-progress events.

No API key, prompt body or raw provider response text was printed or written to
this report.

## Command

```powershell
npm run api-streaming-smoke
```

## Result

The command completed successfully.

```json
{
  "ok": true,
  "streaming_tokens": true,
  "streaming_text": false,
  "results": [
    {
      "peer": "codex",
      "provider": "openai",
      "requested_model": "gpt-5.5",
      "reported_model": "gpt-5.5-2026-04-23",
      "status": "NEEDS_EVIDENCE",
      "decision_quality": "clean",
      "delta_events": 126,
      "streamed_chars": 681,
      "usage": {
        "input_tokens": 471,
        "output_tokens": 653,
        "total_tokens": 1124,
        "reasoning_tokens": 516
      }
    },
    {
      "peer": "claude",
      "provider": "anthropic",
      "requested_model": "claude-opus-4-7",
      "reported_model": "claude-opus-4-7",
      "status": "READY",
      "decision_quality": "clean",
      "delta_events": 14,
      "streamed_chars": 890,
      "usage": {
        "input_tokens": 1094,
        "output_tokens": 308,
        "total_tokens": 1402
      }
    },
    {
      "peer": "gemini",
      "provider": "google",
      "requested_model": "gemini-3.1-pro-preview",
      "reported_model": "gemini-3.1-pro-preview",
      "status": "READY",
      "decision_quality": "clean",
      "delta_events": 3,
      "streamed_chars": 282,
      "usage": {
        "input_tokens": 391,
        "output_tokens": 59,
        "total_tokens": 1182,
        "reasoning_tokens": 732
      }
    },
    {
      "peer": "deepseek",
      "provider": "deepseek",
      "requested_model": "deepseek-v4-pro",
      "reported_model": "deepseek-v4-pro",
      "status": "NEEDS_EVIDENCE",
      "decision_quality": "clean",
      "delta_events": 88,
      "streamed_chars": 430,
      "usage": {
        "input_tokens": 402,
        "output_tokens": 1561,
        "total_tokens": 1963,
        "reasoning_tokens": 1473
      }
    }
  ]
}
```

`NEEDS_EVIDENCE` in this smoke is not a failure. The prompt is intentionally
minimal and artificial; the release criterion here is that each adapter streams
provider output, emits token events, returns a parseable decision and reports
usage/model metadata without leaking sensitive data.

The default token-event mode records progress counts rather than raw provider
text. `CROSS_REVIEW_V2_STREAM_TEXT=1` is available only as a trusted local
diagnostic mode and still applies redaction before persistence.

## Release Implications

- `CROSS_REVIEW_V2_STREAM_TOKENS=1` is validated against real provider calls.
- `CROSS_REVIEW_V2_STREAM_TOKENS=0` was validated through `npm run
runtime-smoke`; `server_info.capabilities.token_streaming` and
  `runtime_capabilities.capabilities.token_streaming` both reported `false`.
- Token streaming is a real provider-output path, not simulated progress.
- Existing final-result parsing remains active after streamed text is
  accumulated.
- Stub regression coverage verifies that summed streamed character counts match
  the final parsed result text length.
- The event stream can be consumed by MCP hosts and future UI layers to show
  progress during slow reviews.
