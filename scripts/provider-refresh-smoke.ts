import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";
import { FileConfigSchema, flattenFileConfigToEnvMap } from "../src/core/file-config.js";
import type { PeerFailure, ReasoningEffort, RuntimeEvent } from "../src/core/types.js";
import { AnthropicAdapter, anthropicCacheMinTokens } from "../src/peers/anthropic.js";
import { DeepSeekAdapter } from "../src/peers/deepseek.js";
import { classifyProviderError } from "../src/peers/errors.js";
import {
  __geminiExplicitCacheIndexForTests,
  __resetGeminiExplicitCacheIndexForTests,
  __seedGeminiExplicitCacheIndexForTests,
  GEMINI_EXPLICIT_CACHE_MIN_TOKENS,
  GeminiAdapter,
} from "../src/peers/gemini.js";
import { GrokAdapter } from "../src/peers/grok.js";
import { selectFromCandidates } from "../src/peers/model-selection.js";
import { OpenAIAdapter } from "../src/peers/openai.js";
import { clampEffortForPerplexity, PerplexityAdapter } from "../src/peers/perplexity.js";

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

const OPENAI_READY = JSON.stringify({
  status: "READY",
  summary: "No blocking objections remain.",
  confidence: "inferred",
  evidence_sources: [],
  caller_requests: [],
  follow_ups: [],
});

async function captureOpenAIReasoningEffort(
  model: string,
  effort: ReasoningEffort,
  operation: "call" | "generate" = "generate",
): Promise<unknown> {
  const adapter = new OpenAIAdapter({
    ...config,
    models: { ...config.models, codex: model },
    reasoning_effort: { ...config.reasoning_effort, codex: effort },
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
          output_text: operation === "call" ? OPENAI_READY : "revised fixture",
          model,
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        };
      },
    },
  });
  const context = {
    session_id: "550e8400-e29b-41d4-a716-446655440011",
    round: 1,
    task: "OpenAI reasoning-effort family matrix",
    emit: () => undefined,
  };
  if (operation === "call") await adapter.call("Review this fixture.", context);
  else await adapter.generate("Revise this fixture.", context);
  return (capturedPayload?.reasoning as { effort?: unknown } | undefined)?.effort;
}

async function captureGrokReasoningEffort(
  model: string,
  effort: ReasoningEffort,
  operation: "call" | "generate",
): Promise<unknown> {
  const adapter = new GrokAdapter({
    ...config,
    models: { ...config.models, grok: model },
    reasoning_effort: { ...config.reasoning_effort, grok: effort },
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
          output_text: operation === "call" ? OPENAI_READY : "revised fixture",
          model,
        };
      },
    },
  });
  const context = {
    session_id: "550e8400-e29b-41d4-a716-446655440013",
    round: 1,
    task: "Grok reasoning-effort family matrix",
    emit: () => undefined,
  };
  if (operation === "call") await adapter.call("Review this fixture.", context);
  else await adapter.generate("Revise this fixture.", context);
  return (capturedPayload?.reasoning as { effort?: unknown } | undefined)?.effort;
}

{
  const sharedEfforts: ReasoningEffort[] = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ];
  const familyMatrix: Array<{
    models: string[];
    expected: Record<ReasoningEffort, string>;
  }> = [
    {
      models: ["gpt-5.6-sol"],
      expected: {
        none: "none",
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
        ultra: "max",
      },
    },
    {
      models: ["gpt-5.5", "gpt-5.4", "gpt-5.2"],
      expected: {
        none: "none",
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "xhigh",
        ultra: "xhigh",
      },
    },
    {
      models: ["gpt-5.1"],
      expected: {
        none: "none",
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "high",
        max: "high",
        ultra: "high",
      },
    },
    {
      models: ["gpt-5"],
      expected: {
        none: "minimal",
        minimal: "minimal",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "high",
        max: "high",
        ultra: "high",
      },
    },
  ];

  for (const family of familyMatrix) {
    for (const model of family.models) {
      for (const effort of sharedEfforts) {
        assert.equal(
          await captureOpenAIReasoningEffort(model, effort),
          family.expected[effort],
          `${model} must normalize shared reasoning effort ${effort} to ${family.expected[effort]}.`,
        );
      }
    }
  }

  assert.equal(
    await captureOpenAIReasoningEffort("gpt-5", "none", "call"),
    "minimal",
    "The review-call payload must use the same GPT-5 family normalization as generation.",
  );
}

{
  const compatibleUltra = FileConfigSchema.safeParse({
    reasoning_effort: { codex: "ultra" },
  });
  assert.equal(
    compatibleUltra.success,
    true,
    "Central config must accept the operator-facing ultra compatibility alias.",
  );
  const aliasEnv = flattenFileConfigToEnvMap({ reasoning_effort: { codex: "ultra" } });
  assert.equal(aliasEnv.CROSS_REVIEW_OPENAI_REASONING_EFFORT, "ultra");

  const priorEffort = process.env.CROSS_REVIEW_OPENAI_REASONING_EFFORT;
  process.env.CROSS_REVIEW_OPENAI_REASONING_EFFORT = "ultra";
  try {
    assert.equal(
      loadConfig().reasoning_effort.codex,
      "ultra",
      "Environment loading must preserve ultra until the selected adapter normalizes it.",
    );
  } finally {
    if (priorEffort === undefined) delete process.env.CROSS_REVIEW_OPENAI_REASONING_EFFORT;
    else process.env.CROSS_REVIEW_OPENAI_REASONING_EFFORT = priorEffort;
  }
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
    reasoning_effort: { ...config.reasoning_effort, codex: "ultra" },
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
    "GPT-5.6 Sol must normalize ultra to the official Responses API reasoning.effort=max value.",
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

  await adapter.generate("Revise this fixture with minimal internal effort.", {
    session_id: "550e8400-e29b-41d4-a716-446655440001",
    round: 1,
    task: "provider refresh smoke",
    reasoning_effort_override: "minimal",
    emit: () => undefined,
  });
  assert.deepEqual(
    capturedPayload?.reasoning,
    { effort: "low" },
    "GPT-5.6 Sol must normalize the shared minimal setting to its lowest active API effort, low.",
  );
}

{
  const adapter = new DeepSeekAdapter({
    ...config,
    reasoning_effort: { ...config.reasoning_effort, deepseek: "ultra" },
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
  const grok = selectFromCandidates("grok", [{ id: "grok-4.6", source: "api" }], "grok-4.6");
  assert.equal(grok.selected, "grok-4.6");
  assert.equal(grok.confidence, "verified");

  const adapter = new GrokAdapter({
    ...config,
    models: { ...config.models, grok: "grok-4.6" },
    reasoning_effort: { ...config.reasoning_effort, grok: "ultra" },
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
          model: "grok-4.6",
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
    { effort: "xhigh" },
    "Grok 4.6 accepts low|medium|high|xhigh; the ultra alias must normalize to xhigh.",
  );
  assert.equal(
    Object.hasOwn(capturedPayload ?? {}, "prompt_cache_retention"),
    false,
    "Grok 4.6 must not receive OpenAI-only prompt_cache_retention.",
  );
  assert.equal(capturedPayload?.prompt_cache_key !== undefined, true);
  assert.equal(generated.usage?.input_tokens, 60);
  assert.equal(generated.usage?.cache_read_tokens, 40);
}

{
  const sharedEfforts: ReasoningEffort[] = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ];
  const familyMatrix: Array<{
    model: string;
    expected: Record<ReasoningEffort, string>;
  }> = [
    {
      model: "grok-4.6",
      expected: {
        none: "low",
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "xhigh",
        ultra: "xhigh",
      },
    },
    {
      model: "grok-4.5",
      expected: {
        none: "low",
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "high",
        max: "high",
        ultra: "high",
      },
    },
    {
      model: "grok-4.3",
      expected: {
        none: "none",
        minimal: "high",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "high",
        max: "high",
        ultra: "high",
      },
    },
    {
      model: "grok-4.20-multi-agent",
      expected: {
        none: "low",
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "xhigh",
        ultra: "xhigh",
      },
    },
  ];
  for (const family of familyMatrix) {
    for (const effort of sharedEfforts) {
      for (const operation of ["call", "generate"] as const) {
        assert.equal(
          await captureGrokReasoningEffort(family.model, effort, operation),
          family.expected[effort],
          `${family.model} ${operation} must normalize ${effort} to ${family.expected[effort]}.`,
        );
      }
    }
  }
}

type PerplexityProbePayload = {
  model?: string;
  max_output_tokens?: number;
  tools?: unknown;
  input?: unknown;
  reasoning?: { effort?: string };
};

function capturePerplexityProbe(
  adapter: PerplexityAdapter,
  response: Record<string, unknown> = {
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
  },
): () => PerplexityProbePayload | undefined {
  let capturedPayload: PerplexityProbePayload | undefined;
  (
    adapter as unknown as {
      client: () => Promise<{
        responses: {
          create: (payload: PerplexityProbePayload) => Promise<Record<string, unknown>>;
        };
      }>;
    }
  ).client = async () => ({
    responses: {
      create: async (payload) => {
        capturedPayload = payload;
        return response;
      },
    },
  });
  return () => capturedPayload;
}

{
  const adapter = new PerplexityAdapter(config);
  const captured = capturePerplexityProbe(adapter);

  const probe = await adapter.probe();
  assert.equal(probe.available, true);
  assert.equal(
    captured(),
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
  const captured = capturePerplexityProbe(adapter);

  const probe = await adapter.probe();
  assert.equal(probe.available, true);
  assert.equal(
    Object.hasOwn(captured() ?? {}, "tools"),
    false,
    "Perplexity live probe must not declare the web_search tool (no search fee).",
  );
  assert.equal(
    captured()?.max_output_tokens,
    16,
    "Perplexity probe should keep token exposure at the provider minimum.",
  );
  assert.equal(
    captured()?.input,
    ".",
    "Perplexity probe should use the smallest non-empty prompt body.",
  );
  assert.deepEqual(captured()?.reasoning, { effort: "minimal" });
}

{
  // v4.6.0 (Codex review of PR #234): a live probe must not report a
  // failed or cancelled Responses terminal as a healthy model.
  for (const terminal of [
    { status: "failed", error: { message: "model overloaded" } },
    { status: "cancelled" },
    { status: "queued" },
    {},
  ] as Array<Record<string, unknown>>) {
    const adapter = new PerplexityAdapter({
      ...config,
      perplexity: { ...config.perplexity, probe_mode: "live" },
    });
    capturePerplexityProbe(adapter, terminal);
    const probe = await adapter.probe();
    assert.equal(probe.available, false, `status=${String(terminal.status)} must be rejected`);
    assert.match(probe.message ?? "", /perplexity_probe_terminal_rejected/);
    if ("error" in terminal) assert.match(probe.message ?? "", /model overloaded/);
  }
  const completedAdapter = new PerplexityAdapter({
    ...config,
    perplexity: { ...config.perplexity, probe_mode: "live" },
  });
  capturePerplexityProbe(completedAdapter, { status: "completed" });
  assert.equal((await completedAdapter.probe()).available, true);
}

{
  // Codex review of PR #234: the core tolerates a `models/` prefix, so the
  // adapter must strip it before dispatch instead of sending it verbatim.
  const adapter = new PerplexityAdapter(
    { ...config, perplexity: { ...config.perplexity, probe_mode: "live" } },
    "models/perplexity/kimi-k3",
  );
  const captured = capturePerplexityProbe(adapter);
  assert.equal(adapter.model, "perplexity/kimi-k3");
  assert.equal((await adapter.probe()).available, true);
  assert.equal(captured()?.model, "perplexity/kimi-k3", "the wire id must not carry models/");
}

{
  // v4.6.0: legacy Sonar ids belong to the retiring Chat Completions API.
  // The probe reports the migration cause instead of dispatching.
  const adapter = new PerplexityAdapter(
    { ...config, perplexity: { ...config.perplexity, probe_mode: "live" } },
    "sonar-reasoning-pro",
  );
  const captured = capturePerplexityProbe(adapter);
  const probe = await adapter.probe();
  assert.equal(probe.available, false);
  assert.match(probe.message ?? "", /perplexity_model_unsupported/);
  assert.match(probe.message ?? "", /perplexity\/kimi-k3/);
  assert.equal(captured(), undefined, "a retired Sonar id must never reach the wire.");
}

// v4.7.0 (CROSREV-6): Gemini explicit context cache — opt-in, review-only.
{
  const READY_JSON = JSON.stringify({
    status: "READY",
    summary: "fixture",
    blocking_issues: [],
    evidence_sources: [],
  });
  const geminiCacheConfig = {
    ...config,
    streaming: { ...config.streaming, tokens: false },
    cache: {
      ...config.cache,
      enabled: true,
      gemini_explicit: true,
      ttl: { ...config.cache.ttl, gemini: "1h" as const },
      disable_per_peer: { ...config.cache.disable_per_peer, gemini: false },
    },
    // Storage rate so the ledger item is priced; fast retries so the
    // stale-cache re-creation case does not sleep through real backoff.
    cost_rates: {
      ...config.cost_rates,
      gemini: {
        input_per_million: 2,
        output_per_million: 12,
        cache_read_per_million: 0.2,
        cache_storage_per_million_hour: 4.5,
      },
    },
    retry: { ...config.retry, max_attempts: 3, base_delay_ms: 1, max_delay_ms: 2 },
  };
  const stableHead = `${"S".repeat(GEMINI_EXPLICIT_CACHE_MIN_TOKENS * 4)}\n`;
  const prompt = `${stableHead}dynamic tail of round 1`;
  const makeClient = (behavior?: {
    countTokensError?: boolean;
    countTokensResult?: number;
    createWithoutUsage?: boolean;
    createDelayMs?: number;
    createError?: Error;
    // Errors thrown by the first N generateContent calls, in order.
    generateErrors?: Error[];
  }) => {
    const createCalls: Array<Record<string, unknown>> = [];
    const countCalls: Array<Record<string, unknown>> = [];
    const genCalls: Array<{ contents?: string; config?: Record<string, unknown> }> = [];
    const pendingGenerateErrors = [...(behavior?.generateErrors ?? [])];
    const client = {
      ThinkingLevel: { LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH" },
      ai: {
        caches: {
          create: async (p: Record<string, unknown>) => {
            createCalls.push(p);
            if (behavior?.createDelayMs) {
              await new Promise((resolve) => setTimeout(resolve, behavior.createDelayMs));
            }
            if (behavior?.createError) throw behavior.createError;
            return {
              name: `cachedContents/fixture-${createCalls.length}`,
              ...(behavior?.createWithoutUsage
                ? {}
                : { usageMetadata: { totalTokenCount: 5_000 } }),
            };
          },
        },
        models: {
          countTokens: async (p: Record<string, unknown>) => {
            countCalls.push(p);
            if (behavior?.countTokensError) throw new Error("countTokens unavailable");
            return { totalTokens: behavior?.countTokensResult ?? 5_000 };
          },
          generateContent: async (p: { contents?: string; config?: Record<string, unknown> }) => {
            genCalls.push(p);
            const pendingError = pendingGenerateErrors.shift();
            if (pendingError) throw pendingError;
            return {
              text: READY_JSON,
              modelVersion: geminiCacheConfig.models.gemini,
              candidates: [{ finishReason: "STOP" }],
              usageMetadata: {
                promptTokenCount: 5_200,
                candidatesTokenCount: 20,
                totalTokenCount: 5_220,
                cachedContentTokenCount: 5_000,
              },
            };
          },
        },
      },
    };
    return { client, createCalls, countCalls, genCalls };
  };
  const context = (prefixChars?: number) => ({
    session_id: "550e8400-e29b-41d4-a716-446655440077",
    round: 1,
    task: "gemini explicit cache smoke",
    emit: () => undefined,
    ...(prefixChars !== undefined ? { prompt_stable_prefix_chars: prefixChars } : {}),
  });

  __resetGeminiExplicitCacheIndexForTests();
  const armed = new GeminiAdapter(geminiCacheConfig);
  const armedMock = makeClient();
  (armed as unknown as { client: () => Promise<unknown> }).client = async () => armedMock.client;
  const first = await armed.call(prompt, context(stableHead.length));
  assert.equal(armedMock.createCalls.length, 1, "first armed call creates the cache");
  const createdConfig = armedMock.createCalls[0]?.config as {
    contents?: Array<{ parts?: Array<{ text?: string }> }>;
    ttl?: string;
  };
  // Round 2 of the Codex review: the cached prefix carries the
  // session-stable system parts followed by the stable head; the per-round
  // Round line travels after the body in BOTH modes.
  const cachedText = String(createdConfig?.contents?.[0]?.parts?.[0]?.text ?? "");
  assert.ok(
    cachedText.startsWith("You are a peer reviewer"),
    "the cached prefix opens with the session-stable system parts",
  );
  assert.ok(cachedText.endsWith(`\n\n${stableHead}`), "the cached prefix ends with the head");
  assert.equal(cachedText.includes("Round:"), false, "the per-round line never enters the cache");
  assert.equal(createdConfig?.ttl, "3600s");
  assert.equal(armedMock.genCalls[0]?.config?.cachedContent, "cachedContents/fixture-1");
  const armedLiveText = String(armedMock.genCalls[0]?.contents ?? "");
  assert.ok(
    armedLiveText.includes("dynamic tail of round 1"),
    "live contents carry the dynamic remainder",
  );
  assert.equal(
    armedLiveText.includes(stableHead),
    false,
    "the cached head must not be resent live",
  );
  assert.equal(
    armedLiveText.includes("You are a peer reviewer"),
    false,
    "the stable system parts live in the cache, not in the live contents",
  );
  assert.ok(
    armedLiveText.indexOf("Round: 1") > armedLiveText.indexOf("dynamic tail of round 1"),
    "the Round line follows the body",
  );
  assert.equal(
    armedMock.genCalls[0]?.config?.systemInstruction,
    undefined,
    "a request referencing cachedContent must not set systemInstruction (400 INVALID_ARGUMENT contract); the system prompt leads the live contents instead",
  );
  assert.equal(
    armedMock.countCalls.length,
    1,
    "the authoritative token count is fetched (free) before creation",
  );
  assert.equal(first.usage?.cache_read_tokens, 5_000);
  assert.equal(first.usage?.cache_provider_mode, "explicit");
  assert.equal(
    typeof first.usage?.cache_key_hash,
    "string",
    "the client created the entry and knows the stable key — telemetry must not record null",
  );
  assert.equal(first.usage?.input_tokens, 200);
  assert.equal(
    first.usage?.cache_storage_token_hours,
    5_000,
    "storage token-hours = cached tokens x 1h TTL, billed once at creation",
  );
  assert.ok(
    Math.abs((first.cost?.cache_storage_cost ?? 0) - 0.0225) < 1e-12,
    `the priced result itemizes the storage charge: ${first.cost?.cache_storage_cost}`,
  );
  assert.equal(first.unpriced_attempts, undefined, "the storage ledger item is not an attempt");
  const second = await armed.call(prompt, context(stableHead.length));
  assert.equal(armedMock.createCalls.length, 1, "the second call reuses the cache entry");
  assert.equal(second.usage?.cache_storage_token_hours, undefined, "storage billed only once");
  assert.equal(second.cost?.cache_storage_cost, undefined);

  // Gate off => untouched legacy composition.
  __resetGeminiExplicitCacheIndexForTests();
  const disarmed = new GeminiAdapter({
    ...geminiCacheConfig,
    cache: { ...geminiCacheConfig.cache, gemini_explicit: false },
  });
  const disarmedMock = makeClient();
  (disarmed as unknown as { client: () => Promise<unknown> }).client = async () =>
    disarmedMock.client;
  const plain = await disarmed.call(prompt, context(stableHead.length));
  assert.equal(disarmedMock.createCalls.length, 0);
  assert.equal(disarmedMock.genCalls[0]?.config?.cachedContent, undefined);
  const disarmedText = String(disarmedMock.genCalls[0]?.contents ?? "");
  assert.ok(disarmedText.includes("dynamic tail of round 1"));
  assert.equal(plain.usage?.cache_provider_mode, "implicit");
  assert.equal(plain.usage?.cache_storage_token_hours, undefined);
  // The transport invariant, proven byte-for-byte: the cached prefix plus
  // the live remainder reproduce EXACTLY the uncached composition, so
  // arming the cache can never change review behavior.
  assert.equal(
    cachedText + armedLiveText,
    disarmedText,
    "cached prefix + live remainder must equal the uncached composition byte-for-byte",
  );

  // Round 5: no character gate — one UTF-16 char can encode into multiple
  // tokens, so countTokens is the sole eligibility authority. A head that
  // counts below the minimum records the negative sentinel (no creation,
  // no re-counting until it expires).
  __resetGeminiExplicitCacheIndexForTests();
  const shortMock = makeClient({ countTokensResult: 8 });
  const shortAdapter = new GeminiAdapter(geminiCacheConfig);
  (shortAdapter as unknown as { client: () => Promise<unknown> }).client = async () =>
    shortMock.client;
  await shortAdapter.call("small head\nsmall tail", context(11));
  assert.equal(shortMock.createCalls.length, 0, "short heads never create caches");
  assert.equal(
    shortMock.countCalls.length,
    1,
    "eligibility is decided by the authoritative count, not by a character gate",
  );
  assert.equal(
    [...__geminiExplicitCacheIndexForTests().values()].filter((entry) => entry.name === "").length,
    1,
    "the below-minimum count records a negative sentinel",
  );

  // Round 5: a token-dense payload SHORTER than 4,096 chars can clear the
  // 4,096-token minimum (CJK/emoji) — the old character floor silently
  // disabled it.
  __resetGeminiExplicitCacheIndexForTests();
  const denseShortMock = makeClient();
  const denseShortAdapter = new GeminiAdapter(geminiCacheConfig);
  (denseShortAdapter as unknown as { client: () => Promise<unknown> }).client = async () =>
    denseShortMock.client;
  const denseShortHead = `${"D".repeat(2_000)}\n`;
  await denseShortAdapter.call(`${denseShortHead}dense tail`, context(denseShortHead.length));
  assert.equal(
    denseShortMock.createCalls.length,
    1,
    "a sub-4096-char payload whose authoritative count clears the minimum is eligible",
  );

  // Round 2 of the Codex review: a token-DENSE head can reach the 4,096
  // minimum well below 16,384 characters — the authoritative count decides,
  // not chars/4.
  __resetGeminiExplicitCacheIndexForTests();
  const denseMock = makeClient();
  const denseAdapter = new GeminiAdapter(geminiCacheConfig);
  (denseAdapter as unknown as { client: () => Promise<unknown> }).client = async () =>
    denseMock.client;
  const denseHead = `${"D".repeat(8_000)}\n`;
  await denseAdapter.call(`${denseHead}dense tail`, context(denseHead.length));
  assert.equal(
    denseMock.createCalls.length,
    1,
    "a dense head above the floor is decided by countTokens, not by chars/4",
  );

  // A token-SPARSE head that passes the character floor but counts below
  // the minimum: no creation call, and the negative sentinel prevents
  // re-counting on the next call.
  __resetGeminiExplicitCacheIndexForTests();
  const sparseMock = makeClient({ countTokensResult: 1_000 });
  const sparseAdapter = new GeminiAdapter(geminiCacheConfig);
  (sparseAdapter as unknown as { client: () => Promise<unknown> }).client = async () =>
    sparseMock.client;
  const sparse = await sparseAdapter.call(prompt, context(stableHead.length));
  assert.equal(sparseMock.createCalls.length, 0, "a below-minimum count never reaches creation");
  assert.equal(sparseMock.countCalls.length, 1);
  assert.equal(sparse.usage?.cache_storage_token_hours, undefined);
  await sparseAdapter.call(prompt, context(stableHead.length));
  assert.equal(
    sparseMock.countCalls.length,
    1,
    "the negative sentinel keeps later calls uncached without re-counting",
  );

  // No boundary from the orchestrator (generation/moderation) => uncached.
  __resetGeminiExplicitCacheIndexForTests();
  const noPrefixMock = makeClient();
  const noPrefixAdapter = new GeminiAdapter(geminiCacheConfig);
  (noPrefixAdapter as unknown as { client: () => Promise<unknown> }).client = async () =>
    noPrefixMock.client;
  await noPrefixAdapter.call(prompt, context(undefined));
  assert.equal(noPrefixMock.createCalls.length, 0);

  // Codex review of PR #240 — no authoritative token count => no billable
  // cache (chars/4 must never masquerade as an exact storage charge).
  __resetGeminiExplicitCacheIndexForTests();
  const noCountMock = makeClient({ countTokensError: true });
  const noCountAdapter = new GeminiAdapter(geminiCacheConfig);
  (noCountAdapter as unknown as { client: () => Promise<unknown> }).client = async () =>
    noCountMock.client;
  const noCount = await noCountAdapter.call(prompt, context(stableHead.length));
  assert.equal(
    noCountMock.createCalls.length,
    0,
    "without an authoritative token count no billable cache is created",
  );
  assert.equal(noCount.usage?.cache_storage_token_hours, undefined);

  // Creation response without usageMetadata => the free countTokens result
  // prices storage (never the chars/4 heuristic).
  __resetGeminiExplicitCacheIndexForTests();
  const countedMock = makeClient({ createWithoutUsage: true });
  const countedAdapter = new GeminiAdapter(geminiCacheConfig);
  (countedAdapter as unknown as { client: () => Promise<unknown> }).client = async () =>
    countedMock.client;
  const counted = await countedAdapter.call(prompt, context(stableHead.length));
  assert.equal(
    counted.usage?.cache_storage_token_hours,
    5_000,
    "the countTokens result prices storage when the creation response omits usageMetadata",
  );

  // Concurrent eligible calls share ONE in-flight creation; the creator
  // alone records the storage charge.
  __resetGeminiExplicitCacheIndexForTests();
  const raceMock = makeClient({ createDelayMs: 25 });
  const raceAdapter = new GeminiAdapter(geminiCacheConfig);
  (raceAdapter as unknown as { client: () => Promise<unknown> }).client = async () =>
    raceMock.client;
  const [raceFirst, raceSecond] = await Promise.all([
    raceAdapter.call(prompt, context(stableHead.length)),
    raceAdapter.call(prompt, context(stableHead.length)),
  ]);
  assert.equal(raceMock.createCalls.length, 1, "concurrent calls share one in-flight creation");
  assert.equal(
    [raceFirst, raceSecond].filter((r) => (r.usage?.cache_storage_token_hours ?? 0) > 0).length,
    1,
    "exactly one of the racers records the storage charge",
  );

  // Insertion sweeps expired entries so the process-wide index stays
  // bounded by live heads.
  __resetGeminiExplicitCacheIndexForTests();
  __seedGeminiExplicitCacheIndexForTests("expired-fixture-key", {
    name: "cachedContents/expired",
    token_count: 1,
    expires_at_ms: Date.now() - 1_000,
  });
  const evictMock = makeClient();
  const evictAdapter = new GeminiAdapter(geminiCacheConfig);
  (evictAdapter as unknown as { client: () => Promise<unknown> }).client = async () =>
    evictMock.client;
  await evictAdapter.call(prompt, context(stableHead.length));
  assert.equal(
    __geminiExplicitCacheIndexForTests().has("expired-fixture-key"),
    false,
    "insertion evicts expired entries",
  );
  assert.equal(__geminiExplicitCacheIndexForTests().size, 1);

  // A stale cachedContents rejection drops the entry AND retries: the
  // review succeeds against a freshly created cache instead of failing.
  __resetGeminiExplicitCacheIndexForTests();
  const staleMock = makeClient({
    generateErrors: [
      Object.assign(new Error("400 INVALID_ARGUMENT: cachedContents/fixture-1 is not found"), {
        status: 400,
      }),
    ],
  });
  const staleAdapter = new GeminiAdapter(geminiCacheConfig);
  (staleAdapter as unknown as { client: () => Promise<unknown> }).client = async () =>
    staleMock.client;
  const staleResult = await staleAdapter.call(prompt, context(stableHead.length));
  assert.equal(staleMock.createCalls.length, 2, "the dropped stale entry is re-created on retry");
  assert.equal(staleMock.genCalls[1]?.config?.cachedContent, "cachedContents/fixture-2");
  assert.equal(
    staleResult.usage?.cache_storage_token_hours,
    10_000,
    "both real creations bill storage",
  );

  // A terminal review failure AFTER creation keeps the storage charge in
  // the failure billing (the ledger records it at creation, not at
  // success).
  __resetGeminiExplicitCacheIndexForTests();
  const failMock = makeClient({
    generateErrors: [
      Object.assign(new Error("400 INVALID_ARGUMENT: schema mismatch"), { status: 400 }),
    ],
  });
  const failAdapter = new GeminiAdapter(geminiCacheConfig);
  (failAdapter as unknown as { client: () => Promise<unknown> }).client = async () =>
    failMock.client;
  await assert.rejects(failAdapter.call(prompt, context(stableHead.length)), (error: unknown) => {
    const failure = (error as { peerFailure?: PeerFailure }).peerFailure;
    assert.ok(failure, "the terminal rejection carries the peerFailure record");
    assert.equal(
      failure.usage?.cache_storage_token_hours,
      5_000,
      "a failed review keeps the deterministic storage charge",
    );
    assert.ok(
      Math.abs((failure.cost?.cache_storage_cost ?? 0) - 0.0225) < 1e-12,
      `the failure cost itemizes storage: ${failure.cost?.cache_storage_cost}`,
    );
    assert.equal(failure.unpriced_attempts, 1);
    assert.equal(failure.billing_status, "unknown");
    return true;
  });

  // A transport-ambiguous creation failure may have billed server-side:
  // it surfaces as one unpriced attempt instead of settling as known-zero.
  __resetGeminiExplicitCacheIndexForTests();
  const ambiguousMock = makeClient({ createError: new Error("fetch failed: ECONNRESET") });
  const ambiguousAdapter = new GeminiAdapter(geminiCacheConfig);
  (ambiguousAdapter as unknown as { client: () => Promise<unknown> }).client = async () =>
    ambiguousMock.client;
  const ambiguous = await ambiguousAdapter.call(prompt, context(stableHead.length));
  assert.equal(ambiguousMock.createCalls.length, 1);
  assert.equal(ambiguous.usage?.cache_storage_token_hours, undefined);
  assert.equal(
    ambiguous.unpriced_attempts,
    1,
    "an ambiguous creation is an unpriced provider attempt",
  );
  assert.equal(
    ambiguous.indeterminate_spend_attempts,
    1,
    "the successful result carries the positive indeterminate marker so settlement keeps the orphaned-cache spend unknown",
  );

  // Round 8: a legitimately configured ZERO storage rate is still a KNOWN
  // price — a terminal failure after creation settles with a known cost
  // (total 0, explicit cache_storage_cost 0), never as unknown spend.
  __resetGeminiExplicitCacheIndexForTests();
  const zeroRateConfig = {
    ...geminiCacheConfig,
    cost_rates: {
      ...geminiCacheConfig.cost_rates,
      gemini: {
        input_per_million: 2,
        output_per_million: 12,
        cache_storage_per_million_hour: 0,
      },
    },
  };
  const zeroRateMock = makeClient({
    generateErrors: [
      Object.assign(new Error("400 INVALID_ARGUMENT: schema mismatch"), { status: 400 }),
    ],
  });
  const zeroRateAdapter = new GeminiAdapter(zeroRateConfig);
  (zeroRateAdapter as unknown as { client: () => Promise<unknown> }).client = async () =>
    zeroRateMock.client;
  await assert.rejects(
    zeroRateAdapter.call(prompt, context(stableHead.length)),
    (error: unknown) => {
      const failure = (error as { peerFailure?: PeerFailure }).peerFailure;
      assert.ok(failure);
      assert.equal(
        failure.cost?.total_cost,
        0,
        "a zero storage rate settles the failure with a KNOWN zero cost, not unknown spend",
      );
      assert.equal(failure.usage?.cache_storage_token_hours, 5_000);
      return true;
    },
  );

  // Round 3: line-ending resubmissions — the key hash normalizes CRLF, so
  // the STORED payload must be the same LF-normalized bytes.
  __resetGeminiExplicitCacheIndexForTests();
  const crlfMock = makeClient();
  const crlfAdapter = new GeminiAdapter(geminiCacheConfig);
  (crlfAdapter as unknown as { client: () => Promise<unknown> }).client = async () =>
    crlfMock.client;
  const crlfHead = `${"S".repeat(GEMINI_EXPLICIT_CACHE_MIN_TOKENS * 4)}\r\n`;
  await crlfAdapter.call(`${crlfHead}dynamic tail of round 1`, context(crlfHead.length));
  assert.equal(crlfMock.createCalls.length, 1);
  const crlfPayload = String(
    (crlfMock.createCalls[0]?.config as { contents?: Array<{ parts?: Array<{ text?: string }> }> })
      ?.contents?.[0]?.parts?.[0]?.text ?? "",
  );
  assert.equal(
    crlfPayload.includes("\r"),
    false,
    "the stored cache payload is LF-normalized to match the normalized key hash",
  );
  // Round 6: the UNCACHED composition is LF-normalized too — otherwise
  // arming the cache would change the exact prompt bytes under CRLF input.
  const crlfDisarmed = new GeminiAdapter({
    ...geminiCacheConfig,
    cache: { ...geminiCacheConfig.cache, gemini_explicit: false },
  });
  const crlfDisarmedMock = makeClient();
  (crlfDisarmed as unknown as { client: () => Promise<unknown> }).client = async () =>
    crlfDisarmedMock.client;
  await crlfDisarmed.call(`${crlfHead}dynamic tail of round 1`, context(crlfHead.length));
  const crlfUncachedText = String(crlfDisarmedMock.genCalls[0]?.contents ?? "");
  assert.equal(
    crlfUncachedText.includes("\r"),
    false,
    "the uncached composition is LF-normalized too",
  );
  assert.equal(
    crlfPayload + String(crlfMock.genCalls[0]?.contents ?? ""),
    crlfUncachedText,
    "the transport invariant holds byte-for-byte under CRLF input",
  );

  // Round 3: a cancellation landing during the free countTokens call must
  // stop before the BILLED caches.create call.
  __resetGeminiExplicitCacheIndexForTests();
  const cancelController = new AbortController();
  const cancelMock = makeClient();
  const originalCountTokens = cancelMock.client.ai.models.countTokens;
  cancelMock.client.ai.models.countTokens = async (p: Record<string, unknown>) => {
    cancelController.abort();
    return originalCountTokens(p);
  };
  const cancelAdapter = new GeminiAdapter(geminiCacheConfig);
  (cancelAdapter as unknown as { client: () => Promise<unknown> }).client = async () =>
    cancelMock.client;
  await cancelAdapter
    .call(prompt, {
      ...context(stableHead.length),
      signal: cancelController.signal,
    })
    .catch(() => undefined);
  assert.equal(
    cancelMock.createCalls.length,
    0,
    "a cancellation observed after countTokens must prevent the billable creation",
  );

  // Round 4: the character floor applies to the COMPLETE cache payload —
  // a head below 4,096 chars still clears the floor when the stable
  // system parts (long task) push the payload over it.
  __resetGeminiExplicitCacheIndexForTests();
  const shortHeadMock = makeClient();
  const shortHeadAdapter = new GeminiAdapter(geminiCacheConfig);
  (shortHeadAdapter as unknown as { client: () => Promise<unknown> }).client = async () =>
    shortHeadMock.client;
  const shortHead = `${"H".repeat(3_900)}\n`;
  await shortHeadAdapter.call(`${shortHead}short-head tail`, context(shortHead.length));
  assert.equal(
    shortHeadMock.createCalls.length,
    1,
    "the floor is measured on stableSystem + head, so a sub-4096-char head can still be eligible",
  );

  // Round 4: negative sentinels (name === "") must never match a stale
  // error message — String.includes("") is always true.
  __resetGeminiExplicitCacheIndexForTests();
  __seedGeminiExplicitCacheIndexForTests("negative-sentinel-key", {
    name: "",
    token_count: 1_000,
    expires_at_ms: Date.now() + 3_600_000,
  });
  const sentinelMock = makeClient({
    generateErrors: [
      Object.assign(new Error("400 INVALID_ARGUMENT: cachedContents/unrelated is not found"), {
        status: 400,
      }),
    ],
  });
  const sentinelAdapter = new GeminiAdapter(geminiCacheConfig);
  (sentinelAdapter as unknown as { client: () => Promise<unknown> }).client = async () =>
    sentinelMock.client;
  await assert.rejects(
    sentinelAdapter.call(prompt, context(stableHead.length)),
    () => true,
    "an error naming an UNRELATED cached resource is terminal, not a forced retry",
  );
  assert.equal(
    __geminiExplicitCacheIndexForTests().has("negative-sentinel-key"),
    true,
    "the negative sentinel survives an unrelated cached-content error",
  );

  // Round 5: a cancellation landing while caches.create is STALLED must
  // release the attempt promptly (raced abort) instead of waiting the
  // call out and indexing the entry.
  __resetGeminiExplicitCacheIndexForTests();
  const stallController = new AbortController();
  // The pending mock timer keeps the process alive for its duration, so
  // keep it short — the race must release the attempt far earlier anyway.
  const stallMock = makeClient({ createDelayMs: 3_000 });
  const stallAdapter = new GeminiAdapter(geminiCacheConfig);
  (stallAdapter as unknown as { client: () => Promise<unknown> }).client = async () =>
    stallMock.client;
  setTimeout(() => stallController.abort(), 25);
  const stallStarted = Date.now();
  let stallError: unknown;
  await stallAdapter
    .call(prompt, { ...context(stableHead.length), signal: stallController.signal })
    .catch((error: unknown) => {
      stallError = error;
    });
  assert.ok(
    Date.now() - stallStarted < 2_000,
    "a stalled creation must not hold the cancelled attempt hostage",
  );
  // Codex round 11 (class sweep): the abort landed while the BILLABLE
  // caches.create was in flight - the server may have created and billed
  // the resource, so the failure must carry an indeterminate-spend marker.
  const stallFailure = (stallError as { peerFailure?: PeerFailure } | undefined)?.peerFailure;
  assert.ok(
    (stallFailure?.indeterminate_spend_attempts ?? 0) >= 1,
    `an abort racing an in-flight caches.create keeps its spend indeterminate: ${JSON.stringify({
      failure_class: stallFailure?.failure_class,
      unpriced: stallFailure?.unpriced_attempts,
      indeterminate: stallFailure?.indeterminate_spend_attempts,
    })}`,
  );
  assert.equal(stallMock.createCalls.length, 1, "the creation was dispatched before the abort");
  assert.equal(
    __geminiExplicitCacheIndexForTests().size,
    0,
    "a raced-away creation never indexes an entry",
  );

  // Round 7: a WAITER sharing the in-flight creation races its own
  // signal — cancelling it releases promptly without cancelling the
  // creator.
  __resetGeminiExplicitCacheIndexForTests();
  const waiterController = new AbortController();
  const sharedMock = makeClient({ createDelayMs: 400 });
  const creatorAdapter = new GeminiAdapter(geminiCacheConfig);
  (creatorAdapter as unknown as { client: () => Promise<unknown> }).client = async () =>
    sharedMock.client;
  const waiterAdapter = new GeminiAdapter(geminiCacheConfig);
  (waiterAdapter as unknown as { client: () => Promise<unknown> }).client = async () =>
    sharedMock.client;
  const creatorPromise = creatorAdapter.call(prompt, context(stableHead.length));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const waiterStarted = Date.now();
  let waiterError: unknown;
  const waiterPromise = waiterAdapter
    .call(prompt, { ...context(stableHead.length), signal: waiterController.signal })
    .catch((error: unknown) => {
      waiterError = error;
      return "waiter-rejected";
    });
  setTimeout(() => waiterController.abort(), 30);
  const waiterOutcome = await waiterPromise;
  const waiterMs = Date.now() - waiterStarted;
  assert.equal(waiterOutcome, "waiter-rejected", "the cancelled waiter rejects");
  assert.ok(waiterMs < 300, `the waiter releases before the creator settles (${waiterMs}ms)`);
  // Codex round 11: the waiter dispatched neither countTokens nor
  // caches.create nor generation - its cancellation settles as ZERO
  // provider work (no unpriced attempt, no indeterminate marker), so it
  // can never trip sessionHasUnknownProviderSpend.
  const waiterFailure = (waiterError as { peerFailure?: PeerFailure } | undefined)?.peerFailure;
  assert.equal(waiterFailure?.failure_class, "cancelled", "the waiter abort is a cancellation");
  assert.equal(
    waiterFailure?.unpriced_attempts ?? 0,
    0,
    `a waiter-only abort records no unpriced provider attempt: ${JSON.stringify({
      unpriced: waiterFailure?.unpriced_attempts,
      indeterminate: waiterFailure?.indeterminate_spend_attempts,
    })}`,
  );
  assert.equal(
    waiterFailure?.indeterminate_spend_attempts ?? 0,
    0,
    "a waiter-only abort carries no indeterminate-spend marker",
  );
  const creatorResult = await creatorPromise;
  assert.equal(sharedMock.createCalls.length, 1, "the creator still completes its creation");
  assert.equal(creatorResult.usage?.cache_storage_token_hours, 5_000);
  console.log("[provider-refresh-smoke] gemini_explicit_cache_test: PASS");
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
  const opus5 = selectFromCandidates(
    "claude",
    [
      { id: "claude-fable-5", source: "api" },
      { id: "claude-opus-5", source: "api" },
    ],
    "claude-opus-5",
  );
  assert.equal(opus5.selected, "claude-opus-5");
  assert.equal(
    opus5.confidence,
    "verified",
    "Claude Opus 5 must be a first-class supported operator override when the Models API lists it.",
  );
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
    reasoning_effort: { ...config.reasoning_effort, claude: "ultra" },
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
  assert.deepEqual(
    capturedPayload?.output_config,
    { effort: "max" },
    "Claude must normalize the ultra alias to its strongest official output_config.effort value.",
  );
}

{
  const adapter = new AnthropicAdapter({
    ...config,
    models: { ...config.models, claude: "claude-opus-5" },
    reasoning_effort: { ...config.reasoning_effort, claude: "max" },
    max_output_tokens_by_peer: { ...config.max_output_tokens_by_peer, claude: 64_000 },
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
          model: "claude-opus-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 20 },
        };
      },
    },
  });
  await adapter.generate("Revise this fixture.", {
    session_id: "550e8400-e29b-41d4-a716-446655440014",
    round: 1,
    task: "Claude Opus 5 provider contract",
    emit: () => undefined,
  });
  assert.equal(capturedPayload?.model, "claude-opus-5");
  assert.equal(capturedPayload?.max_tokens, 64_000);
  assert.deepEqual(capturedPayload?.thinking, { type: "adaptive", display: "omitted" });
  assert.deepEqual(capturedPayload?.output_config, { effort: "max" });
  for (const unsupportedSamplingField of ["temperature", "top_p", "top_k"]) {
    assert.equal(
      Object.hasOwn(capturedPayload ?? {}, unsupportedSamplingField),
      false,
      `Claude Opus 5 request must not send unsupported ${unsupportedSamplingField}.`,
    );
  }
}

assert.equal(anthropicCacheMinTokens("claude-fable-5"), 512);
assert.equal(anthropicCacheMinTokens("claude-opus-5"), 512);
assert.equal(anthropicCacheMinTokens("claude-opus-4-8"), 1_024);
assert.equal(anthropicCacheMinTokens("claude-unknown"), 4_096);

assert.equal(
  clampEffortForPerplexity("ultra"),
  "max",
  "Perplexity must normalize ultra to the documented Agent API ceiling `max`.",
);

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
    models: { ...config.models, claude: "claude-opus-5" },
    cost_rates: {
      ...config.cost_rates,
      claude: {
        input_per_million: 5,
        output_per_million: 25,
        cache_read_per_million: 0.5,
        cache_write_per_million: 10,
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
        model: "claude-opus-5",
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
    (error: unknown) => {
      assert.match(
        error instanceof Error ? error.message : String(error),
        /Anthropic refusal from claude-opus-5/,
      );
      const failure = (
        error as { peerFailure?: { cost?: { total_cost?: number }; unpriced_attempts?: number } }
      ).peerFailure;
      assert.equal(failure?.cost?.total_cost, 0);
      assert.equal(failure?.unpriced_attempts ?? 0, 0);
      return true;
    },
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "provider.refusal" &&
        event.peer === "claude" &&
        event.data?.model === "claude-opus-5" &&
        event.data?.billed === false,
    ),
    "Anthropic Opus 5 refusal before output must emit billed=false even when usage is reported.",
  );
}

{
  const adapter = new AnthropicAdapter({
    ...config,
    models: { ...config.models, claude: "claude-fable-5" },
    cost_rates: {
      ...config.cost_rates,
      claude: { input_per_million: 10, output_per_million: 50 },
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
            stop_details: { type: string; category: string };
            usage: { input_tokens: number; output_tokens: number };
          }>;
        };
      }>;
    }
  ).client = async () => ({
    messages: {
      create: async () => ({
        content: [{ type: "text", text: "partial refusal output" }],
        model: "claude-fable-5",
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "cyber" },
        usage: { input_tokens: 412, output_tokens: 5 },
      }),
    },
  });
  const events: RuntimeEvent[] = [];
  await assert.rejects(
    () =>
      adapter.call("Review this fixture.", {
        session_id: "550e8400-e29b-41d4-a716-446655440001",
        round: 1,
        task: "provider refresh smoke",
        emit: (event) => events.push(event),
      }),
    (error: unknown) => {
      const failure = (error as { peerFailure?: { cost?: { total_cost?: number } } }).peerFailure;
      assert.ok((failure?.cost?.total_cost ?? 0) > 0);
      return true;
    },
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "provider.refusal" && event.peer === "claude" && event.data?.billed === true,
    ),
    "Anthropic refusal after output must emit billed=true and preserve cost.",
  );
}

{
  const adapter = new GeminiAdapter({
    ...config,
    reasoning_effort: { ...config.reasoning_effort, gemini: "ultra" },
    streaming: { ...config.streaming, tokens: false },
  });
  let capturedPayload: Record<string, unknown> | undefined;
  (
    adapter as unknown as {
      client: () => Promise<{
        ThinkingLevel: { HIGH: string };
        ai: {
          models: {
            generateContent: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
          };
        };
      }>;
    }
  ).client = async () => ({
    ThinkingLevel: { HIGH: "HIGH" },
    ai: {
      models: {
        generateContent: async (payload) => {
          capturedPayload = payload;
          return {
            text: "revised fixture",
            modelVersion: "gemini-3.1-pro-preview",
            candidates: [{ finishReason: "STOP" }],
            usageMetadata: {
              promptTokenCount: 100,
              cachedContentTokenCount: 40,
              candidatesTokenCount: 20,
              totalTokenCount: 120,
            },
          };
        },
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
  assert.deepEqual(
    (capturedPayload?.config as { thinkingConfig?: unknown } | undefined)?.thinkingConfig,
    { includeThoughts: false, thinkingLevel: "HIGH" },
    "Gemini has no shared reasoning_effort wire enum; ultra must keep its native HIGH thinking control without leaking the alias.",
  );
  assert.equal(JSON.stringify(capturedPayload).includes("ultra"), false);
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
  assert.ok(configSource.includes('grok: envValue("CROSS_REVIEW_GROK_MODEL") || "grok-4.6"'));
  assert.ok(
    configSource.includes(
      'perplexity: envValue("CROSS_REVIEW_PERPLEXITY_MODEL") || "perplexity/kimi-k3"',
    ),
  );
  assert.ok(
    configSource.includes('codex: reasoningEffort("CROSS_REVIEW_OPENAI_REASONING_EFFORT", "max")'),
  );
  assert.ok(
    configSource.includes(
      'claude: reasoningEffort("CROSS_REVIEW_ANTHROPIC_REASONING_EFFORT", "max")',
    ),
  );
  assert.ok(
    configSource.includes('grok: reasoningEffort("CROSS_REVIEW_GROK_REASONING_EFFORT", "xhigh")'),
  );
  assert.ok(
    configSource.includes(
      'perplexity: reasoningEffort("CROSS_REVIEW_PERPLEXITY_REASONING_EFFORT", "max")',
    ),
  );
  assert.ok(modelSelectionSource.includes('codex: ["gpt-5.6-sol"]'));
  assert.ok(modelSelectionSource.includes('claude: ["claude-fable-5"]'));
  assert.ok(modelSelectionSource.includes('gemini: ["gemini-3.1-pro-preview"]'));
  assert.ok(modelSelectionSource.includes('grok: ["grok-4.6"]'));
  assert.ok(modelSelectionSource.includes('perplexity: ["perplexity/kimi-k3"]'));
}

console.log("[provider-refresh-smoke] PASS");
