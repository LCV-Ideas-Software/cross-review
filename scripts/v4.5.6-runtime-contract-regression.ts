import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig, missingFinancialControlVars } from "../src/core/config.js";
import { estimateCost, mergeUsage } from "../src/core/cost.js";
import { FileConfigSchema, flattenFileConfigToEnvMap } from "../src/core/file-config.js";
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
import type { AppConfig, PeerCallContext, PeerResult } from "../src/core/types.js";
import { AnthropicAdapter } from "../src/peers/anthropic.js";
import { DeepSeekAdapter } from "../src/peers/deepseek.js";
import { GeminiAdapter } from "../src/peers/gemini.js";
import { GrokAdapter } from "../src/peers/grok.js";
import { OpenAIAdapter } from "../src/peers/openai.js";
import { PerplexityAdapter } from "../src/peers/perplexity.js";
import { StubAdapter } from "../src/peers/stub.js";
import {
  assertChatCompletionTerminal,
  assertGeminiCompletion,
  assertResponsesCompletion,
} from "../src/peers/terminal.js";

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
    name: "Perplexity wire uses the minimal documented Sonar schema wrapper",
    run: async () => {
      const perplexity = new PerplexityAdapter(offlineConfig());
      let perplexityRequest: Record<string, unknown> | undefined;
      Object.defineProperty(perplexity, "client", {
        configurable: true,
        value: async () => ({
          chat: {
            completions: {
              create: async (body: Record<string, unknown>) => {
                perplexityRequest = body;
                return completedChatResult(perplexity.model);
              },
            },
          },
        }),
      });
      await perplexity.call("fixture", context());
      const responseFormat = perplexityRequest?.response_format as {
        json_schema?: { name?: unknown; schema?: unknown };
      };
      assert.deepEqual(
        {
          name: responseFormat.json_schema?.name,
          forbiddenKeywords: schemaKeywordPaths(
            responseFormat.json_schema?.schema,
            new Set(["maxItems", "minLength", "maxLength"]),
          ),
        },
        { name: undefined, forbiddenKeywords: [] },
        "Sonar publishes no closed dimensional-keyword contract",
      );
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
          chat: {
            completions: {
              create: async (body: Record<string, unknown>) => {
                perplexityRequest = body;
                return (async function* () {
                  yield {
                    model: perplexity.model,
                    choices: [{ index: 0, finish_reason: "stop", delta: { content: READY } }],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                  };
                })();
              },
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
            assertChatCompletionTerminal([{ finish_reason: "content_filter" }], {
              context: callContext,
              peer: "perplexity",
              provider: "perplexity",
              model: "sonar-reasoning-pro",
              phase: "review",
            }),
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
    name: "Perplexity deep-research-only dimensions cannot overcharge Reasoning Pro",
    run: async () => {
      const base = offlineConfig();
      const reasoningRate = {
        input_per_million: 2,
        output_per_million: 8,
        request_fee_low_per_1000: 6,
      };
      const deepResearchRate = {
        input_per_million: 2,
        output_per_million: 8,
        citation_tokens_per_million: 2,
        deep_research_reasoning_tokens_per_million: 3,
        search_queries_per_1000: 5,
      };
      const usage = {
        input_tokens: 100,
        output_tokens: 200,
        reasoning_tokens: 50,
        citation_tokens: 20,
        num_search_queries: 3,
        search_performed: true,
      };
      const reasoningPro = estimateCost(
        {
          ...base,
          models: { ...base.models, perplexity: "sonar-reasoning-pro" },
          cost_rates: { ...base.cost_rates, perplexity: reasoningRate },
        },
        "perplexity",
        usage,
      );
      const deepResearch = estimateCost(
        {
          ...base,
          models: { ...base.models, perplexity: "sonar-deep-research" },
          cost_rates: { ...base.cost_rates, perplexity: deepResearchRate },
        },
        "perplexity",
        usage,
      );
      assert.ok(Math.abs((reasoningPro.total_cost ?? 0) - 0.0078) < 1e-12);
      assert.equal(reasoningPro.request_cost, 0.006);
      assert.equal(reasoningPro.citation_tokens_cost, undefined);
      assert.equal(reasoningPro.deep_research_reasoning_tokens_cost, undefined);
      assert.equal(reasoningPro.search_queries_cost, undefined);
      assert.ok(Math.abs((deepResearch.total_cost ?? 0) - 0.01699) < 1e-12);
      assert.equal(deepResearch.request_cost, undefined);
      assert.equal(deepResearch.citation_tokens_cost, 0.00004);
      assert.equal(deepResearch.deep_research_reasoning_tokens_cost, 0.00015000000000000001);
      assert.equal(deepResearch.search_queries_cost, 0.015);

      const modelAwareConfig = {
        ...base,
        models: { ...base.models, perplexity: "sonar-reasoning-pro" },
        cost_rates: { ...base.cost_rates, perplexity: reasoningRate },
        model_cost_rates: {
          perplexity: {
            sonar: {
              input_per_million: 1,
              output_per_million: 1,
              request_fee_low_per_1000: 5,
            },
            "sonar-reasoning-pro": reasoningRate,
            "sonar-deep-research": deepResearchRate,
          },
        },
      } as AppConfig;
      const sonarOverride = estimateCost(
        modelAwareConfig,
        "perplexity",
        { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        "sonar",
      );
      const deepResearchOverride = estimateCost(
        modelAwareConfig,
        "perplexity",
        {
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          citation_tokens: 1_000_000,
          reasoning_tokens: 1_000_000,
          num_search_queries: 1_000,
        },
        "sonar-deep-research",
      );
      const unknownOverride = estimateCost(
        modelAwareConfig,
        "perplexity",
        { input_tokens: 1, output_tokens: 1 },
        "sonar-unknown",
      );
      assert.deepEqual(
        {
          sonar: {
            total: sonarOverride.total_cost,
            request: sonarOverride.request_cost,
          },
          deepResearch: {
            total: deepResearchOverride.total_cost,
            request: deepResearchOverride.request_cost,
            citation: deepResearchOverride.citation_tokens_cost,
            reasoning: deepResearchOverride.deep_research_reasoning_tokens_cost,
            searches: deepResearchOverride.search_queries_cost,
          },
          unknown: {
            estimated: unknownOverride.estimated,
            source: unknownOverride.source,
          },
        },
        {
          sonar: { total: 2.005, request: 0.005 },
          deepResearch: {
            total: 20,
            request: undefined,
            citation: 2,
            reasoning: 3,
            searches: 5,
          },
          unknown: { estimated: false, source: "unknown-rate" },
        },
      );

      const missingSonarFallbackFee = missingFinancialControlVars(
        {
          ...modelAwareConfig,
          models: { ...modelAwareConfig.models, perplexity: "sonar-deep-research" },
          cost_rates: { ...modelAwareConfig.cost_rates, perplexity: deepResearchRate },
          fallback_models: { ...modelAwareConfig.fallback_models, perplexity: ["sonar"] },
          model_cost_rates: {
            perplexity: {
              "sonar-deep-research": deepResearchRate,
              sonar: { input_per_million: 1, output_per_million: 1 },
            },
          },
        },
        ["perplexity"],
      );
      assert.ok(
        missingSonarFallbackFee.some((item) => item.includes("request_fee_low_per_1000")),
        `Sonar fallback without its request fee must fail closed: ${missingSonarFallbackFee.join(",")}`,
      );

      const missingDeepResearchDimensions = missingFinancialControlVars(
        {
          ...modelAwareConfig,
          fallback_models: {
            ...modelAwareConfig.fallback_models,
            perplexity: ["sonar-deep-research"],
          },
          model_cost_rates: {
            perplexity: {
              "sonar-reasoning-pro": reasoningRate,
              "sonar-deep-research": { input_per_million: 2, output_per_million: 8 },
            },
          },
        },
        ["perplexity"],
      );
      for (const field of [
        "citation_tokens_per_million",
        "deep_research_reasoning_tokens_per_million",
        "search_queries_per_1000",
      ]) {
        assert.ok(
          missingDeepResearchDimensions.some((item) => item.includes(field)),
          `Deep Research fallback must require ${field}: ${missingDeepResearchDimensions.join(",")}`,
        );
      }

      const missingPrimaryDeepResearchDimensions = missingFinancialControlVars(
        {
          ...modelAwareConfig,
          models: { ...modelAwareConfig.models, perplexity: "sonar-deep-research" },
          cost_rates: {
            ...modelAwareConfig.cost_rates,
            perplexity: { input_per_million: 2, output_per_million: 8 },
          },
          fallback_models: { ...modelAwareConfig.fallback_models, perplexity: [] },
          model_cost_rates: {
            perplexity: {
              "sonar-deep-research": { input_per_million: 2, output_per_million: 8 },
            },
          },
        },
        ["perplexity"],
      );
      for (const suffix of [
        "CITATION_TOKENS_USD_PER_MILLION",
        "DEEP_RESEARCH_REASONING_TOKENS_USD_PER_MILLION",
        "SEARCH_QUERIES_USD_PER_1000_REQUESTS",
      ]) {
        assert.ok(
          missingPrimaryDeepResearchDimensions.includes(`CROSS_REVIEW_PERPLEXITY_${suffix}`),
          `primary Deep Research must require ${suffix}: ${missingPrimaryDeepResearchDimensions.join(",")}`,
        );
      }
      const completeDeepResearchConfig: AppConfig = {
        ...modelAwareConfig,
        models: { ...modelAwareConfig.models, perplexity: "sonar-deep-research" },
        cost_rates: { ...modelAwareConfig.cost_rates, perplexity: deepResearchRate },
        fallback_models: { ...modelAwareConfig.fallback_models, perplexity: [] },
      };
      assert.ok(
        missingFinancialControlVars(completeDeepResearchConfig, ["perplexity"]).includes(
          "CROSS_REVIEW_PERPLEXITY_DEEP_RESEARCH_PREFLIGHT_UNBOUNDED",
        ),
        "Deep Research must disclose that provider-controlled cost dimensions cannot be hard-preflighted",
      );
      assert.equal(
        estimatedPeerRoundCost(completeDeepResearchConfig, ["perplexity"], "fixture"),
        undefined,
        "Deep Research must fail closed because citation/reasoning/search volume is provider-controlled",
      );

      const mergedSonarUsage = mergeUsage([
        { citation_tokens: 3, num_search_queries: 2, search_performed: true },
        { citation_tokens: 4, num_search_queries: 5, search_performed: false },
      ]);
      assert.deepEqual(
        {
          citationTokens: mergedSonarUsage.citation_tokens,
          searchQueries: mergedSonarUsage.num_search_queries,
          searchPerformed: mergedSonarUsage.search_performed,
        },
        { citationTokens: 7, searchQueries: 7, searchPerformed: true },
      );

      const deepResearchAdapter = new PerplexityAdapter(modelAwareConfig, "sonar-deep-research");
      Object.defineProperty(deepResearchAdapter, "client", {
        configurable: true,
        value: async () => ({
          chat: {
            completions: {
              create: async () => ({
                model: "sonar-deep-research",
                choices: [{ index: 0, finish_reason: "stop", message: { content: READY } }],
                usage: {
                  prompt_tokens: 1_000_000,
                  completion_tokens: 1_000_000,
                  total_tokens: 2_000_000,
                  citation_tokens: 1_000_000,
                  reasoning_tokens: 1_000_000,
                  num_search_queries: 1_000,
                },
              }),
            },
          },
        }),
      });
      const overrideResult = await deepResearchAdapter.call("fixture", context());
      assert.ok(overrideResult.cost, "effective-model pricing must produce a cost estimate");
      assert.deepEqual(
        {
          model: overrideResult.model,
          total: overrideResult.cost.total_cost,
          request: overrideResult.cost.request_cost,
          citation: overrideResult.cost.citation_tokens_cost,
          reasoning: overrideResult.cost.deep_research_reasoning_tokens_cost,
          searches: overrideResult.cost.search_queries_cost,
        },
        {
          model: "sonar-deep-research",
          total: 20,
          request: undefined,
          citation: 2,
          reasoning: 3,
          searches: 5,
        },
      );

      const retryConfig: AppConfig = {
        ...modelAwareConfig,
        retry: { ...modelAwareConfig.retry, max_attempts: 3 },
        fallback_models: { ...modelAwareConfig.fallback_models, perplexity: ["sonar"] },
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
        "sonar-reasoning-pro",
      ).total_cost;
      const fallbackEnvelope = estimateCost(
        retryConfig,
        "perplexity",
        usageEnvelope,
        "sonar",
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
