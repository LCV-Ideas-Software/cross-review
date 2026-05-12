import type { AppConfig, PeerAdapter, PeerId } from "../core/types.js";
import { PEERS } from "../core/types.js";
import { AnthropicAdapter } from "./anthropic.js";
import { DeepSeekAdapter } from "./deepseek.js";
import { GeminiAdapter } from "./gemini.js";
import { GrokAdapter } from "./grok.js";
import { OpenAIAdapter } from "./openai.js";
import { PerplexityAdapter } from "./perplexity.js";
import { StubAdapter } from "./stub.js";

// v2.4.0 / audit closure (P1.1) — refined after cross-review-v2 R1 (gemini
// caught a financial-safety regression in the initial fallback design).
//
// Pre-v2.4.0 a single env var (CROSS_REVIEW_V2_STUB=1) replaced every
// real provider adapter with a stub that returned synthetic READY
// verdicts at $0 cost — so a stray dotenv or CI variable could silently
// invalidate a cross-review used as a pre-commit gate.
//
// Initial v2.4.0 attempt: when the flag was set without confirmation, the
// boot path emitted a notice and FELL BACK to real adapters. R1 (gemini)
// caught the financial-safety regression: an operator who deliberately
// set CROSS_REVIEW_V2_STUB=1 to avoid paid calls (local dev, CI offline,
// budget kill) would now BE BILLED for real provider calls instead. The
// silent fallback violates explicit operator intent.
//
// Final v2.4.0 contract: the flag and the confirmation are paired
// — set both together or neither. If the flag is set without
// confirmation we FAIL FAST with a clear error so the operator must
// either (a) opt in deliberately to stubs by adding the confirmation,
// or (b) unset the stub flag if real adapters are intended. This
// preserves the original financial safety net that flag-only operators
// were depending on without re-introducing the silent-stub-in-prod risk.
function stubsAreSafelyEnabled(config: AppConfig): boolean {
  if (!config.stub) return false;
  const confirmed =
    process.env.NODE_ENV === "test" ||
    /^(1|true|yes|on)$/i.test(process.env.CROSS_REVIEW_V2_STUB_CONFIRMED ?? "");
  if (!confirmed) {
    throw new Error(
      "CROSS_REVIEW_V2_STUB=1 is set but stub activation is NOT confirmed. " +
        "Stubs would invalidate real cross-review decisions; falling back to real adapters " +
        "would charge for paid provider calls against your explicit STUB intent. " +
        "To deliberately enable stubs, also set NODE_ENV=test OR " +
        "CROSS_REVIEW_V2_STUB_CONFIRMED=1 in the same environment. " +
        "To deliberately use real adapters, unset CROSS_REVIEW_V2_STUB.",
    );
  }
  process.stderr.write(
    "[cross-review-v2] notice: stub adapters ACTIVE — every peer call returns synthetic data. " +
      "Do NOT use this configuration to gate real cross-review decisions.\n",
  );
  return true;
}

export function createAdapters(
  config: AppConfig,
  modelOverrides: Partial<Record<PeerId, string>> = {},
): Record<PeerId, PeerAdapter> {
  if (stubsAreSafelyEnabled(config)) {
    return {
      codex: new StubAdapter(config, "codex", modelOverrides.codex),
      claude: new StubAdapter(config, "claude", modelOverrides.claude),
      gemini: new StubAdapter(config, "gemini", modelOverrides.gemini),
      deepseek: new StubAdapter(config, "deepseek", modelOverrides.deepseek),
      // v2.14.0: Grok stub for offline / CI / budget-kill smoke runs.
      grok: new StubAdapter(config, "grok", modelOverrides.grok),
      // v3.0.0: Perplexity stub for offline / CI / budget-kill smoke runs.
      perplexity: new StubAdapter(config, "perplexity", modelOverrides.perplexity),
    };
  }

  return {
    codex: new OpenAIAdapter(config, modelOverrides.codex),
    claude: new AnthropicAdapter(config, modelOverrides.claude),
    gemini: new GeminiAdapter(config, modelOverrides.gemini),
    deepseek: new DeepSeekAdapter(config, modelOverrides.deepseek),
    // v2.14.0: Grok via xAI's OpenAI-Responses-API surface.
    grok: new GrokAdapter(config, modelOverrides.grok),
    // v3.0.0: Perplexity via Sonar API at https://api.perplexity.ai
    // (OpenAI-Chat-Completions compatible; uses the shared
    // loadOpenAICtor helper from peers/openai.ts).
    perplexity: new PerplexityAdapter(config, modelOverrides.perplexity),
  };
}

export function selectAdapters(
  adapters: Record<PeerId, PeerAdapter>,
  peers: PeerId[] = [...PEERS],
): PeerAdapter[] {
  return peers.map((peer) => adapters[peer]);
}
