import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getFileConfigRuntimeStatus,
  loadConfig,
  missingFinancialControlVars,
} from "../src/core/config.js";
import { estimateCost, mergeCost, mergeUsage } from "../src/core/cost.js";
import {
  applyFileConfigToEnv,
  FileConfigSchema,
  flattenFileConfigToEnvMap,
} from "../src/core/file-config.js";
import {
  CrossReviewOrchestrator,
  estimatedPeerRoundCost,
  evidencePreflight,
  groundReadyPeerEvidence,
  truthfulnessPreflight,
} from "../src/core/orchestrator.js";
import { maxOutputTokensForPeer } from "../src/core/output-budget.js";
import { SessionStore } from "../src/core/session-store.js";
import { parsePeerStatus, statusJsonSchema } from "../src/core/status.js";
import type {
  AppConfig,
  CostEstimate,
  CostRateConfig,
  PeerCallContext,
  PeerResult,
  TokenUsage,
} from "../src/core/types.js";
import {
  centralConfigDeprecatedKeysBootNotice,
  centralConfigInvalidBootNotice,
} from "../src/mcp/server.js";
import { AnthropicAdapter } from "../src/peers/anthropic.js";
import { DeepSeekAdapter } from "../src/peers/deepseek.js";
import { GeminiAdapter } from "../src/peers/gemini.js";
import { GrokAdapter } from "../src/peers/grok.js";
import { OpenAIAdapter } from "../src/peers/openai.js";
import { PerplexityAdapter } from "../src/peers/perplexity.js";
import { StubAdapter } from "../src/peers/stub.js";
import { assertGeminiCompletion, assertResponsesCompletion } from "../src/peers/terminal.js";

process.env.ANTHROPIC_API_KEY = "fixture-anthropic-key";

type Regression = {
  name: string;
  run: () => void | Promise<void>;
};

const READY = JSON.stringify({
  status: "READY",
  summary: "No blocking objections remain.",
  confidence: "verified",
  evidence_sources: [],
  caller_requests: [],
  follow_ups: [],
});

const EVIDENCE_PATH = "evidence/caller-structured-evidence.txt";
const EVIDENCE_SHA = "be96b58cc183b1a1712a2d0dd881d944d961e14da90cc81463fb1f7d4bdcd924";

function context(streamTokens = false): PeerCallContext {
  return {
    session_id: "550e8400-e29b-41d4-a716-446655440456",
    round: 1,
    task: "provider wire contract regression",
    stream_tokens: streamTokens,
    emit: () => undefined,
  };
}

function offlineConfig(
  options: {
    streamTokens?: boolean;
    efforts?: Partial<AppConfig["reasoning_effort"]>;
    outputByPeer?: Partial<Record<keyof AppConfig["models"], number>>;
    retryAttempts?: number;
  } = {},
): AppConfig {
  const base = loadConfig();
  return {
    ...base,
    api_keys: {
      ...base.api_keys,
      codex: "fixture-openai-key",
      claude: "fixture-anthropic-key",
      gemini: "fixture-gemini-key",
      deepseek: "fixture-deepseek-key",
      grok: "fixture-grok-key",
      perplexity: "fixture-perplexity-key",
    },
    retry: { ...base.retry, max_attempts: options.retryAttempts ?? 1 },
    streaming: { ...base.streaming, tokens: options.streamTokens ?? false },
    reasoning_effort: { ...base.reasoning_effort, ...options.efforts },
    ...({ max_output_tokens_by_peer: options.outputByPeer ?? {} } as Record<string, unknown>),
  } as AppConfig;
}

function completedResponsesResult(model: string): Record<string, unknown> {
  return {
    status: "completed",
    output_text: READY,
    model,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
}

function completedChatResult(model: string): Record<string, unknown> {
  return {
    model,
    choices: [{ index: 0, finish_reason: "stop", message: { content: READY } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function readyPeer(source: string): PeerResult {
  return {
    peer: "gemini",
    provider: "google",
    model: "gemini-3.1-pro-preview",
    status: "READY",
    structured: {
      status: "READY",
      summary: "No blocking objections remain.",
      confidence: "verified",
      evidence_sources: [source],
      caller_requests: [],
      follow_ups: [],
    },
    text: "",
    raw: {},
    latency_ms: 0,
    attempts: 1,
    parser_warnings: [],
    decision_quality: "clean",
  } as PeerResult;
}

function citation(quote: string): string {
  return [
    `Attachment: ${EVIDENCE_PATH}`,
    `sha256=${EVIDENCE_SHA}`,
    `Artifact quote: "${quote}"`,
  ].join("\n");
}

function grounding(source: string, content: string) {
  return groundReadyPeerEvidence(readyPeer(source), {
    artifactText: "Review this static implementation candidate.",
    attachedEvidenceText: "",
    attachmentRefs: [EVIDENCE_PATH],
    evidenceAttachments: [{ relative_path: EVIDENCE_PATH, sha256: EVIDENCE_SHA }],
    callerSubmittedAttachments: [
      {
        relative_path: EVIDENCE_PATH,
        sha256: EVIDENCE_SHA,
        content,
      },
    ],
    runtimeFacts: {},
  });
}

function schemaKeywordPaths(value: unknown, forbidden: ReadonlySet<string>): string[] {
  const found: string[] = [];
  const visit = (current: unknown, pointer: string): void => {
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      for (const [index, item] of current.entries()) visit(item, `${pointer}[${index}]`);
      return;
    }
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      const childPointer = `${pointer}.${key}`;
      if (forbidden.has(key)) found.push(childPointer);
      visit(child, childPointer);
    }
  };
  visit(value, "$schema");
  return found;
}

const regressions: Regression[] = [
  {
    name: "anthropic wire schema excludes every unsupported canonical constraint",
    run: async () => {
      const config = offlineConfig();
      const adapter = new AnthropicAdapter(config);
      let requestBody: Record<string, unknown> | undefined;
      Object.defineProperty(adapter, "client", {
        configurable: true,
        value: async () => ({
          messages: {
            create: async (body: Record<string, unknown>) => {
              requestBody = body;
              return {
                content: [{ type: "text", text: READY }],
                model: adapter.model,
                stop_reason: "end_turn",
                usage: { input_tokens: 1, output_tokens: 1 },
              };
            },
          },
        }),
      });

      await adapter.call("fixture", context());
      type OutputConfig = { format?: { schema?: unknown } | undefined };
      const outputConfig = requestBody?.output_config as OutputConfig | undefined;
      const wireSchema = outputConfig?.format?.schema;
      assert.ok(wireSchema, "the exact Anthropic request must contain a structured-output schema");
      assert.deepEqual(
        schemaKeywordPaths(wireSchema, new Set(["maxItems", "minLength", "maxLength"])),
        [],
        "Anthropic must receive its documented JSON-Schema subset, not the canonical schema verbatim",
      );

      assert.equal(
        statusJsonSchema.properties.evidence_sources.maxItems,
        30,
        "provider lowering must not weaken the canonical/local contract",
      );
      assert.equal(statusJsonSchema.properties.summary.maxLength, 800);
    },
  },
  {
    name: "Gemini wire schema and effort use the documented API contract",
    run: async () => {
      const gemini = new GeminiAdapter(offlineConfig({ efforts: { gemini: "low" } }));
      let geminiRequest: Record<string, unknown> | undefined;
      Object.defineProperty(gemini, "client", {
        configurable: true,
        value: async () => ({
          ThinkingLevel: { LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH" },
          ai: {
            models: {
              generateContent: async (body: Record<string, unknown>) => {
                geminiRequest = body;
                return {
                  text: READY,
                  modelVersion: gemini.model,
                  candidates: [{ index: 0, finishReason: "STOP" }],
                  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
                };
              },
            },
          },
        }),
      });
      await gemini.call("fixture", context());
      const geminiConfig = geminiRequest?.config as Record<string, unknown>;
      assert.deepEqual(
        {
          forbiddenKeywords: schemaKeywordPaths(
            geminiConfig.responseJsonSchema,
            new Set(["maxLength"]),
          ),
          thinkingConfig: geminiConfig.thinkingConfig,
        },
        {
          forbiddenKeywords: [],
          thinkingConfig: { includeThoughts: false, thinkingLevel: "LOW" },
        },
        "Gemini's closed contract excludes maxLength and must honor configured effort",
      );
    },
  },
  {
    name: "Grok wire omits undocumented verbosity and respects guaranteed schema limits",
    run: async () => {
      const grok = new GrokAdapter(offlineConfig());
      let grokRequest: Record<string, unknown> | undefined;
      Object.defineProperty(grok, "client", {
        configurable: true,
        value: async () => ({
          responses: {
            create: async (body: Record<string, unknown>) => {
              grokRequest = body;
              return completedResponsesResult(grok.model);
            },
          },
        }),
      });
      await grok.call("fixture", context());
      const grokText = grokRequest?.text as {
        verbosity?: unknown;
        format?: { schema?: { properties?: Record<string, unknown> } };
      };
      const grokEvidence = grokText.format?.schema?.properties?.evidence_sources as {
        items?: { maxLength?: number };
      };
      assert.deepEqual(
        {
          verbosity: grokText.verbosity,
          evidenceItemMaxLength: grokEvidence.items?.maxLength,
        },
        { verbosity: undefined, evidenceItemMaxLength: 2048 },
        "xAI omits undocumented verbosity and only guarantees maxLength through 2048",
      );
    },
  },
  {
    name: "Perplexity wire uses the documented Agent API structured-output wrapper",
    run: async () => {
      // Explicit knobs so the wire assertions never depend on the host's
      // central config.json.
      const base = offlineConfig({ efforts: { perplexity: "max" } });
      const perplexity = new PerplexityAdapter({
        ...base,
        perplexity: {
          ...base.perplexity,
          search_context_size: "low",
          disable_search: false,
          max_steps: 1,
        },
      });
      let perplexityRequest: Record<string, unknown> | undefined;
      Object.defineProperty(perplexity, "client", {
        configurable: true,
        value: async () => ({
          responses: {
            create: async (body: Record<string, unknown>) => {
              perplexityRequest = body;
              return completedResponsesResult(perplexity.model);
            },
          },
        }),
      });
      await perplexity.call("fixture", context());
      const responseFormat = perplexityRequest?.response_format as {
        type?: unknown;
        json_schema?: { name?: unknown; schema?: unknown };
      };
      assert.deepEqual(
        {
          type: responseFormat.type,
          name: responseFormat.json_schema?.name,
          textFormat: perplexityRequest?.text,
          forbiddenKeywords: schemaKeywordPaths(
            responseFormat.json_schema?.schema,
            new Set(["maxItems", "minLength", "maxLength"]),
          ),
        },
        {
          type: "json_schema",
          name: "cross_review_status",
          textFormat: undefined,
          forbiddenKeywords: [],
        },
        "Agent API documents a top-level response_format wrapper; the backend model is provider-agnostic so no closed dimensional-keyword contract is assumed",
      );
      assert.equal(typeof perplexityRequest?.instructions, "string");
      assert.deepEqual(perplexityRequest?.reasoning, { effort: "max" });
      assert.deepEqual(perplexityRequest?.tools, [
        { type: "web_search", search_context_size: "low" },
      ]);
      assert.equal(perplexityRequest?.max_steps, 1);
    },
  },
  {
    name: "Perplexity streaming omits undocumented OpenAI stream_options",
    run: async () => {
      const perplexity = new PerplexityAdapter(offlineConfig({ streamTokens: true }));
      let perplexityRequest: Record<string, unknown> | undefined;
      Object.defineProperty(perplexity, "client", {
        configurable: true,
        value: async () => ({
          responses: {
            create: async (body: Record<string, unknown>) => {
              perplexityRequest = body;
              return (async function* () {
                yield { type: "response.output_text.delta", delta: READY };
                yield {
                  type: "response.completed",
                  response: {
                    status: "completed",
                    model: perplexity.model,
                    output: [{ type: "message", content: [{ type: "output_text", text: READY }] }],
                    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                  },
                };
              })();
            },
          },
        }),
      });
      await perplexity.call("fixture", context(true));
      assert.equal(perplexityRequest?.stream, true);
      assert.equal(perplexityRequest?.stream_options, undefined);
    },
  },
  {
    name: "OpenAI and DeepSeek retain their documented structured-output modes",
    run: async () => {
      const openai = new OpenAIAdapter(offlineConfig());
      let openAIRequest: Record<string, unknown> | undefined;
      Object.defineProperty(openai, "client", {
        configurable: true,
        value: async () => ({
          responses: {
            create: async (body: Record<string, unknown>) => {
              openAIRequest = body;
              return completedResponsesResult(openai.model);
            },
          },
        }),
      });
      await openai.call("fixture", context());
      const openAIText = openAIRequest?.text as {
        format?: { strict?: boolean; schema?: typeof statusJsonSchema };
      };
      assert.equal(openAIText.format?.strict, true);
      assert.equal(openAIText.format?.schema?.properties.summary.maxLength, 800);
      assert.equal(openAIText.format?.schema?.properties.evidence_sources.maxItems, 30);

      const deepseek = new DeepSeekAdapter(offlineConfig());
      let deepSeekRequest: Record<string, unknown> | undefined;
      Object.defineProperty(deepseek, "client", {
        configurable: true,
        value: async () => ({
          chat: {
            completions: {
              create: async (body: Record<string, unknown>) => {
                deepSeekRequest = body;
                return completedChatResult(deepseek.model);
              },
            },
          },
        }),
      });
      await deepseek.call("fixture", context());
      assert.deepEqual(deepSeekRequest?.response_format, { type: "json_object" });
    },
  },
  {
    name: "per-peer output budgets survive strict central-config loading and reach provider wires",
    run: async () => {
      const fileCandidate = {
        max_output_tokens: 20_000,
        max_output_tokens_by_peer: { codex: 25_000, claude: 64_000 },
      };
      const parsed = FileConfigSchema.safeParse(fileCandidate);
      const flattened = flattenFileConfigToEnvMap(fileCandidate as never);
      const familyFlattened = flattenFileConfigToEnvMap({
        models: { claude: "claude-fable-5-preview" },
        model_cost_rates: {
          claude: {
            "claude-fable": { input_per_million: 1, output_per_million: 2 },
            "claude-fable-5": { input_per_million: 10, output_per_million: 50 },
          },
        },
      } as never);
      assert.equal(
        familyFlattened.CROSS_REVIEW_ANTHROPIC_INPUT_USD_PER_MILLION,
        "10",
        "central-config flattening must choose the longest matching model family",
      );

      const budgetEnvNames = [
        "CROSS_REVIEW_OPENAI_MAX_OUTPUT_TOKENS",
        "CROSS_REVIEW_ANTHROPIC_MAX_OUTPUT_TOKENS",
        "CROSS_REVIEW_GEMINI_MAX_OUTPUT_TOKENS",
        "CROSS_REVIEW_DEEPSEEK_MAX_OUTPUT_TOKENS",
        "CROSS_REVIEW_GROK_MAX_OUTPUT_TOKENS",
        "CROSS_REVIEW_PERPLEXITY_MAX_OUTPUT_TOKENS",
      ] as const;
      const previousBudgetEnv = new Map(
        budgetEnvNames.map((name) => [name, process.env[name]] as const),
      );
      // Make the fixture hermetic even when the operator's central config
      // defines budgets for the four peers outside this two-provider case.
      // Whitespace wins over file/registry defaults but trims to undefined
      // without producing an invalid-value warning.
      for (const name of budgetEnvNames) process.env[name] = " ";
      process.env.CROSS_REVIEW_OPENAI_MAX_OUTPUT_TOKENS = "25000";
      process.env.CROSS_REVIEW_ANTHROPIC_MAX_OUTPUT_TOKENS = "64000";
      let loadedBudgets: unknown;
      try {
        const loaded = (
          loadConfig() as AppConfig & {
            max_output_tokens_by_peer?: Record<string, number | undefined>;
          }
        ).max_output_tokens_by_peer;
        loadedBudgets = Object.fromEntries(
          Object.entries(loaded ?? {}).filter(([, value]) => value !== undefined),
        );
      } finally {
        for (const [name, value] of previousBudgetEnv) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }

      const config = offlineConfig({ outputByPeer: { codex: 25_000, claude: 64_000 } });
      const legacyConfig = { ...config } as AppConfig & {
        max_output_tokens_by_peer?: AppConfig["max_output_tokens_by_peer"];
      };
      delete legacyConfig.max_output_tokens_by_peer;
      assert.equal(
        maxOutputTokensForPeer(legacyConfig, "codex"),
        legacyConfig.max_output_tokens,
        "patch releases must accept legacy AppConfig objects without the new per-peer map",
      );
      const openai = new OpenAIAdapter(config);
      let openAIRequest: Record<string, unknown> | undefined;
      Object.defineProperty(openai, "client", {
        configurable: true,
        value: async () => ({
          responses: {
            create: async (body: Record<string, unknown>) => {
              openAIRequest = body;
              return completedResponsesResult(openai.model);
            },
          },
        }),
      });
      await openai.call("fixture", context());

      const anthropic = new AnthropicAdapter(config);
      let anthropicRequest: Record<string, unknown> | undefined;
      Object.defineProperty(anthropic, "client", {
        configurable: true,
        value: async () => ({
          messages: {
            create: async (body: Record<string, unknown>) => {
              anthropicRequest = body;
              return {
                content: [{ type: "text", text: READY }],
                model: anthropic.model,
                stop_reason: "end_turn",
                usage: { input_tokens: 1, output_tokens: 1 },
              };
            },
          },
        }),
      });
      await anthropic.call("fixture", context());

      assert.deepEqual(
        {
          schemaAccepted: parsed.success,
          openAIEnv: flattened.CROSS_REVIEW_OPENAI_MAX_OUTPUT_TOKENS,
          anthropicEnv: flattened.CROSS_REVIEW_ANTHROPIC_MAX_OUTPUT_TOKENS,
          loadedBudgets,
          openAIWire: openAIRequest?.max_output_tokens,
          anthropicWire: anthropicRequest?.max_tokens,
        },
        {
          schemaAccepted: true,
          openAIEnv: "25000",
          anthropicEnv: "64000",
          loadedBudgets: { codex: 25_000, claude: 64_000 },
          openAIWire: 25_000,
          anthropicWire: 64_000,
        },
      );
    },
  },
  {
    name: "OpenAI max_output_tokens performs one billed medium-effort recovery",
    run: async () => {
      const base = offlineConfig({
        outputByPeer: { codex: 25_000 },
        efforts: { codex: "max" },
        retryAttempts: 3,
      });
      const config: AppConfig = {
        ...base,
        cost_rates: {
          ...base.cost_rates,
          codex: { input_per_million: 5, output_per_million: 30 },
        },
      };
      const adapter = new OpenAIAdapter(config);
      const requests: Record<string, unknown>[] = [];
      Object.defineProperty(adapter, "client", {
        configurable: true,
        value: async () => ({
          responses: {
            create: async (body: Record<string, unknown>) => {
              requests.push(body);
              if (requests.length === 1) {
                return {
                  status: "incomplete",
                  incomplete_details: { reason: "max_output_tokens" },
                  output_text: "",
                  model: adapter.model,
                  usage: { input_tokens: 10, output_tokens: 25_000, total_tokens: 25_010 },
                };
              }
              return {
                ...completedResponsesResult(adapter.model),
                usage: { input_tokens: 5, output_tokens: 100, total_tokens: 105 },
              };
            },
          },
        }),
      });

      const result = await adapter.call("fixture", context());
      assert.deepEqual(
        {
          calls: requests.length,
          efforts: requests.map(
            (request) => (request.reasoning as { effort?: unknown } | undefined)?.effort,
          ),
          caps: requests.map((request) => request.max_output_tokens),
          attempts: result.attempts,
          usage: result.usage,
          totalCost:
            result.cost?.total_cost === undefined
              ? undefined
              : Number(result.cost.total_cost.toFixed(6)),
          unpricedAttempts: result.unpriced_attempts,
        },
        {
          calls: 2,
          efforts: ["max", "medium"],
          caps: [25_000, 25_000],
          attempts: 2,
          usage: {
            input_tokens: 15,
            output_tokens: 25_100,
            total_tokens: 25_115,
            reasoning_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
          },
          totalCost: 0.753075,
          unpricedAttempts: undefined,
        },
      );
    },
  },
  {
    name: "OpenAI output recovery stops after one retry and never retries content_filter",
    run: async () => {
      const runCase = async (reasons: string[]): Promise<number> => {
        const adapter = new OpenAIAdapter(
          offlineConfig({
            outputByPeer: { codex: 25_000 },
            efforts: { codex: "max" },
            retryAttempts: 3,
          }),
        );
        let calls = 0;
        Object.defineProperty(adapter, "client", {
          configurable: true,
          value: async () => ({
            responses: {
              create: async () => {
                const reason = reasons[Math.min(calls, reasons.length - 1)];
                calls += 1;
                return {
                  status: "incomplete",
                  incomplete_details: { reason },
                  output_text: "",
                  model: adapter.model,
                  usage: { input_tokens: 1, output_tokens: 25_000, total_tokens: 25_001 },
                };
              },
            },
          }),
        });
        await assert.rejects(() => adapter.call("fixture", context()));
        return calls;
      };

      assert.deepEqual(
        {
          twoLimits: await runCase(["max_output_tokens", "max_output_tokens"]),
          contentFilter: await runCase(["content_filter"]),
          unknownReason: await runCase(["unknown"]),
        },
        { twoLimits: 2, contentFilter: 1, unknownReason: 1 },
      );
    },
  },
  {
    name: "OpenAI streaming recovery discards partial output and retains both attempts",
    run: async () => {
      const base = offlineConfig({
        streamTokens: true,
        outputByPeer: { codex: 25_000 },
        efforts: { codex: "max" },
        retryAttempts: 3,
      });
      const config: AppConfig = {
        ...base,
        streaming: { ...base.streaming, include_text: true },
        cost_rates: {
          ...base.cost_rates,
          codex: { input_per_million: 5, output_per_million: 30 },
        },
      };
      const adapter = new OpenAIAdapter(config);
      const requests: Record<string, unknown>[] = [];
      Object.defineProperty(adapter, "client", {
        configurable: true,
        value: async () => ({
          responses: {
            create: async (body: Record<string, unknown>) => {
              requests.push(body);
              if (requests.length === 1) {
                return (async function* () {
                  yield { type: "response.output_text.delta", delta: "partial" };
                  yield {
                    type: "response.incomplete",
                    response: {
                      status: "incomplete",
                      incomplete_details: { reason: "max_output_tokens" },
                      model: adapter.model,
                      usage: { input_tokens: 10, output_tokens: 25_000, total_tokens: 25_010 },
                    },
                  };
                })();
              }
              return (async function* () {
                yield { type: "response.output_text.delta", delta: READY };
                yield {
                  type: "response.completed",
                  response: {
                    status: "completed",
                    model: adapter.model,
                    usage: { input_tokens: 5, output_tokens: 100, total_tokens: 105 },
                  },
                };
              })();
            },
          },
        }),
      });
      const emitted: Array<{ type: string; data?: Record<string, unknown> }> = [];
      const callContext = {
        ...context(true),
        emit: (event: { type: string; data?: Record<string, unknown> }) => emitted.push(event),
      } as PeerCallContext;
      const previousVerbose = process.env.CROSS_REVIEW_TOKEN_DELTA_VERBOSE;
      process.env.CROSS_REVIEW_TOKEN_DELTA_VERBOSE = "1";
      let result: PeerResult;
      try {
        result = await adapter.call("fixture", callContext);
      } finally {
        if (previousVerbose === undefined) delete process.env.CROSS_REVIEW_TOKEN_DELTA_VERBOSE;
        else process.env.CROSS_REVIEW_TOKEN_DELTA_VERBOSE = previousVerbose;
      }
      const recovery = emitted.find((event) => event.type === "peer.output_limit_recovery.started");
      const staleDelta = emitted.find(
        (event) => event.type === "peer.token.delta" && event.data?.delta === "partial",
      );
      const discarded = emitted.find(
        (event) => event.type === "peer.token.discarded" && event.data?.attempt === 1,
      );
      const completed = emitted.find(
        (event) => event.type === "peer.token.completed" && event.data?.attempt === 2,
      );
      assert.deepEqual(
        {
          calls: requests.length,
          efforts: requests.map(
            (request) => (request.reasoning as { effort?: unknown } | undefined)?.effort,
          ),
          attempts: result.attempts,
          outputTokens: result.usage?.output_tokens,
          discardedPartialChars: recovery?.data?.discarded_partial_chars,
          staleDeltaAttempt: staleDelta?.data?.attempt,
          staleDeltaProvisional: staleDelta?.data?.provisional,
          discardedAttempt: discarded?.data?.attempt,
          completedAttempt: completed?.data?.attempt,
        },
        {
          calls: 2,
          efforts: ["max", "medium"],
          attempts: 2,
          outputTokens: 25_100,
          discardedPartialChars: 7,
          staleDeltaAttempt: 1,
          staleDeltaProvisional: true,
          discardedAttempt: 1,
          completedAttempt: 2,
        },
      );
    },
  },
  {
    name: "OpenAI recovery preserves prior billing across later network failure and cancellation",
    run: async () => {
      const makeConfig = (retryAttempts: number): AppConfig => {
        const base = offlineConfig({
          outputByPeer: { codex: 25_000 },
          efforts: { codex: "max" },
          retryAttempts,
        });
        return {
          ...base,
          cost_rates: {
            ...base.cost_rates,
            codex: { input_per_million: 5, output_per_million: 30 },
          },
        };
      };

      const networkAdapter = new OpenAIAdapter(makeConfig(2));
      let networkCalls = 0;
      Object.defineProperty(networkAdapter, "client", {
        configurable: true,
        value: async () => ({
          responses: {
            create: async () => {
              networkCalls += 1;
              if (networkCalls === 1) {
                return {
                  status: "incomplete",
                  incomplete_details: { reason: "max_output_tokens" },
                  model: networkAdapter.model,
                  usage: { input_tokens: 10, output_tokens: 25_000, total_tokens: 25_010 },
                };
              }
              throw new Error("fetch failed");
            },
          },
        }),
      });
      let networkFailure:
        | {
            usage?: { output_tokens?: number };
            cost?: { total_cost?: number };
            unpriced_attempts?: number;
          }
        | undefined;
      try {
        await networkAdapter.call("fixture", context());
      } catch (error) {
        networkFailure = (
          error as {
            peerFailure?: {
              usage?: { output_tokens?: number };
              cost?: { total_cost?: number };
              unpriced_attempts?: number;
            };
          }
        ).peerFailure;
      }

      const controller = new AbortController();
      const cancelledAdapter = new OpenAIAdapter(makeConfig(3));
      let cancelledCalls = 0;
      Object.defineProperty(cancelledAdapter, "client", {
        configurable: true,
        value: async () => ({
          responses: {
            create: async () => {
              cancelledCalls += 1;
              if (cancelledCalls === 1) {
                return {
                  status: "incomplete",
                  incomplete_details: { reason: "max_output_tokens" },
                  model: cancelledAdapter.model,
                  usage: { input_tokens: 10, output_tokens: 25_000, total_tokens: 25_010 },
                };
              }
              controller.abort("cancel after provider settlement");
              return {
                ...completedResponsesResult(cancelledAdapter.model),
                usage: { input_tokens: 5, output_tokens: 100, total_tokens: 105 },
              };
            },
          },
        }),
      });
      let cancelledFailure:
        | {
            failure_class?: string;
            usage?: { output_tokens?: number };
            cost?: { total_cost?: number };
            unpriced_attempts?: number;
          }
        | undefined;
      try {
        await cancelledAdapter.call("fixture", { ...context(), signal: controller.signal });
      } catch (error) {
        cancelledFailure = (
          error as {
            peerFailure?: {
              failure_class?: string;
              usage?: { output_tokens?: number };
              cost?: { total_cost?: number };
              unpriced_attempts?: number;
            };
          }
        ).peerFailure;
      }

      assert.deepEqual(
        {
          network: {
            calls: networkCalls,
            outputTokens: networkFailure?.usage?.output_tokens,
            totalCost: networkFailure?.cost?.total_cost,
            unpricedAttempts: networkFailure?.unpriced_attempts,
          },
          cancelled: {
            calls: cancelledCalls,
            failureClass: cancelledFailure?.failure_class,
            outputTokens: cancelledFailure?.usage?.output_tokens,
            totalCost:
              cancelledFailure?.cost?.total_cost === undefined
                ? undefined
                : Number(cancelledFailure.cost.total_cost.toFixed(6)),
            unpricedAttempts: cancelledFailure?.unpriced_attempts,
          },
        },
        {
          network: {
            calls: 2,
            outputTokens: 25_000,
            totalCost: 0.75005,
            unpricedAttempts: 1,
          },
          cancelled: {
            calls: 2,
            failureClass: "cancelled",
            outputTokens: 25_100,
            totalCost: 0.753075,
            unpricedAttempts: undefined,
          },
        },
      );
    },
  },
  {
    name: "Gemini MAX_TOKENS recovers once and bills visible plus thinking output",
    run: async () => {
      const base = offlineConfig({
        outputByPeer: { gemini: 20_000 },
        efforts: { gemini: "high" },
        retryAttempts: 3,
      });
      const config: AppConfig = {
        ...base,
        cost_rates: {
          ...base.cost_rates,
          gemini: { input_per_million: 2, output_per_million: 12 },
        },
      };
      const adapter = new GeminiAdapter(config);
      const requests: Record<string, unknown>[] = [];
      Object.defineProperty(adapter, "client", {
        configurable: true,
        value: async () => ({
          ThinkingLevel: { LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH" },
          ai: {
            models: {
              generateContent: async (body: Record<string, unknown>) => {
                requests.push(body);
                if (requests.length === 1) {
                  return {
                    text: "partial",
                    modelVersion: adapter.model,
                    candidates: [{ index: 0, finishReason: "MAX_TOKENS" }],
                    usageMetadata: {
                      promptTokenCount: 10,
                      candidatesTokenCount: 20_000,
                      thoughtsTokenCount: 100,
                      totalTokenCount: 20_110,
                    },
                  };
                }
                return {
                  text: READY,
                  modelVersion: adapter.model,
                  candidates: [{ index: 0, finishReason: "STOP" }],
                  usageMetadata: {
                    promptTokenCount: 5,
                    candidatesTokenCount: 5,
                    thoughtsTokenCount: 20,
                    totalTokenCount: 30,
                  },
                };
              },
            },
          },
        }),
      });

      const result = await adapter.call("fixture", context());
      assert.deepEqual(
        {
          calls: requests.length,
          levels: requests.map(
            (request) =>
              (request.config as { thinkingConfig?: { thinkingLevel?: unknown } } | undefined)
                ?.thinkingConfig?.thinkingLevel,
          ),
          attempts: result.attempts,
          usage: result.usage,
          unpricedAttempts: result.unpriced_attempts,
        },
        {
          calls: 2,
          levels: ["HIGH", "MEDIUM"],
          attempts: 2,
          usage: {
            input_tokens: 15,
            output_tokens: 20_125,
            total_tokens: 20_140,
            reasoning_tokens: 120,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
          },
          unpricedAttempts: undefined,
        },
      );
    },
  },
  {
    name: "Gemini streaming MAX_TOKENS discards the partial attempt before recovery",
    run: async () => {
      const base = offlineConfig({
        streamTokens: true,
        outputByPeer: { gemini: 20_000 },
        efforts: { gemini: "high" },
        retryAttempts: 3,
      });
      const config: AppConfig = {
        ...base,
        streaming: { ...base.streaming, include_text: true },
        cost_rates: {
          ...base.cost_rates,
          gemini: { input_per_million: 2, output_per_million: 12 },
        },
      };
      const adapter = new GeminiAdapter(config);
      const requests: Record<string, unknown>[] = [];
      Object.defineProperty(adapter, "client", {
        configurable: true,
        value: async () => ({
          ThinkingLevel: { LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH" },
          ai: {
            models: {
              generateContentStream: async (body: Record<string, unknown>) => {
                requests.push(body);
                if (requests.length === 1) {
                  return (async function* () {
                    yield { text: "partial", modelVersion: adapter.model, candidates: [{}] };
                    yield {
                      text: "",
                      modelVersion: adapter.model,
                      candidates: [{ index: 0, finishReason: "MAX_TOKENS" }],
                      usageMetadata: {
                        promptTokenCount: 10,
                        candidatesTokenCount: 20_000,
                        thoughtsTokenCount: 100,
                        totalTokenCount: 20_110,
                      },
                    };
                  })();
                }
                return (async function* () {
                  yield {
                    text: READY,
                    modelVersion: adapter.model,
                    candidates: [{ index: 0, finishReason: "STOP" }],
                    usageMetadata: {
                      promptTokenCount: 5,
                      candidatesTokenCount: 5,
                      thoughtsTokenCount: 20,
                      totalTokenCount: 30,
                    },
                  };
                })();
              },
            },
          },
        }),
      });
      const emitted: Array<{ type: string; data?: Record<string, unknown> }> = [];
      const callContext = {
        ...context(true),
        emit: (event: { type: string; data?: Record<string, unknown> }) => emitted.push(event),
      } as PeerCallContext;
      const previousVerbose = process.env.CROSS_REVIEW_TOKEN_DELTA_VERBOSE;
      const previousMs = process.env.CROSS_REVIEW_TOKEN_DELTA_MS_THRESHOLD;
      process.env.CROSS_REVIEW_TOKEN_DELTA_VERBOSE = "0";
      process.env.CROSS_REVIEW_TOKEN_DELTA_MS_THRESHOLD = "5";
      let result: PeerResult;
      try {
        result = await adapter.call("fixture", callContext);
        await new Promise((resolve) => setTimeout(resolve, 20));
      } finally {
        if (previousVerbose === undefined) delete process.env.CROSS_REVIEW_TOKEN_DELTA_VERBOSE;
        else process.env.CROSS_REVIEW_TOKEN_DELTA_VERBOSE = previousVerbose;
        if (previousMs === undefined) delete process.env.CROSS_REVIEW_TOKEN_DELTA_MS_THRESHOLD;
        else process.env.CROSS_REVIEW_TOKEN_DELTA_MS_THRESHOLD = previousMs;
      }
      const recovery = emitted.find((event) => event.type === "peer.output_limit_recovery.started");
      const firstAttemptDeltas = emitted.filter(
        (event) => event.type === "peer.token.delta" && event.data?.attempt === 1,
      );
      const discarded = emitted.find(
        (event) => event.type === "peer.token.discarded" && event.data?.attempt === 1,
      );
      const completed = emitted.find(
        (event) => event.type === "peer.token.completed" && event.data?.attempt === 2,
      );
      assert.deepEqual(
        {
          calls: requests.length,
          levels: requests.map(
            (request) =>
              (request.config as { thinkingConfig?: { thinkingLevel?: unknown } } | undefined)
                ?.thinkingConfig?.thinkingLevel,
          ),
          attempts: result.attempts,
          outputTokens: result.usage?.output_tokens,
          discardedPartialChars: recovery?.data?.discarded_partial_chars,
          firstAttemptDeltaCount: firstAttemptDeltas.length,
          discardedAttempt: discarded?.data?.attempt,
          completedAttempt: completed?.data?.attempt,
        },
        {
          calls: 2,
          levels: ["HIGH", "MEDIUM"],
          attempts: 2,
          outputTokens: 20_125,
          discardedPartialChars: 7,
          firstAttemptDeltaCount: 0,
          discardedAttempt: 1,
          completedAttempt: 2,
        },
      );
    },
  },
  {
    name: "output filtering terminals never enter orchestrator moderation recovery",
    run: async () => {
      const cases = [
        {
          peer: "codex" as const,
          reject: (callContext: PeerCallContext): void =>
            assertResponsesCompletion(
              {
                status: "incomplete",
                incomplete_details: { reason: "content_filter" },
              } as { status?: unknown },
              {
                context: callContext,
                peer: "codex",
                provider: "openai",
                model: "gpt-5.6-sol",
                phase: "review",
              },
            ),
        },
        {
          peer: "gemini" as const,
          reject: (callContext: PeerCallContext): void =>
            assertGeminiCompletion(
              {
                candidates: [{ finishReason: "SAFETY" }],
              },
              {
                context: callContext,
                peer: "gemini",
                provider: "google",
                model: "gemini-3.1-pro-preview",
                phase: "review",
              },
            ),
        },
        {
          peer: "perplexity" as const,
          reject: (callContext: PeerCallContext): void =>
            assertResponsesCompletion(
              {
                status: "incomplete",
                incomplete_details: { reason: "content_filter" },
              } as { status?: unknown },
              {
                context: callContext,
                peer: "perplexity",
                provider: "perplexity",
                model: "perplexity/kimi-k3",
                phase: "review",
              },
            ),
        },
      ];
      const observed: Record<string, { calls: number; failureClass?: string }> = {};
      for (const testCase of cases) {
        const dataDir = fs.mkdtempSync(
          path.join(os.tmpdir(), `cross-review-safety-${testCase.peer}-`),
        );
        try {
          const base = offlineConfig({ retryAttempts: 3 });
          const config: AppConfig = {
            ...base,
            data_dir: dataDir,
            stub: false,
            evidence_preflight_enabled: false,
            truthfulness_preflight_enabled: false,
            budget: {
              ...base.budget,
              max_session_cost_usd: 10_000,
              preflight_max_round_cost_usd: 10_000,
            },
          };
          const orchestrator = new CrossReviewOrchestrator(config);
          const adapter = new StubAdapter(config, testCase.peer);
          const fallbackCall = adapter.call.bind(adapter);
          let calls = 0;
          adapter.call = async (prompt, callContext) => {
            calls += 1;
            if (calls === 1) testCase.reject(callContext);
            return fallbackCall(prompt, callContext);
          };
          const session = await orchestrator.store.init(
            "Safety terminal must fail closed.",
            "operator",
            [],
          );
          const callContext = {
            ...context(),
            session_id: session.session_id,
            task: "Safety terminal must fail closed.",
          };
          const outcome = await (
            orchestrator as unknown as {
              callPeerForReview(
                selectedAdapter: StubAdapter,
                prompt: string,
                moderationSafePrompt: string,
                selectedContext: PeerCallContext,
              ): Promise<{ failure?: { failure_class: string } }>;
            }
          ).callPeerForReview(adapter, "Review this fixture.", "Sanitized fixture.", callContext);
          observed[testCase.peer] = {
            calls,
            failureClass: outcome.failure?.failure_class ?? "missing",
          };
        } finally {
          fs.rmSync(dataDir, { recursive: true, force: true });
        }
      }
      assert.deepEqual(observed, {
        codex: { calls: 1, failureClass: "provider_error" },
        gemini: { calls: 1, failureClass: "provider_error" },
        perplexity: { calls: 1, failureClass: "provider_error" },
      });

      for (const unspecified of ["BLOCK_REASON_UNSPECIFIED", "BLOCKED_REASON_UNSPECIFIED"]) {
        assert.doesNotThrow(() =>
          assertGeminiCompletion(
            {
              promptFeedback: { blockReason: unspecified },
              candidates: [{ finishReason: "STOP" }],
            },
            {
              context: context(),
              peer: "gemini",
              provider: "google",
              model: "gemini-3.1-pro-preview",
              phase: "review",
            },
          ),
        );
      }

      const promptBlockRecovery: Record<
        string,
        {
          calls: number;
          recovered: boolean;
          parserWarning: boolean;
          promptsDiffer: boolean;
          inputTokens: number;
          outputTokens: number;
          totalCost: number;
          blockedAgainCalls: number;
        }
      > = {};
      for (const streaming of [false, true]) {
        const mode = streaming ? "stream" : "nonstream";
        const dataDir = fs.mkdtempSync(
          path.join(os.tmpdir(), `cross-review-gemini-prompt-block-${mode}-`),
        );
        try {
          const base = offlineConfig({ retryAttempts: 3 });
          const config: AppConfig = {
            ...base,
            data_dir: dataDir,
            stub: false,
            evidence_preflight_enabled: false,
            truthfulness_preflight_enabled: false,
            budget: {
              ...base.budget,
              max_session_cost_usd: 10_000,
              preflight_max_round_cost_usd: 10_000,
            },
            cost_rates: {
              ...base.cost_rates,
              gemini: { input_per_million: 1, output_per_million: 1 },
            },
          };
          const orchestrator = new CrossReviewOrchestrator(config);
          const adapter = new GeminiAdapter(config);
          const prompts: string[] = [];
          let calls = 0;
          const responseFor = (body: Record<string, unknown>) => {
            calls += 1;
            prompts.push(String(body.contents ?? ""));
            if (calls === 1) {
              return {
                promptFeedback: { blockReason: "SAFETY" },
                candidates: [],
                modelVersion: adapter.model,
                usageMetadata: { promptTokenCount: 10, totalTokenCount: 10 },
              };
            }
            return {
              text: READY,
              candidates: [{ index: 0, finishReason: "STOP" }],
              modelVersion: adapter.model,
              usageMetadata: {
                promptTokenCount: 5,
                candidatesTokenCount: 5,
                totalTokenCount: 10,
              },
            };
          };
          Object.defineProperty(adapter, "client", {
            configurable: true,
            value: async () => ({
              ThinkingLevel: { LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH" },
              ai: {
                models: {
                  generateContent: async (body: Record<string, unknown>) => responseFor(body),
                  generateContentStream: async (body: Record<string, unknown>) => {
                    const response = responseFor(body);
                    return (async function* () {
                      yield response;
                    })();
                  },
                },
              },
            }),
          });
          const session = await orchestrator.store.init(
            "Gemini prompt block must use sanitized recovery.",
            "operator",
            [],
          );
          const callContext = {
            ...context(streaming),
            session_id: session.session_id,
            task: "Gemini prompt block must use sanitized recovery.",
          };
          const outcome = await (
            orchestrator as unknown as {
              callPeerForReview(
                selectedAdapter: GeminiAdapter,
                prompt: string,
                moderationSafePrompt: string,
                selectedContext: PeerCallContext,
              ): Promise<{ result?: PeerResult; failure?: { failure_class: string } }>;
            }
          ).callPeerForReview(
            adapter,
            "Review the original fixture.",
            "Review the sanitized fixture.",
            callContext,
          );
          assert.ok(outcome.result, `Gemini ${mode} prompt-block recovery must return a result`);
          assert.ok(outcome.result.cost, `Gemini ${mode} recovery must retain billed attempts`);
          promptBlockRecovery[mode] = {
            calls,
            recovered: !outcome.failure,
            parserWarning: outcome.result.parser_warnings.includes(
              "moderation_safe_retry_succeeded",
            ),
            promptsDiffer: prompts.length === 2 && prompts[0] !== prompts[1],
            inputTokens: outcome.result.usage?.input_tokens ?? -1,
            outputTokens: outcome.result.usage?.output_tokens ?? -1,
            totalCost: outcome.result.cost.total_cost ?? -1,
            blockedAgainCalls: 0,
          };

          const blockedAgainAdapter = new GeminiAdapter(config);
          let blockedAgainCalls = 0;
          Object.defineProperty(blockedAgainAdapter, "client", {
            configurable: true,
            value: async () => ({
              ThinkingLevel: { LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH" },
              ai: {
                models: {
                  generateContent: async () => {
                    blockedAgainCalls += 1;
                    return {
                      promptFeedback: { blockReason: "SAFETY" },
                      candidates: [],
                      modelVersion: blockedAgainAdapter.model,
                      usageMetadata: { promptTokenCount: 1, totalTokenCount: 1 },
                    };
                  },
                  generateContentStream: async () => {
                    blockedAgainCalls += 1;
                    return (async function* () {
                      yield {
                        promptFeedback: { blockReason: "SAFETY" },
                        candidates: [],
                        modelVersion: blockedAgainAdapter.model,
                        usageMetadata: { promptTokenCount: 1, totalTokenCount: 1 },
                      };
                    })();
                  },
                },
              },
            }),
          });
          const blockedAgain = await (
            orchestrator as unknown as {
              callPeerForReview(
                selectedAdapter: GeminiAdapter,
                prompt: string,
                moderationSafePrompt: string,
                selectedContext: PeerCallContext,
              ): Promise<{ result?: PeerResult; failure?: { failure_class: string } }>;
            }
          ).callPeerForReview(
            blockedAgainAdapter,
            "Review the original fixture.",
            "Review the compact context-reduced fixture.",
            callContext,
          );
          assert.equal(blockedAgain.result, undefined);
          assert.equal(blockedAgain.failure?.failure_class, "prompt_flagged_by_moderation");
          const recoveredMode = promptBlockRecovery[mode];
          assert.ok(recoveredMode, `missing ${mode} prompt-block recovery record`);
          recoveredMode.blockedAgainCalls = blockedAgainCalls;
        } finally {
          fs.rmSync(dataDir, { recursive: true, force: true });
        }
      }
      assert.deepEqual(promptBlockRecovery, {
        nonstream: {
          calls: 2,
          recovered: true,
          parserWarning: true,
          promptsDiffer: true,
          inputTokens: 15,
          outputTokens: 5,
          totalCost: 0.00002,
          blockedAgainCalls: 2,
        },
        stream: {
          calls: 2,
          recovered: true,
          parserWarning: true,
          promptsDiffer: true,
          inputTokens: 15,
          outputTokens: 5,
          totalCost: 0.00002,
          blockedAgainCalls: 2,
        },
      });
    },
  },
  {
    name: "Perplexity prices only Agent API dimensions; retired Sonar ids fail closed",
    run: async () => {
      const base = offlineConfig();
      // CROSREV-19 (#233): the legacy Sonar dimensions are deprecated members
      // of CostRateConfig / TokenUsage / CostEstimate through 4.x (PR #293
      // review). The fixtures below prove the runtime never PRICES or READS
      // them (each assertion was red before the removal: the fee was priced,
      // the env read) while the aggregation helpers keep passing them through
      // for sessions persisted by v3.0–v4.6.8.
      const legacyReasoningCard = {
        input_per_million: 2,
        output_per_million: 8,
        request_fee_low_per_1000: 6,
      } as unknown as CostRateConfig;
      const legacyDeepResearchCard = {
        input_per_million: 2,
        output_per_million: 8,
        citation_tokens_per_million: 2,
        deep_research_reasoning_tokens_per_million: 3,
        search_queries_per_1000: 5,
      } as unknown as CostRateConfig;
      const legacySonarCard = {
        input_per_million: 1,
        output_per_million: 1,
        request_fee_low_per_1000: 5,
      } as unknown as CostRateConfig;
      const LEGACY_COST_KEYS = [
        "request_cost",
        "citation_tokens_cost",
        "deep_research_reasoning_tokens_cost",
      ];
      const legacyKeysOn = (value: object): string[] =>
        Object.keys(value).filter((key) => LEGACY_COST_KEYS.includes(key));
      const LEGACY_DIMENSION_PATTERN =
        /request_fee|citation_tokens|deep_research|REQUEST_FEE|CITATION_TOKENS|DEEP_RESEARCH/;

      // Sonar-pinned fixture: the primary is a retired id and every legacy
      // card is retained, exactly like a central config that predates the
      // Agent API migration.
      const modelAwareConfig = {
        ...base,
        models: { ...base.models, perplexity: "sonar-reasoning-pro" },
        cost_rates: { ...base.cost_rates, perplexity: legacyReasoningCard },
        model_cost_rates: {
          perplexity: {
            sonar: legacySonarCard,
            "sonar-reasoning-pro": legacyReasoningCard,
            "sonar-deep-research": legacyDeepResearchCard,
          },
        },
      } as AppConfig;

      // (1) estimateCost prices tokens only. A retained Sonar card's
      // per-request fee (5 per 1000 requests on the low tier) is never
      // added — before the removal this call returned 2.005 with
      // request_cost 0.005.
      const sonarOverride = estimateCost(
        modelAwareConfig,
        "perplexity",
        { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        "sonar",
      );
      assert.deepEqual(
        { total: sonarOverride.total_cost, legacyKeys: legacyKeysOn(sonarOverride) },
        { total: 2, legacyKeys: [] },
        "a retained Sonar card must price tokens only — no per-request fee line item",
      );
      // The Deep Research card's citation / reasoning / search dimensions
      // are ignored as well (before: 20 = 2 + 8 + 2 + 3 + 5; now the two
      // token rates only). A retired id is not an Agent API model, so the
      // web_search fee does not apply either.
      const legacyUsage = {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        citation_tokens: 1_000_000,
        reasoning_tokens: 1_000_000,
        num_search_queries: 1_000,
      } as unknown as TokenUsage;
      const deepResearchOverride = estimateCost(
        modelAwareConfig,
        "perplexity",
        legacyUsage,
        "sonar-deep-research",
      );
      assert.deepEqual(
        {
          total: deepResearchOverride.total_cost,
          searches: deepResearchOverride.search_queries_cost,
          legacyKeys: legacyKeysOn(deepResearchOverride),
        },
        { total: 10, searches: undefined, legacyKeys: [] },
        "Deep Research dimensions must not be priced any more",
      );
      // Primary Sonar pin with every legacy counter in usage: tokens only
      // (100 × 2 + 200 × 8 per million = 0.0018; before: 0.0078 with the
      // 0.006 request fee).
      const reasoningPro = estimateCost(modelAwareConfig, "perplexity", {
        input_tokens: 100,
        output_tokens: 200,
        reasoning_tokens: 50,
        citation_tokens: 20,
        num_search_queries: 3,
        search_performed: true,
      } as unknown as TokenUsage);
      assert.ok(
        Math.abs((reasoningPro.total_cost ?? 0) - 0.0018) < 1e-12,
        `Sonar primary must price tokens only: ${reasoningPro.total_cost}`,
      );
      assert.deepEqual(
        { legacyKeys: legacyKeysOn(reasoningPro), searches: reasoningPro.search_queries_cost },
        { legacyKeys: [], searches: undefined },
      );
      const unknownOverride = estimateCost(
        modelAwareConfig,
        "perplexity",
        { input_tokens: 1, output_tokens: 1 },
        "sonar-unknown",
      );
      assert.deepEqual(
        { estimated: unknownOverride.estimated, source: unknownOverride.source },
        { estimated: false, source: "unknown-rate" },
      );

      // (2) mergeCost never produces the deprecated line items, but a session
      // persisted by v3.0–v4.6.8 still carries them: they keep being re-summed
      // through 4.x (PR #293 review) next to the stored total_cost, so
      // historical breakdowns do not change inside a patch update.
      const legacyEstimate = {
        currency: "USD",
        input_cost: 1,
        output_cost: 1,
        total_cost: 3,
        estimated: true,
        source: "configured-rate",
        request_cost: 1,
        citation_tokens_cost: 1,
        deep_research_reasoning_tokens_cost: 1,
        search_queries_cost: 0.5,
      } as unknown as CostEstimate;
      const mergedLegacy = mergeCost([legacyEstimate, legacyEstimate]);
      assert.deepEqual(
        {
          total: mergedLegacy.total_cost,
          searches: mergedLegacy.search_queries_cost,
          legacyKeys: legacyKeysOn(mergedLegacy),
          request: mergedLegacy.request_cost,
          citations: mergedLegacy.citation_tokens_cost,
          reasoning: mergedLegacy.deep_research_reasoning_tokens_cost,
        },
        {
          total: 6,
          searches: 1,
          legacyKeys: LEGACY_COST_KEYS,
          request: 2,
          citations: 2,
          reasoning: 2,
        },
        "mergeCost must keep stored totals and re-sum the deprecated Sonar line items through 4.x",
      );
      const mergedFresh = mergeCost([
        { currency: "USD", total_cost: 1, estimated: true, source: "configured-rate" },
        { currency: "USD", total_cost: 2, estimated: true, source: "configured-rate" },
      ]);
      assert.deepEqual(
        { total: mergedFresh.total_cost, legacyKeys: legacyKeysOn(mergedFresh) },
        { total: 3, legacyKeys: [] },
        "mergeCost must not invent the deprecated line items",
      );

      // (2b) The shipped declarations keep the deprecated members through 4.x
      // (PR #293 review): these literals must compile WITHOUT a cast, and a
      // consumer of dist/src/core/types.d.ts sees the same members.
      const declaredLegacyUsage: TokenUsage = { citation_tokens: 1 };
      const declaredLegacyCost: CostEstimate = {
        currency: "USD",
        estimated: true,
        source: "configured-rate",
        request_cost: 1,
        citation_tokens_cost: 1,
        deep_research_reasoning_tokens_cost: 1,
      };
      const declaredLegacyCard: CostRateConfig = {
        input_per_million: 1,
        output_per_million: 1,
        request_fee_low_per_1000: 1,
        request_fee_medium_per_1000: 1,
        request_fee_high_per_1000: 1,
        citation_tokens_per_million: 1,
        deep_research_reasoning_tokens_per_million: 1,
      };
      assert.deepEqual(
        [
          Object.keys(declaredLegacyUsage),
          legacyKeysOn(declaredLegacyCost),
          Object.keys(declaredLegacyCard).filter((key) => LEGACY_DIMENSION_PATTERN.test(key))
            .length,
        ],
        [["citation_tokens"], LEGACY_COST_KEYS, 5],
        "the deprecated members must remain declared through 4.x",
      );

      // (3) mergeUsage keeps re-summing the deprecated citation_tokens counter
      // (PR #293 review) and keeps the search semantics; a merge without it
      // does not invent the key.
      const mergedSonarUsage = mergeUsage([
        {
          citation_tokens: 3,
          num_search_queries: 2,
          search_performed: true,
        } as unknown as TokenUsage,
        {
          citation_tokens: 4,
          num_search_queries: 5,
          search_performed: false,
        } as unknown as TokenUsage,
      ]);
      assert.deepEqual(
        {
          citationTokens: mergedSonarUsage.citation_tokens,
          searchQueries: mergedSonarUsage.num_search_queries,
          searchPerformed: mergedSonarUsage.search_performed,
        },
        { citationTokens: 7, searchQueries: 7, searchPerformed: true },
        "mergeUsage must re-sum the deprecated citation_tokens counter through 4.x",
      );
      assert.equal(
        "citation_tokens" in mergeUsage([{ num_search_queries: 1 }, { input_tokens: 2 }]),
        false,
        "mergeUsage must not invent citation_tokens",
      );

      // (4) missingFinancialControlVars: a retired primary or fallback pin
      // reports the migration marker and nothing else about Sonar — no
      // request-fee, citation, reasoning or DEEP_RESEARCH_PREFLIGHT items,
      // even with the complete legacy cards retained.
      const retiredPinsConfig = {
        ...modelAwareConfig,
        models: { ...modelAwareConfig.models, perplexity: "sonar-deep-research" },
        cost_rates: { ...modelAwareConfig.cost_rates, perplexity: legacyDeepResearchCard },
        fallback_models: { ...modelAwareConfig.fallback_models, perplexity: ["sonar"] },
      } as AppConfig;
      const retiredPinsMissing = missingFinancialControlVars(retiredPinsConfig, ["perplexity"]);
      assert.ok(
        retiredPinsMissing.includes("CROSS_REVIEW_PERPLEXITY_MODEL_SONAR_RETIRED_USE_AGENT_API_ID"),
        `retired pins must report the migration marker: ${retiredPinsMissing.join(",")}`,
      );
      assert.deepEqual(
        retiredPinsMissing.filter((item) => LEGACY_DIMENSION_PATTERN.test(item)),
        [],
        `no legacy Sonar dimension may be demanded any more: ${retiredPinsMissing.join(",")}`,
      );

      // (5) The legacy env suffixes are no longer read into the Perplexity
      // rate card (before: costRate() copied every one of them).
      const legacyEnvNames = [
        "CROSS_REVIEW_PERPLEXITY_REQUEST_FEE_LOW_USD_PER_1000_REQUESTS",
        "CROSS_REVIEW_PERPLEXITY_REQUEST_FEE_MEDIUM_USD_PER_1000_REQUESTS",
        "CROSS_REVIEW_PERPLEXITY_REQUEST_FEE_HIGH_USD_PER_1000_REQUESTS",
        "CROSS_REVIEW_PERPLEXITY_CITATION_TOKENS_USD_PER_MILLION",
        "CROSS_REVIEW_PERPLEXITY_DEEP_RESEARCH_REASONING_TOKENS_USD_PER_MILLION",
      ];
      const rateEnvNames = [
        ...legacyEnvNames,
        "CROSS_REVIEW_PERPLEXITY_INPUT_USD_PER_MILLION",
        "CROSS_REVIEW_PERPLEXITY_OUTPUT_USD_PER_MILLION",
        "CROSS_REVIEW_PERPLEXITY_SEARCH_QUERIES_USD_PER_1000_REQUESTS",
      ];
      const previousRateEnv = Object.fromEntries(
        rateEnvNames.map((name) => [name, process.env[name]]),
      );
      try {
        for (const name of rateEnvNames) process.env[name] = "1";
        const envCard = loadConfig().cost_rates.perplexity;
        assert.ok(envCard, "INPUT/OUTPUT env must still build the Perplexity card");
        assert.deepEqual(
          {
            input: envCard.input_per_million,
            output: envCard.output_per_million,
            searches: envCard.search_queries_per_1000,
            legacyKeys: Object.keys(envCard).filter((key) => LEGACY_DIMENSION_PATTERN.test(key)),
          },
          { input: 1, output: 1, searches: 1, legacyKeys: [] },
          `legacy env suffixes must be ignored: ${Object.keys(envCard).join(",")}`,
        );
      } finally {
        for (const name of rateEnvNames) {
          const previous = previousRateEnv[name];
          if (previous === undefined) delete process.env[name];
          else process.env[name] = previous;
        }
      }

      // (6) Central config (PR #293 review, SemVer): the five deprecated Sonar
      // keys stay ACCEPTED by the strict schema throughout 4.x — a file valid
      // under 4.6.8 must not be rejected by a patch update. applyFileConfigToEnv
      // strips them before the card is flattened or retained and names each
      // one with its card path; any other unknown key is still rejected in
      // full. Before this fix every "tolerated" assertion below was red: the
      // file came back applied=false with zod's unrecognized_keys issue.
      const legacyDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-crosrev-19-"));
      const crossReviewEnvSnapshot = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name.startsWith("CROSS_REVIEW_")),
      );
      const crossReviewEnvNames = (): string[] =>
        Object.keys(process.env).filter((name) => name.startsWith("CROSS_REVIEW_"));
      try {
        // A tolerated file DOES write flattened values into process.env, so
        // start from a bare CROSS_REVIEW_* environment (data dir only) and
        // restore the host state afterwards.
        for (const name of crossReviewEnvNames()) {
          if (name !== "CROSS_REVIEW_DATA_DIR") delete process.env[name];
        }
        const configPath = path.join(legacyDataDir, "config.json");
        const writeCentralConfig = (config: unknown): void => {
          fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
        };
        const readEnvExceptOverride = (name: string): string | undefined =>
          name === "CROSS_REVIEW_CONFIG_FILE" ? undefined : process.env[name];
        const legacyEnvNamesPresent = (): string[] =>
          crossReviewEnvNames().filter((name) => LEGACY_DIMENSION_PATTERN.test(name));
        writeCentralConfig({
          model_cost_rates: {
            perplexity: {
              "sonar-reasoning-pro": {
                input_per_million: 1,
                output_per_million: 1,
                request_fee_low_per_1000: 5,
              },
            },
          },
        });
        const toleratedModelCard = applyFileConfigToEnv(legacyDataDir, readEnvExceptOverride);
        assert.deepEqual(
          {
            applied: toleratedModelCard.applied,
            parseError: toleratedModelCard.parse_error,
            ignored: toleratedModelCard.deprecated_keys_ignored,
            card: toleratedModelCard.model_cost_rates?.perplexity?.["sonar-reasoning-pro"],
          },
          {
            applied: true,
            parseError: undefined,
            ignored: [
              'model_cost_rates.perplexity["sonar-reasoning-pro"].request_fee_low_per_1000',
            ],
            card: { input_per_million: 1, output_per_million: 1 },
          },
          "a deprecated key on a model card must be tolerated, stripped and named with its path",
        );
        writeCentralConfig({
          cost_rates: {
            perplexity: {
              input_per_million: 1,
              output_per_million: 1,
              citation_tokens_per_million: 2,
            },
          },
        });
        const toleratedPrimaryCard = applyFileConfigToEnv(legacyDataDir, readEnvExceptOverride);
        assert.deepEqual(
          {
            applied: toleratedPrimaryCard.applied,
            ignored: toleratedPrimaryCard.deprecated_keys_ignored,
            legacyEnv: legacyEnvNamesPresent(),
          },
          {
            applied: true,
            ignored: ["cost_rates.perplexity.citation_tokens_per_million"],
            legacyEnv: [],
          },
          "a deprecated key on the primary card must be tolerated and never flattened to env",
        );
        // Only the five deprecated keys are tolerated: a genuinely unknown key
        // still rejects the whole file with the schema-invalid diagnostic.
        const kimiCard = {
          input_per_million: 3,
          output_per_million: 15,
          cache_read_per_million: 0.3,
          search_queries_per_1000: 2.5,
        };
        writeCentralConfig({
          model_cost_rates: {
            perplexity: { "perplexity/kimi-k3": { ...kimiCard, search_fee_per_1000: 2.5 } },
          },
        });
        const rejectedUnknownKey = applyFileConfigToEnv(legacyDataDir, readEnvExceptOverride);
        assert.equal(rejectedUnknownKey.applied, false, "an unknown card key must be rejected");
        for (const fragment of [
          "schema_validation_failed:",
          "unrecognized_keys",
          "search_fee_per_1000",
          "model_cost_rates",
          "perplexity",
          "perplexity/kimi-k3",
        ]) {
          assert.ok(
            rejectedUnknownKey.parse_error?.includes(fragment),
            `parse_error must name ${fragment}: ${rejectedUnknownKey.parse_error}`,
          );
        }
        assert.equal(
          rejectedUnknownKey.deprecated_keys_ignored,
          undefined,
          "a rejected file reports no ignored deprecated keys",
        );

        // (7) End to end on the operator surface: CROSS_REVIEW_CONFIG_FILE →
        // loadConfig() → missingFinancialControlVars / server_info config_load
        // / boot notices. The operator's real 4.6.8 file shape — an Agent API
        // pin plus the two retained Sonar cards carrying every deprecated key —
        // applies in full: no CROSS_REVIEW_CONFIG_FILE_INVALID, the deprecated
        // keys reach neither the loaded cards nor the env, and the deprecation
        // boot notice names each of them with its path. A genuinely unknown
        // key still fails closed with the schema-invalid boot notice.
        const legacyCentralConfig = {
          models: { perplexity: "perplexity/kimi-k3" },
          budget: { default_max_rounds: 4 },
          model_cost_rates: {
            perplexity: {
              "perplexity/kimi-k3": kimiCard,
              "sonar-reasoning-pro": {
                input_per_million: 2,
                output_per_million: 8,
                request_fee_low_per_1000: 6,
                request_fee_medium_per_1000: 10,
                request_fee_high_per_1000: 14,
              },
              "sonar-deep-research": {
                input_per_million: 2,
                output_per_million: 8,
                citation_tokens_per_million: 2,
                deep_research_reasoning_tokens_per_million: 3,
                search_queries_per_1000: 5,
              },
            },
          },
        };
        const DEPRECATED_KEY_PATHS = [
          'model_cost_rates.perplexity["sonar-reasoning-pro"].request_fee_low_per_1000',
          'model_cost_rates.perplexity["sonar-reasoning-pro"].request_fee_medium_per_1000',
          'model_cost_rates.perplexity["sonar-reasoning-pro"].request_fee_high_per_1000',
          'model_cost_rates.perplexity["sonar-deep-research"].citation_tokens_per_million',
          'model_cost_rates.perplexity["sonar-deep-research"].deep_research_reasoning_tokens_per_million',
        ];
        process.env.CROSS_REVIEW_CONFIG_FILE = configPath;
        writeCentralConfig(legacyCentralConfig);
        const legacyLoaded = loadConfig();
        const legacyStatus = getFileConfigRuntimeStatus();
        assert.ok(legacyStatus?.file_exists, "the temp central config must be seen");
        assert.deepEqual(
          {
            applied: legacyStatus.applied,
            parseError: legacyStatus.parse_error,
            fieldsApplied: legacyStatus.fields_applied >= 1,
            ignored: legacyStatus.deprecated_keys_ignored,
          },
          { applied: true, parseError: null, fieldsApplied: true, ignored: DEPRECATED_KEY_PATHS },
          `a central config valid under 4.6.8 must apply in full: ${JSON.stringify(legacyStatus)}`,
        );
        const loadedCards = legacyLoaded.model_cost_rates?.perplexity ?? {};
        assert.deepEqual(
          {
            reasoning: loadedCards["sonar-reasoning-pro"],
            deepResearch: loadedCards["sonar-deep-research"],
            legacyEnv: legacyEnvNamesPresent(),
          },
          {
            reasoning: { input_per_million: 2, output_per_million: 8 },
            deepResearch: {
              input_per_million: 2,
              output_per_million: 8,
              search_queries_per_1000: 5,
            },
            legacyEnv: [],
          },
          "deprecated keys must reach neither the loaded rate cards nor the env",
        );
        const legacyMissing = missingFinancialControlVars(legacyLoaded, ["perplexity"]);
        assert.deepEqual(
          legacyMissing.filter((item) => item.startsWith("CROSS_REVIEW_CONFIG_")),
          [],
          `a tolerated file must not block paid calls: ${legacyMissing.join(",")}`,
        );
        const deprecationNotice = centralConfigDeprecatedKeysBootNotice(legacyStatus);
        assert.ok(deprecationNotice, "the boot notice must name the ignored deprecated keys");
        for (const fragment of [
          `central config "${configPath}"`,
          ...DEPRECATED_KEY_PATHS,
          "restart or reload the MCP host",
          "CROSS_REVIEW_CONFIG_RELOAD_REQUIRED",
          "next major",
        ]) {
          assert.ok(
            deprecationNotice.includes(fragment),
            `deprecation boot notice must include ${fragment}: ${deprecationNotice}`,
          );
        }
        assert.equal(
          centralConfigInvalidBootNotice(legacyStatus),
          null,
          "a tolerated file must not print the schema-invalid boot notice",
        );

        writeCentralConfig({
          ...legacyCentralConfig,
          model_cost_rates: {
            perplexity: {
              ...legacyCentralConfig.model_cost_rates.perplexity,
              "perplexity/kimi-k3": { ...kimiCard, search_fee_per_1000: 2.5 },
            },
          },
        });
        const unknownLoaded = loadConfig();
        const unknownStatus = getFileConfigRuntimeStatus();
        assert.equal(unknownStatus?.applied, false, "an unknown key must reject the whole file");
        assert.ok(
          missingFinancialControlVars(unknownLoaded, ["perplexity"]).includes(
            "CROSS_REVIEW_CONFIG_FILE_INVALID",
          ),
          "paid calls must fail closed with the named marker while the unknown key remains",
        );
        const invalidNotice = centralConfigInvalidBootNotice(unknownStatus);
        assert.ok(invalidNotice, "an unknown key must produce the schema-invalid boot notice");
        for (const fragment of [
          "IGNORED IN FULL",
          "CROSS_REVIEW_CONFIG_FILE_INVALID",
          "unrecognized_keys",
          "search_fee_per_1000",
        ]) {
          assert.ok(
            invalidNotice.includes(fragment),
            `schema-invalid boot notice must include ${fragment}: ${invalidNotice}`,
          );
        }
        assert.equal(
          centralConfigDeprecatedKeysBootNotice(unknownStatus),
          null,
          "a rejected file has no ignored deprecated keys to announce",
        );

        // Removing the deprecated keys is optional; doing so silences the
        // notice while the same file keeps applying.
        writeCentralConfig({
          ...legacyCentralConfig,
          model_cost_rates: {
            perplexity: {
              "perplexity/kimi-k3": kimiCard,
              "sonar-reasoning-pro": { input_per_million: 2, output_per_million: 8 },
              "sonar-deep-research": {
                input_per_million: 2,
                output_per_million: 8,
                search_queries_per_1000: 5,
              },
            },
          },
        });
        loadConfig();
        const cleanStatus = getFileConfigRuntimeStatus();
        assert.deepEqual(
          {
            applied: cleanStatus?.applied,
            ignored: cleanStatus?.deprecated_keys_ignored,
            notice: centralConfigDeprecatedKeysBootNotice(cleanStatus),
          },
          { applied: true, ignored: [], notice: null },
          "removing the deprecated keys must silence the notice and keep the file applying",
        );
      } finally {
        for (const name of crossReviewEnvNames()) delete process.env[name];
        Object.assign(process.env, crossReviewEnvSnapshot);
        // Restore the module-level file-config status to the host state.
        loadConfig();
        fs.rmSync(legacyDataDir, { recursive: true, force: true });
      }

      // (8) Round preflight: any retired Perplexity id fails closed before it
      // is priced, as primary (before: sonar-reasoning-pro was priced from its
      // retained card) and as fallback in an otherwise Agent API chain.
      assert.equal(
        estimatedPeerRoundCost(modelAwareConfig, ["perplexity"], "fixture"),
        undefined,
        "a retired Sonar primary must fail closed even with a retained card",
      );
      assert.equal(
        estimatedPeerRoundCost(retiredPinsConfig, ["perplexity"], "fixture"),
        undefined,
        "a retired Deep Research primary must fail closed",
      );

      // v4.6.0: legacy Sonar ids are rejected before any network call.
      // The guard runs inside the real client() factory before the SDK is
      // loaded, so no fixture client is installed here: a missing guard would
      // surface as a network/auth failure instead of the migration diagnostic.
      const retiredAdapter = new PerplexityAdapter(modelAwareConfig, "sonar-deep-research");
      const retired = await retiredAdapter.call("fixture", context()).catch((error) => error);
      assert.match(
        String((retired as { message?: unknown }).message ?? retired),
        /perplexity_model_unsupported/,
      );

      // v4.6.0: Agent API accounting — cached input is split out of
      // input_tokens, and web_search invocations reported by the provider
      // are billed at the search_queries_per_1000 rate. Fixture rates:
      // $3 input, $15 output, $0.30 cache read, $2.50 per 1000 searches.
      const kimiRate = {
        input_per_million: 3,
        output_per_million: 15,
        cache_read_per_million: 0.3,
        search_queries_per_1000: 2.5,
      };
      const agentConfig = {
        ...modelAwareConfig,
        models: { ...modelAwareConfig.models, perplexity: "perplexity/kimi-k3" },
        cost_rates: { ...modelAwareConfig.cost_rates, perplexity: kimiRate },
        fallback_models: { ...modelAwareConfig.fallback_models, perplexity: [] },
      } as AppConfig;
      const agentAdapter = new PerplexityAdapter(agentConfig);
      Object.defineProperty(agentAdapter, "client", {
        configurable: true,
        value: async () => ({
          responses: {
            create: async () => ({
              status: "completed",
              model: "perplexity/kimi-k3",
              output: [
                { type: "search_results", queries: ["fixture"], results: [] },
                { type: "message", content: [{ type: "output_text", text: READY }] },
              ],
              usage: {
                input_tokens: 1_000_000,
                output_tokens: 1_000_000,
                total_tokens: 2_000_000,
                input_tokens_details: {
                  cached_tokens: 200_000,
                  cache_read_input_tokens: 200_000,
                  cache_creation_input_tokens: 0,
                },
                output_tokens_details: { reasoning_tokens: 10 },
                tool_calls_details: { search_web: { invocation: 1_000 } },
                cost: { currency: "USD", total_cost: 19.96 },
              },
            }),
          },
        }),
      });
      const agentResult = await agentAdapter.call("fixture", context());
      assert.ok(agentResult.cost, "Agent API pricing must produce a cost estimate");
      assert.deepEqual(
        {
          model: agentResult.model,
          input: agentResult.usage?.input_tokens,
          cacheRead: agentResult.usage?.cache_read_tokens,
          searches: agentResult.usage?.num_search_queries,
          providerTotal: agentResult.usage?.provider_reported_total_cost_usd,
          total: Number((agentResult.cost.total_cost ?? 0).toFixed(6)),
          legacyKeys: legacyKeysOn(agentResult.cost),
          searchCost: agentResult.cost.search_queries_cost,
        },
        {
          model: "perplexity/kimi-k3",
          input: 800_000,
          cacheRead: 200_000,
          searches: 1_000,
          providerTotal: 19.96,
          total: 19.96,
          legacyKeys: [],
          searchCost: 2.5,
        },
      );
      // Scope to the Perplexity dimensions: the fixture inherits the host's
      // budget ceilings from loadConfig(), which a CI runner does not set.
      assert.deepEqual(
        missingFinancialControlVars(agentConfig, ["perplexity"]).filter((item) =>
          item.includes("PERPLEXITY"),
        ),
        [],
        "a complete Agent API card (input/output/search fee) is a complete financial control",
      );
      const cardWithoutSearchFee = {
        ...agentConfig,
        cost_rates: {
          ...agentConfig.cost_rates,
          perplexity: { input_per_million: 3, output_per_million: 15 },
        },
      } as AppConfig;
      assert.ok(
        missingFinancialControlVars(cardWithoutSearchFee, ["perplexity"]).includes(
          "CROSS_REVIEW_PERPLEXITY_SEARCH_QUERIES_USD_PER_1000_REQUESTS",
        ),
        "an Agent API card without the web_search fee must fail closed while search is enabled",
      );
      // Codex review of PR #234: a Perplexity lead peer only generates, so the
      // gate must not demand the search rate when Perplexity is not a reviewer.
      assert.equal(
        missingFinancialControlVars(cardWithoutSearchFee, ["perplexity"], {
          reviewerPeers: ["codex", "claude"],
        }).filter((item) => item.includes("PERPLEXITY")).length,
        0,
        "a Perplexity lead (never a reviewer) must not require the web_search rate",
      );
      assert.ok(
        missingFinancialControlVars(cardWithoutSearchFee, ["perplexity"], {
          reviewerPeers: ["codex", "perplexity"],
        }).includes("CROSS_REVIEW_PERPLEXITY_SEARCH_QUERIES_USD_PER_1000_REQUESTS"),
        "a Perplexity reviewer must still require the web_search rate",
      );
      // Codex review of PR #234 (head b0b681d): the Agent API exposes no
      // invocation cap, so the fail_closed policy must refuse the estimate
      // residual exactly like Deep Research, while the default policy and a
      // non-reviewing Perplexity accept it.
      const failClosedConfig = {
        ...agentConfig,
        perplexity: { ...agentConfig.perplexity, search_preflight_policy: "fail_closed" as const },
      } as AppConfig;
      assert.ok(
        missingFinancialControlVars(failClosedConfig, ["perplexity"]).includes(
          "CROSS_REVIEW_PERPLEXITY_WEB_SEARCH_PREFLIGHT_UNBOUNDED",
        ),
        "fail_closed policy must disclose the unbounded search residual for a reviewer",
      );
      assert.equal(
        missingFinancialControlVars(failClosedConfig, ["perplexity"], {
          reviewerPeers: ["codex"],
        }).filter((item) => item.includes("PERPLEXITY")).length,
        0,
        "fail_closed policy does not apply to a Perplexity lead that never searches",
      );
      assert.equal(
        missingFinancialControlVars(agentConfig, ["perplexity"]).includes(
          "CROSS_REVIEW_PERPLEXITY_WEB_SEARCH_PREFLIGHT_UNBOUNDED",
        ),
        false,
        "estimate policy (default) prices the declared estimate instead of failing closed",
      );
      assert.ok(
        missingFinancialControlVars(modelAwareConfig, ["perplexity"]).includes(
          "CROSS_REVIEW_PERPLEXITY_MODEL_SONAR_RETIRED_USE_AGENT_API_ID",
        ),
        "a retired Sonar pin must be reported as a missing financial control",
      );
      const agentPreflight = estimatedPeerRoundCost(agentConfig, ["perplexity"], "four");
      const agentEnvelope = estimateCost(
        agentConfig,
        "perplexity",
        {
          input_tokens: 1,
          output_tokens: maxOutputTokensForPeer(agentConfig, "perplexity"),
          num_search_queries: agentConfig.perplexity.web_search_invocations_estimate,
        },
        "perplexity/kimi-k3",
      ).total_cost;
      assert.ok(agentEnvelope != null && agentPreflight != null);
      assert.ok(
        Math.abs(agentPreflight - 3 * agentEnvelope) < 1e-9,
        `Agent API preflight must price the declared web_search estimate per attempt: ${agentPreflight} vs ${3 * agentEnvelope}`,
      );
      // Codex review of PR #234: relator generation and evidence judges route
      // through generate() without the web_search tool, so their explicit
      // effective-model estimates must not carry the search fee, while the
      // reviewer role keeps it.
      const generationEnvelope = estimateCost(
        agentConfig,
        "perplexity",
        { input_tokens: 1, output_tokens: maxOutputTokensForPeer(agentConfig, "perplexity") },
        "perplexity/kimi-k3",
      ).total_cost;
      const generationPreflight = estimatedPeerRoundCost(
        agentConfig,
        ["perplexity"],
        "four",
        { perplexity: "perplexity/kimi-k3" },
        { request_role: "generation" },
      );
      const reviewPreflight = estimatedPeerRoundCost(
        agentConfig,
        ["perplexity"],
        "four",
        { perplexity: "perplexity/kimi-k3" },
        { request_role: "review" },
      );
      assert.ok(
        generationEnvelope != null && generationPreflight != null && reviewPreflight != null,
      );
      assert.ok(
        Math.abs(generationPreflight - generationEnvelope) < 1e-9,
        `generation preflight must exclude the web_search fee: ${generationPreflight} vs ${generationEnvelope}`,
      );
      assert.ok(
        Math.abs(reviewPreflight - agentEnvelope) < 1e-9,
        `review preflight with an explicit model must include the web_search fee: ${reviewPreflight} vs ${agentEnvelope}`,
      );
      assert.ok(
        reviewPreflight - generationPreflight > 0,
        "the reviewer envelope must exceed the generation envelope by the declared search fee",
      );

      // CROSREV-19 (#233): the explicit-effective-model path is the one the
      // evidence judge passes (consensus and single) and relator generation
      // use. A retired Perplexity id with a retained card must yield no
      // estimate there as well, for both roles, so those passes block before
      // dispatch instead of pricing a model the adapter cannot send.
      const retiredCardConfig = {
        ...agentConfig,
        model_cost_rates: { perplexity: { "sonar-reasoning-pro": legacyReasoningCard } },
      } as AppConfig;
      for (const role of ["generation", "review"] as const) {
        assert.equal(
          estimatedPeerRoundCost(
            retiredCardConfig,
            ["perplexity"],
            "fixture",
            { perplexity: "sonar-reasoning-pro" },
            { request_role: role, max_output_tokens_by_peer: { perplexity: 64 } },
          ),
          undefined,
          `an explicit retired Perplexity model must not be priced for the ${role} role`,
        );
      }
      assert.equal(
        estimatedPeerRoundCost(
          {
            ...retiredCardConfig,
            fallback_models: {
              ...retiredCardConfig.fallback_models,
              perplexity: ["sonar-reasoning-pro"],
            },
          } as AppConfig,
          ["perplexity"],
          "fixture",
        ),
        undefined,
        "a retired Sonar fallback must fail the whole chain closed",
      );

      // Worst-case retry envelope on an all-Agent-API chain: the primary pin
      // plus a fallback card of its own, with search disabled so no
      // web_search estimate is added to either envelope.
      const fallbackCard = {
        input_per_million: 4,
        output_per_million: 20,
        cache_read_per_million: 0.4,
        search_queries_per_1000: 2.5,
      };
      const retryConfig: AppConfig = {
        ...agentConfig,
        retry: { ...agentConfig.retry, max_attempts: 3 },
        perplexity: { ...agentConfig.perplexity, disable_search: true },
        fallback_models: {
          ...agentConfig.fallback_models,
          perplexity: ["perplexity/fixture-fallback"],
        },
        model_cost_rates: { perplexity: { "perplexity/fixture-fallback": fallbackCard } },
      };
      const prompt = "four";
      const usageEnvelope = {
        input_tokens: 1,
        output_tokens: maxOutputTokensForPeer(retryConfig, "perplexity"),
      };
      const primaryEnvelope = estimateCost(
        retryConfig,
        "perplexity",
        usageEnvelope,
        "perplexity/kimi-k3",
      ).total_cost;
      const fallbackEnvelope = estimateCost(
        retryConfig,
        "perplexity",
        usageEnvelope,
        "perplexity/fixture-fallback",
      ).total_cost;
      assert.ok(primaryEnvelope != null && fallbackEnvelope != null);
      const fallbackThenFormat =
        3 * primaryEnvelope +
        3 * fallbackEnvelope +
        3 * Math.max(primaryEnvelope, fallbackEnvelope);
      const moderationThenFormat = 9 * primaryEnvelope;
      const expectedWorstCase = Math.max(fallbackThenFormat, moderationThenFormat);
      assert.equal(
        estimatedPeerRoundCost(retryConfig, ["perplexity"], prompt),
        expectedWorstCase,
        "round preflight must cover every primary/fallback retry plus one worst-case format-recovery envelope",
      );
    },
  },
  {
    name: "Gemini effort survives central config reload",
    run: () => {
      const previous = process.env.CROSS_REVIEW_GEMINI_REASONING_EFFORT;
      process.env.CROSS_REVIEW_GEMINI_REASONING_EFFORT = "medium";
      try {
        assert.equal(loadConfig().reasoning_effort.gemini, "medium");
      } finally {
        if (previous === undefined) delete process.env.CROSS_REVIEW_GEMINI_REASONING_EFFORT;
        else process.env.CROSS_REVIEW_GEMINI_REASONING_EFFORT = previous;
      }
    },
  },
  {
    name: "Claude enum casing is canonicalized locally without broad coercion",
    run: () => {
      const parsed = parsePeerStatus(
        JSON.stringify({
          status: "ready",
          summary: "No blocking objections remain.",
          confidence: "Verified",
          evidence_sources: ["fixture evidence"],
          caller_requests: [],
          follow_ups: [],
        }),
      );
      assert.equal(parsed.raw_status, "READY");
      assert.equal(parsed.parsed_status, "READY");
      assert.equal(parsed.structured?.confidence, "verified");

      const largestEvidenceArray = Array.from(
        { length: 30 },
        (_, index) => `${String(index).padStart(2, "0")}:${"x".repeat(2497)}`,
      );
      const schemaValidLargeEnvelope = parsePeerStatus(
        JSON.stringify({
          status: "NOT_READY",
          summary: "One blocking correction remains.",
          confidence: "verified",
          evidence_sources: largestEvidenceArray,
          caller_requests: [],
          follow_ups: [],
        }),
      );
      assert.equal(
        schemaValidLargeEnvelope.parsed_status,
        "NOT_READY",
        `schema-valid 75 KB evidence envelope must survive the parser cap: ${schemaValidLargeEnvelope.parser_warnings.join(",")}`,
      );
      assert.equal(schemaValidLargeEnvelope.structured?.evidence_sources?.length, 30);
    },
  },
  {
    name: "one provider-serialization escape layer preserves a valid citation",
    run: () => {
      const result = grounding(
        citation(String.raw`{\"conclusion\":\"success\"}`),
        '{"conclusion":"success"}',
      );
      assert.equal(result.grounded, true);
      assert.equal(result.result.status, "READY");
    },
  },
  {
    name: "a logical multiline quote matches the safe post-image of a unified diff",
    run: () => {
      const diff = [
        "diff --git a/src/types.ts b/src/types.ts",
        "--- a/src/types.ts",
        "+++ b/src/types.ts",
        "@@ -1 +1,2 @@",
        "-export type X = 'old';",
        "+export type X =",
        "+  | 'a';",
      ].join("\n");
      const result = grounding(citation(String.raw`export type X =\n  | 'a';`), diff);
      assert.equal(result.grounded, true);
      assert.equal(result.result.status, "READY");

      const removedOnly = grounding(citation("export type X = 'old';"), diff);
      assert.equal(
        removedOnly.grounded,
        false,
        "a safe post-image must never treat a removed line as current evidence",
      );
      const removedWithDiffMarker = grounding(citation("-export type X = 'old';"), diff);
      assert.equal(
        removedWithDiffMarker.grounded,
        false,
        "a raw '-' diff marker must not bypass removed-only post-image rejection",
      );

      const caseChangedCode = grounding(citation("if (isadmin) allow();"), "if (isAdmin) allow();");
      assert.equal(
        caseChangedCode.grounded,
        false,
        "literal code grounding must preserve case-sensitive identifiers",
      );
      const whitespaceChangedString = grounding(
        citation('const mode = "a b";'),
        'const mode = "a  b";',
      );
      assert.equal(
        whitespaceChangedString.grounded,
        false,
        "literal code grounding must preserve whitespace inside string literals",
      );

      const genericAssurance = "The implementation is correct and fully tested.";
      const selfGrounded = groundReadyPeerEvidence(readyPeer(genericAssurance), {
        artifactText: genericAssurance,
        attachedEvidenceText: "raw test log that does not contain the claim",
        attachmentRefs: [EVIDENCE_PATH],
        evidenceAttachments: [{ relative_path: EVIDENCE_PATH, sha256: EVIDENCE_SHA }],
        callerSubmittedAttachments: [
          {
            relative_path: EVIDENCE_PATH,
            sha256: EVIDENCE_SHA,
            content: "raw test log that does not contain the claim",
          },
        ],
        runtimeFacts: {},
      });
      assert.equal(
        selfGrounded.grounded,
        false,
        "a generic assurance repeated from the draft cannot prove its own READY verdict",
      );
    },
  },
  {
    name: "paired BEGIN FILE evidence markers retain embedded-file custody across rounds",
    run: () => {
      const evidence = [
        "BEGIN FILE package.json",
        "Output:",
        '{"name":"fixture","version":"2.20.0"}',
        "END FILE package.json",
      ].join("\n");
      const result = evidencePreflight({
        task: "Review the supplied patch.",
        initialDraft: "Evidence source: package.json confirms the reviewed product metadata.",
        structuredEvidence: undefined,
        attachedEvidenceText: evidence,
        caller: "codex",
        attachmentsPresent: true,
        attachedEvidenceRefs: [EVIDENCE_PATH],
      });
      assert.equal(result.pass, true, result.reason);
      assert.deepEqual(result.unattached_evidence_references, []);
    },
  },
  {
    name: "reviewed-product model names are not compared with cross-review peer pins",
    run: () => {
      const product = truthfulnessPreflight({
        task: "Review a model migration in the submitted application.",
        initialDraft: "The current reviewed-product model is gemini-3.5-flash.",
        caller: "codex",
        attachmentsPresent: true,
        attachedEvidenceText: "product_model=gemini-3.5-flash",
        runtimeFacts: { model_pins: { gemini: "gemini-3.1-pro-preview" } },
      });
      assert.equal(product.pass, true, product.reason);

      for (const applicationClaim of [
        "The current application reviewer model is gemini-3.5-flash.",
        "The currently loaded application peer model is gemini-3.5-flash.",
        "Current cross-review submission: the astrologo-app uses gemini-3.5-flash for application reviews.",
      ]) {
        const application = truthfulnessPreflight({
          task: "Review the submitted application's reviewer configuration.",
          initialDraft: applicationClaim,
          caller: "codex",
          attachmentsPresent: true,
          attachedEvidenceText: "application reviewer model=gemini-3.5-flash",
          runtimeFacts: { model_pins: { gemini: "gemini-3.1-pro-preview" } },
        });
        assert.equal(
          application.pass,
          true,
          `reviewed-application model namespace must not be compared with runtime pins: ${application.reason}`,
        );
      }

      for (const applicationVersionClaim of [
        "Current cross-review submission: astrologo-app 4.2.1 is in production.",
        "When the cross-review session began, astrologo-app 4.2.1 was in production.",
      ]) {
        const application = truthfulnessPreflight({
          task: "Review the submitted application's release metadata.",
          initialDraft: applicationVersionClaim,
          caller: "codex",
          attachmentsPresent: true,
          attachedEvidenceText: applicationVersionClaim,
          runtimeFacts: { runtime_version: "4.5.6", release_date: "2026-07-12" },
        });
        assert.equal(
          application.pass,
          true,
          `reviewed-application versions must not be compared with runtime metadata: ${application.reason}`,
        );
      }

      const runtime = truthfulnessPreflight({
        task: "Audit the cross-review runtime.",
        initialDraft: "The current cross-review runtime Gemini peer model is gemini-3.5-flash.",
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: { model_pins: { gemini: "gemini-3.1-pro-preview" } },
      });
      assert.equal(runtime.pass, false);
      assert.ok(runtime.issue_classes.includes("runtime_contradiction"));

      const runtimeVersion = truthfulnessPreflight({
        task: "Audit the cross-review runtime.",
        initialDraft: "The current cross-review runtime version is 4.5.5.",
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: { runtime_version: "4.5.6" },
      });
      assert.equal(runtimeVersion.pass, false);
      assert.ok(runtimeVersion.issue_classes.includes("runtime_contradiction"));

      const runtimeAndToolVersions = truthfulnessPreflight({
        task: "Audit the cross-review runtime and its package manager.",
        initialDraft: "The current cross-review runtime version is 4.5.6 and npm 12.0.1 is loaded.",
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: { runtime_version: "4.5.6" },
      });
      assert.equal(
        runtimeAndToolVersions.pass,
        true,
        `an independently attributed tool version must not contradict runtime_version: ${runtimeAndToolVersions.reason}`,
      );

      const negatedExpectedPin = truthfulnessPreflight({
        task: "Audit the cross-review runtime.",
        initialDraft:
          "The current cross-review model_pin for Gemini is gemini-3.5-flash, not gemini-3.1-pro-preview.",
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: { model_pins: { gemini: "gemini-3.1-pro-preview" } },
      });
      assert.equal(negatedExpectedPin.pass, false);
      assert.ok(negatedExpectedPin.issue_classes.includes("runtime_contradiction"));

      const negatedWrongPin = truthfulnessPreflight({
        task: "Audit the cross-review runtime.",
        initialDraft:
          "The current cross-review model_pin for Gemini is gemini-3.1-pro-preview, not gemini-3.5-flash.",
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: { model_pins: { gemini: "gemini-3.1-pro-preview" } },
      });
      assert.equal(negatedWrongPin.pass, true, negatedWrongPin.reason);

      for (const falseRuntimeClaim of [
        "The current cross-review runtime is not version 4.5.6; it is version 4.5.5.",
        "The current cross-review runtime does not run version 4.5.6; it runs version 4.5.5.",
        "The current cross-review runtime version differs from 4.5.6 and equals 4.5.5.",
        "The current cross-review runtime is definitely running release 4.5.5.",
        "server_info runtime_version: 4.5.5.",
        "runtime_capabilities version=4.5.5.",
        "cross-review version: 4.5.5.",
      ]) {
        const contradiction = truthfulnessPreflight({
          task: "Audit the cross-review runtime.",
          initialDraft: falseRuntimeClaim,
          caller: "codex",
          attachmentsPresent: false,
          runtimeFacts: { runtime_version: "4.5.6" },
        });
        assert.equal(
          contradiction.pass,
          false,
          `explicit runtime metadata contradiction must fail: ${falseRuntimeClaim}`,
        );
        assert.ok(contradiction.issue_classes.includes("runtime_contradiction"));
      }

      for (const falsePinClaim of [
        "Cross-review model_pin for Gemini = gemini-3.5-flash.",
        "server_info model_pin Gemini: gemini-3.5-flash.",
        "Cross-review uses Gemini gemini-3.5-flash.",
      ]) {
        const contradiction = truthfulnessPreflight({
          task: "Audit the cross-review runtime.",
          initialDraft: falsePinClaim,
          caller: "codex",
          attachmentsPresent: false,
          runtimeFacts: { model_pins: { gemini: "gemini-3.1-pro-preview" } },
        });
        assert.equal(
          contradiction.pass,
          false,
          `explicit model-pin contradiction must fail without a redundant current adjective: ${falsePinClaim}`,
        );
        assert.ok(contradiction.issue_classes.includes("runtime_contradiction"));
      }

      const runtimeAndExplicitToolVersion = truthfulnessPreflight({
        task: "Audit the cross-review runtime and package manager.",
        initialDraft:
          "The current cross-review runtime version is 4.5.6 and npm version 12.0.1 is loaded.",
        caller: "codex",
        attachmentsPresent: false,
        runtimeFacts: { runtime_version: "4.5.6" },
      });
      assert.equal(
        runtimeAndExplicitToolVersion.pass,
        true,
        `an explicitly attributed npm version must remain outside runtime_version: ${runtimeAndExplicitToolVersion.reason}`,
      );
    },
  },
  {
    name: "normal terminal finalization removes running background control atomically",
    run: async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-v456-terminal-"));
      try {
        const store = new SessionStore({ ...loadConfig(), data_dir: dataDir });
        const session = await store.init("terminal control regression", "operator", []);
        await store.markBackgroundJobRunning(session.session_id, {
          job_id: "550e8400-e29b-41d4-a716-446655440457",
          owner_pid: process.pid,
        });
        const terminal = await store.finalize(
          session.session_id,
          "max-rounds",
          "max_rounds_without_unanimity",
        );
        assert.equal(terminal.control, undefined);
        assert.equal(store.read(session.session_id).control, undefined);
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    },
  },
];

let failures = 0;
for (const regression of regressions) {
  try {
    await regression.run();
    console.log(`[v4.5.6-runtime-contract] PASS ${regression.name}`);
  } catch (error) {
    failures += 1;
    console.error(`[v4.5.6-runtime-contract] FAIL ${regression.name}`);
    console.error(error);
  }
}

if (failures > 0) {
  throw new Error(`${failures}/${regressions.length} v4.5.6 runtime contract regressions failed`);
}

console.log(`[v4.5.6-runtime-contract] PASS ${regressions.length}/${regressions.length}`);
