import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";
import type { PeerFailure, RuntimeEvent } from "../src/core/types.js";
import { AnthropicAdapter } from "../src/peers/anthropic.js";
import { classifyProviderError } from "../src/peers/errors.js";
import { selectFromCandidates } from "../src/peers/model-selection.js";
import { PerplexityAdapter } from "../src/peers/perplexity.js";

process.env.CROSS_REVIEW_STUB = "1";
process.env.CROSS_REVIEW_STUB_CONFIRMED = "1";
process.env.PERPLEXITY_API_KEY = "test-perplexity-key";
process.env.CROSS_REVIEW_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "cross-review-provider-refresh-"),
);

const config = loadConfig();

{
  const adapter = new PerplexityAdapter(config);
  let capturedPayload:
    | { max_tokens?: number; disable_search?: boolean; messages?: Array<{ content?: string }> }
    | undefined;
  (
    adapter as unknown as {
      client: () => Promise<{
        chat: {
          completions: {
            create: (payload: {
              max_tokens?: number;
              disable_search?: boolean;
              messages?: Array<{ content?: string }>;
            }) => Promise<void>;
          };
        };
      }>;
    }
  ).client = async () => ({
    chat: {
      completions: {
        create: async (payload) => {
          capturedPayload = payload;
        },
      },
    },
  });

  const probe = await adapter.probe();
  assert.equal(probe.available, true);
  assert.equal(
    capturedPayload,
    undefined,
    "Perplexity default probe_mode=auth_only must not spend tokens.",
  );
  assert.match(
    probe.message ?? "",
    /probe_mode=auth_only/,
    "Perplexity auth-only probe should be explicit in the probe result message.",
  );
}

{
  const adapter = new PerplexityAdapter({
    ...config,
    perplexity: { ...config.perplexity, probe_mode: "live" },
  });
  let capturedPayload:
    | { max_tokens?: number; disable_search?: boolean; messages?: Array<{ content?: string }> }
    | undefined;
  (
    adapter as unknown as {
      client: () => Promise<{
        chat: {
          completions: {
            create: (payload: {
              max_tokens?: number;
              disable_search?: boolean;
              messages?: Array<{ content?: string }>;
            }) => Promise<void>;
          };
        };
      }>;
    }
  ).client = async () => ({
    chat: {
      completions: {
        create: async (payload) => {
          capturedPayload = payload;
        },
      },
    },
  });

  const probe = await adapter.probe();
  assert.equal(probe.available, true);
  assert.equal(capturedPayload?.disable_search, true);
  assert.ok(
    typeof capturedPayload?.max_tokens === "number" && capturedPayload.max_tokens >= 16,
    "Perplexity probe must request at least 16 max_tokens for sonar-reasoning-pro.",
  );
  assert.equal(
    capturedPayload?.max_tokens,
    16,
    "Perplexity probe should keep token exposure at the provider minimum.",
  );
  assert.equal(
    capturedPayload?.messages?.[0]?.content,
    ".",
    "Perplexity probe should use the smallest non-empty prompt body.",
  );
}

{
  const claude = selectFromCandidates(
    "claude",
    [{ id: "claude-opus-4-8", source: "api" }],
    "claude-opus-4-8",
  );
  assert.equal(claude.selected, "claude-opus-4-8");
  assert.equal(claude.confidence, "verified");
}

{
  const fable = selectFromCandidates(
    "claude",
    [
      { id: "claude-opus-4-8", source: "api" },
      { id: "claude-fable-5", source: "api" },
    ],
    "claude-fable-5",
  );
  assert.equal(fable.selected, "claude-fable-5");
  assert.equal(
    fable.confidence,
    "verified",
    "Claude Fable 5 must remain selected when the operator pinned it and the provider API lists both Fable and the canonical Opus pin.",
  );
}

{
  const unavailableFable = selectFromCandidates(
    "claude",
    [{ id: "claude-opus-4-8", source: "api" }],
    "claude-fable-5",
  );
  assert.equal(unavailableFable.selected, "claude-fable-5");
  assert.equal(
    unavailableFable.confidence,
    "unknown",
    "A missing operator-selected Fable pin must fail visibly instead of silently downgrading to Opus.",
  );
}

{
  const refusal = Object.assign(new Error("Claude Fable 5 refused the request."), {
    code: "anthropic_refusal",
    stop_reason: "refusal",
    stop_details: { type: "refusal", category: "cyber", explanation: "fixture" },
    billed: false,
  });
  const failure = classifyProviderError(
    "claude",
    "anthropic",
    "claude-fable-5",
    refusal,
    1,
    Date.now(),
  );
  assert.equal(failure.failure_class, "provider_refusal");
  assert.equal(failure.retryable, false);
  assert.equal(failure.recovery_hint, "reformulate_and_retry");
}

{
  const attachedFailure: PeerFailure = {
    peer: "claude",
    provider: "anthropic",
    model: "claude-fable-5",
    failure_class: "timeout",
    message: "Preserved retry metadata from the retry layer.",
    retryable: true,
    attempts: 3,
    latency_ms: 1234,
  };
  const error = new Error("Raw provider message without timeout signal.");
  Object.defineProperty(error, "peerFailure", {
    value: attachedFailure,
    enumerable: false,
    configurable: true,
  });
  const failure = classifyProviderError(
    "claude",
    "anthropic",
    "claude-fable-5",
    error,
    1,
    Date.now(),
  );
  assert.equal(
    failure,
    attachedFailure,
    "Provider error classification must preserve PeerFailure metadata attached by retry exhaustion.",
  );
}

{
  const adapter = new AnthropicAdapter({
    ...config,
    models: { ...config.models, claude: "claude-fable-5" },
    cost_rates: {
      ...config.cost_rates,
      claude: {
        input_per_million: 10,
        output_per_million: 50,
        cache_read_per_million: 1,
        cache_write_per_million: 20,
      },
    },
  });
  (
    adapter as unknown as {
      client: () => Promise<{
        messages: {
          create: () => Promise<{
            content: unknown[];
            model: string;
            stop_reason: string;
            stop_details: { type: string; category: string; explanation: string };
            usage: { input_tokens: number; output_tokens: number };
          }>;
        };
      }>;
    }
  ).client = async () => ({
    messages: {
      create: async () => ({
        content: [],
        model: "claude-fable-5",
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "cyber", explanation: "fixture" },
        usage: { input_tokens: 412, output_tokens: 0 },
      }),
    },
  });
  const events: RuntimeEvent[] = [];
  await assert.rejects(
    () =>
      adapter.call("Review this fixture.", {
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        round: 1,
        task: "provider refresh smoke",
        emit: (event) => events.push(event),
      }),
    /Claude Fable 5 refusal/,
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "provider.refusal" &&
        event.peer === "claude" &&
        event.data?.model === "claude-fable-5" &&
        event.data?.billed === false,
    ),
    "Anthropic Fable refusal must emit a structured provider.refusal event with billed=false.",
  );
}

{
  const gemini = selectFromCandidates(
    "gemini",
    [{ id: "gemini-3.1-pro-preview", source: "api" }],
    "gemini-3.1-pro-preview",
  );
  assert.equal(gemini.selected, "gemini-3.1-pro-preview");
  assert.equal(gemini.confidence, "verified");
}

{
  const grok = selectFromCandidates("grok", [{ id: "grok-4.3", source: "api" }], "grok-4.3");
  assert.equal(grok.selected, "grok-4.3");
  assert.equal(grok.confidence, "verified");
}

{
  const configSource = fs.readFileSync("src/core/config.ts", "utf8");
  const modelSelectionSource = fs.readFileSync("src/peers/model-selection.ts", "utf8");
  assert.ok(
    configSource.includes('claude: envValue("CROSS_REVIEW_ANTHROPIC_MODEL") || "claude-opus-4-8"'),
  );
  assert.ok(
    configSource.includes(
      'gemini: envValue("CROSS_REVIEW_GEMINI_MODEL") || "gemini-3.1-pro-preview"',
    ),
  );
  assert.ok(configSource.includes('grok: envValue("CROSS_REVIEW_GROK_MODEL") || "grok-4.3"'));
  assert.ok(modelSelectionSource.includes('claude: ["claude-opus-4-8"]'));
  assert.ok(modelSelectionSource.includes('gemini: ["gemini-3.1-pro-preview"]'));
  assert.ok(modelSelectionSource.includes('grok: ["grok-4.3"]'));
}

console.log("[provider-refresh-smoke] PASS");
