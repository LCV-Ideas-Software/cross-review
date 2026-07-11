import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";
import { FileConfigSchema, flattenFileConfigToEnvMap } from "../src/core/file-config.js";
import type { PeerFailure, RuntimeEvent } from "../src/core/types.js";
import { AnthropicAdapter } from "../src/peers/anthropic.js";
import { DeepSeekAdapter } from "../src/peers/deepseek.js";
import { classifyProviderError } from "../src/peers/errors.js";
import { GeminiAdapter } from "../src/peers/gemini.js";
import { GrokAdapter } from "../src/peers/grok.js";
import { selectFromCandidates } from "../src/peers/model-selection.js";
import { OpenAIAdapter } from "../src/peers/openai.js";
import { PerplexityAdapter } from "../src/peers/perplexity.js";

process.env.CROSS_REVIEW_STUB = "1";
process.env.CROSS_REVIEW_STUB_CONFIRMED = "1";
process.env.PERPLEXITY_API_KEY = "test-perplexity-key";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
process.env.GROK_API_KEY = "test-grok-key";
process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.CROSS_REVIEW_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "cross-review-provider-refresh-"),
);

const config = loadConfig();

{
  const invalidUltra = FileConfigSchema.safeParse({
    reasoning_effort: { codex: "ultra" },
  });
  assert.equal(
    invalidUltra.success,
    false,
    "Codex product mode 'ultra' must not be misrepresented as a Responses API reasoning.effort value; central config must use 'max'.",
  );
  const apiMax = flattenFileConfigToEnvMap({ reasoning_effort: { codex: "max" } });
  assert.equal(apiMax.CROSS_REVIEW_OPENAI_REASONING_EFFORT, "max");
}

{
  const sol = selectFromCandidates("codex", [{ id: "gpt-5.6-sol", source: "api" }], "gpt-5.6-sol");
  assert.equal(sol.selected, "gpt-5.6-sol");
  assert.equal(sol.confidence, "verified");
}

{
  const adapter = new OpenAIAdapter({
    ...config,
    models: { ...config.models, codex: "gpt-5.6-sol" },
    reasoning_effort: { ...config.reasoning_effort, codex: "max" },
    streaming: { ...config.streaming, tokens: false },
  });
  let capturedPayload: Record<string, unknown> | undefined;
  (
    adapter as unknown as {
      client: () => Promise<{
        responses: {
          create: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
        };
      }>;
    }
  ).client = async () => ({
    responses: {
      create: async (payload) => {
        capturedPayload = payload;
        return {
          status: "completed",
          output_text: "revised fixture",
          model: "gpt-5.6-sol",
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_write_tokens: 60,
            input_tokens_details: { cached_tokens: 10 },
          },
        };
      },
    },
  });
  const generated = await adapter.generate("Revise this fixture.", {
    session_id: "550e8400-e29b-41d4-a716-446655440001",
    round: 1,
    task: "provider refresh smoke",
    emit: () => undefined,
  });
  assert.equal(
    generated.usage?.cache_write_tokens,
    60,
    "GPT-5.6 usage must preserve cache_write_tokens for accurate 1.25x cache-write billing.",
  );
  assert.equal(
    generated.usage?.input_tokens,
    30,
    "Canonical input_tokens must exclude cache reads/writes so cost accounting does not bill them twice.",
  );
  assert.deepEqual(
    capturedPayload?.reasoning,
    { effort: "max" },
    "GPT-5.6 Sol must preserve Responses API reasoning.effort=max instead of downgrading it to xhigh.",
  );
  assert.deepEqual(
    capturedPayload?.prompt_cache_options,
    { mode: "implicit", ttl: "30m" },
    "GPT-5.6 Sol must use the current prompt_cache_options contract.",
  );
  assert.equal(
    Object.hasOwn(capturedPayload ?? {}, "prompt_cache_retention"),
    false,
    "GPT-5.6 Sol must not send the retired prompt_cache_retention field.",
  );
}

{
  const adapter = new DeepSeekAdapter({
    ...config,
    reasoning_effort: { ...config.reasoning_effort, deepseek: "max" },
    streaming: { ...config.streaming, tokens: false },
  });
  let capturedPayload: Record<string, unknown> | undefined;
  (
    adapter as unknown as {
      client: () => Promise<{
        chat: {
          completions: {
            create: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
          };
        };
      }>;
    }
  ).client = async () => ({
    chat: {
      completions: {
        create: async (payload) => {
          capturedPayload = payload;
          return {
            choices: [{ finish_reason: "stop", message: { content: "revised fixture" } }],
            model: "deepseek-v4-pro",
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
              prompt_cache_hit_tokens: 40,
              prompt_cache_miss_tokens: 60,
            },
          };
        },
      },
    },
  });
  const generated = await adapter.generate("Revise this fixture.", {
    session_id: "550e8400-e29b-41d4-a716-446655440002",
    round: 1,
    task: "provider refresh smoke",
    emit: () => undefined,
  });
  assert.deepEqual(capturedPayload?.thinking, { type: "enabled" });
  assert.equal(
    capturedPayload?.reasoning_effort,
    "max",
    "DeepSeek V4 Pro requires reasoning_effort at the top level, not nested inside thinking.",
  );
  assert.equal(generated.usage?.input_tokens, 0);
  assert.equal(generated.usage?.cache_read_tokens, 40);
  assert.equal(generated.usage?.cache_write_tokens, 60);
}

{
  const grok = selectFromCandidates("grok", [{ id: "grok-4.5", source: "api" }], "grok-4.5");
  assert.equal(grok.selected, "grok-4.5");
  assert.equal(grok.confidence, "verified");

  const adapter = new GrokAdapter({
    ...config,
    models: { ...config.models, grok: "grok-4.5" },
    reasoning_effort: { ...config.reasoning_effort, grok: "xhigh" },
    streaming: { ...config.streaming, tokens: false },
  });
  let capturedPayload: Record<string, unknown> | undefined;
  (
    adapter as unknown as {
      client: () => Promise<{
        responses: {
          create: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
        };
      }>;
    }
  ).client = async () => ({
    responses: {
      create: async (payload) => {
        capturedPayload = payload;
        return {
          status: "completed",
          output_text: "revised fixture",
          model: "grok-4.5",
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            input_tokens_details: { cached_tokens: 40 },
          },
        };
      },
    },
  });
  const generated = await adapter.generate("Revise this fixture.", {
    session_id: "550e8400-e29b-41d4-a716-446655440003",
    round: 1,
    task: "provider refresh smoke",
    emit: () => undefined,
  });
  assert.deepEqual(
    capturedPayload?.reasoning,
    { effort: "high" },
    "Grok 4.5 accepts low|medium|high; internal xhigh/max must clamp to high.",
  );
  assert.equal(
    Object.hasOwn(capturedPayload ?? {}, "prompt_cache_retention"),
    false,
    "Grok 4.5 must not receive OpenAI-only prompt_cache_retention.",
  );
  assert.equal(capturedPayload?.prompt_cache_key !== undefined, true);
  assert.equal(generated.usage?.input_tokens, 60);
  assert.equal(generated.usage?.cache_read_tokens, 40);
}

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
    [{ id: "claude-fable-5", source: "api" }],
    "claude-fable-5",
  );
  assert.equal(claude.selected, "claude-fable-5");
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
  const adapter = new AnthropicAdapter({
    ...config,
    models: { ...config.models, claude: "claude-fable-5" },
    reasoning_effort: { ...config.reasoning_effort, claude: "max" },
    streaming: { ...config.streaming, tokens: false },
  });
  let capturedPayload: Record<string, unknown> | undefined;
  (
    adapter as unknown as {
      client: () => Promise<{
        messages: {
          create: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
        };
      }>;
    }
  ).client = async () => ({
    messages: {
      create: async (payload) => {
        capturedPayload = payload;
        return {
          content: [{ type: "text", text: "revised fixture" }],
          model: "claude-fable-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 20 },
        };
      },
    },
  });
  await adapter.generate("Revise this fixture.", {
    session_id: "550e8400-e29b-41d4-a716-446655440004",
    round: 1,
    task: "provider refresh smoke",
    emit: () => undefined,
  });
  assert.equal(
    Object.hasOwn(capturedPayload ?? {}, "thinking"),
    false,
    "Claude Fable 5 adaptive thinking is always on; the migration contract omits thinking.",
  );
  assert.deepEqual(capturedPayload?.output_config, { effort: "max" });
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
  const adapter = new GeminiAdapter({
    ...config,
    streaming: { ...config.streaming, tokens: false },
  });
  (
    adapter as unknown as {
      client: () => Promise<{
        ThinkingLevel: { HIGH: string };
        ai: {
          models: {
            generateContent: () => Promise<Record<string, unknown>>;
          };
        };
      }>;
    }
  ).client = async () => ({
    ThinkingLevel: { HIGH: "HIGH" },
    ai: {
      models: {
        generateContent: async () => ({
          text: "revised fixture",
          modelVersion: "gemini-3.1-pro-preview",
          candidates: [{ finishReason: "STOP" }],
          usageMetadata: {
            promptTokenCount: 100,
            cachedContentTokenCount: 40,
            candidatesTokenCount: 20,
            totalTokenCount: 120,
          },
        }),
      },
    },
  });
  const generated = await adapter.generate("Revise this fixture.", {
    session_id: "550e8400-e29b-41d4-a716-446655440005",
    round: 1,
    task: "provider refresh smoke",
    emit: () => undefined,
  });
  assert.equal(
    generated.usage?.input_tokens,
    60,
    "Gemini promptTokenCount includes cachedContentTokenCount; canonical fresh input must exclude cache reads.",
  );
  assert.equal(generated.usage?.cache_read_tokens, 40);
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
  const configSource = fs.readFileSync("src/core/config.ts", "utf8");
  const modelSelectionSource = fs.readFileSync("src/peers/model-selection.ts", "utf8");
  assert.ok(configSource.includes('codex: envValue("CROSS_REVIEW_OPENAI_MODEL") || "gpt-5.6-sol"'));
  assert.ok(
    configSource.includes('claude: envValue("CROSS_REVIEW_ANTHROPIC_MODEL") || "claude-fable-5"'),
  );
  assert.ok(
    configSource.includes(
      'gemini: envValue("CROSS_REVIEW_GEMINI_MODEL") || "gemini-3.1-pro-preview"',
    ),
  );
  assert.ok(configSource.includes('grok: envValue("CROSS_REVIEW_GROK_MODEL") || "grok-4.5"'));
  assert.ok(
    configSource.includes('codex: reasoningEffort("CROSS_REVIEW_OPENAI_REASONING_EFFORT", "max")'),
  );
  assert.ok(
    configSource.includes(
      'claude: reasoningEffort("CROSS_REVIEW_ANTHROPIC_REASONING_EFFORT", "max")',
    ),
  );
  assert.ok(
    configSource.includes('grok: reasoningEffort("CROSS_REVIEW_GROK_REASONING_EFFORT", "high")'),
  );
  assert.ok(modelSelectionSource.includes('codex: ["gpt-5.6-sol"]'));
  assert.ok(modelSelectionSource.includes('claude: ["claude-fable-5"]'));
  assert.ok(modelSelectionSource.includes('gemini: ["gemini-3.1-pro-preview"]'));
  assert.ok(modelSelectionSource.includes('grok: ["grok-4.5"]'));
}

console.log("[provider-refresh-smoke] PASS");
