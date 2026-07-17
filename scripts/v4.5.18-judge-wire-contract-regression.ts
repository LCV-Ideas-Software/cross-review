import assert from "node:assert/strict";

import { loadConfig } from "../src/core/config.js";
import type { AppConfig, PeerCallContext, PeerId } from "../src/core/types.js";
import { AnthropicAdapter } from "../src/peers/anthropic.js";
import { DeepSeekAdapter } from "../src/peers/deepseek.js";
import { GeminiAdapter } from "../src/peers/gemini.js";
import { GrokAdapter } from "../src/peers/grok.js";
import { OpenAIAdapter } from "../src/peers/openai.js";
import { PerplexityAdapter } from "../src/peers/perplexity.js";

const JUDGE_JSON = JSON.stringify({
  satisfied: false,
  confidence: "verified",
  rationale: "The exact raw evidence is still absent.",
});

function fixtureConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = loadConfig();
  return {
    ...base,
    stub: false,
    models: {
      codex: "gpt-5.6-sol",
      claude: "claude-fable-5",
      gemini: "gemini-3.1-pro-preview",
      deepseek: "deepseek-v4-pro",
      grok: "grok-4.5",
      perplexity: "sonar-reasoning-pro",
    },
    api_keys: {
      codex: "fixture-openai",
      claude: "fixture-anthropic",
      gemini: "fixture-gemini",
      deepseek: "fixture-deepseek",
      grok: "fixture-grok",
      perplexity: "fixture-perplexity",
    },
    cache: { ...base.cache, enabled: false },
    streaming: { events: false, tokens: false, include_text: false },
    retry: {
      ...base.retry,
      max_attempts: 1,
      base_delay_ms: 1,
      max_delay_ms: 1,
    },
    ...overrides,
  };
}

function judgeContext(peer: PeerId): PeerCallContext {
  return {
    session_id: `00000000-0000-4000-8000-${peer.padEnd(12, "0").slice(0, 12)}`,
    round: 1,
    task: `Judge wire contract for ${peer}`,
    reasoning_effort_override: "medium",
    max_output_tokens_override: 2_048,
    caller: "operator",
    emit: () => undefined,
  };
}

function recoveryContext(peer: "codex" | "claude"): PeerCallContext {
  return {
    ...judgeContext(peer),
    reasoning_effort_override: "max",
  };
}

function setClient(adapter: object, client: unknown): void {
  Object.defineProperty(adapter, "client", {
    configurable: true,
    value: async () => client,
  });
}

type Regression = {
  name: string;
  run: () => void | Promise<void>;
};

const regressions: Regression[] = [
  {
    name: "OpenAI judge uses Responses max_output_tokens, standard service tier, and reasoning.effort",
    run: async () => {
      const adapter = new OpenAIAdapter(fixtureConfig());
      let payload: Record<string, unknown> | undefined;
      setClient(adapter, {
        responses: {
          create: async (body: Record<string, unknown>) => {
            payload = body;
            return {
              status: "completed",
              output_text: JUDGE_JSON,
              model: adapter.model,
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            };
          },
        },
      });

      await adapter.judgeEvidenceAsk(
        "Provide raw evidence.",
        "Draft under judgment.",
        judgeContext("codex"),
      );

      assert.equal(payload?.model, "gpt-5.6-sol");
      assert.equal(payload?.max_output_tokens, 2_048);
      assert.equal(
        payload?.service_tier,
        "default",
        "standard rate-card accounting requires the request to opt out of project-level priority/flex overrides",
      );
      assert.deepEqual(payload?.reasoning, { effort: "medium" });
      assert.equal(Object.hasOwn(payload ?? {}, "max_tokens"), false);
    },
  },
  {
    name: "Anthropic judge uses Messages max_tokens and Fable output_config.effort",
    run: async () => {
      const adapter = new AnthropicAdapter(fixtureConfig());
      let payload: Record<string, unknown> | undefined;
      setClient(adapter, {
        messages: {
          create: async (body: Record<string, unknown>) => {
            payload = body;
            return {
              content: [{ type: "text", text: JUDGE_JSON }],
              model: adapter.model,
              stop_reason: "end_turn",
              usage: { input_tokens: 10, output_tokens: 5 },
            };
          },
        },
      });

      await adapter.judgeEvidenceAsk(
        "Provide raw evidence.",
        "Draft under judgment.",
        judgeContext("claude"),
      );

      assert.equal(payload?.model, "claude-fable-5");
      assert.equal(payload?.max_tokens, 2_048);
      assert.deepEqual(payload?.output_config, { effort: "medium" });
      assert.equal(
        Object.hasOwn(payload ?? {}, "thinking"),
        false,
        "Fable 5 uses adaptive thinking by default; the official migration omits thinking",
      );
      assert.equal(Object.hasOwn(payload ?? {}, "max_output_tokens"), false);
    },
  },
  {
    name: "Gemini judge uses maxOutputTokens and native MEDIUM thinkingLevel",
    run: async () => {
      const adapter = new GeminiAdapter(fixtureConfig());
      let payload: Record<string, unknown> | undefined;
      setClient(adapter, {
        ThinkingLevel: { LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH" },
        ai: {
          models: {
            generateContent: async (body: Record<string, unknown>) => {
              payload = body;
              return {
                text: JUDGE_JSON,
                modelVersion: adapter.model,
                candidates: [{ finishReason: "STOP" }],
                usageMetadata: {
                  promptTokenCount: 10,
                  candidatesTokenCount: 5,
                  totalTokenCount: 15,
                },
              };
            },
          },
        },
      });

      await adapter.judgeEvidenceAsk(
        "Provide raw evidence.",
        "Draft under judgment.",
        judgeContext("gemini"),
      );

      const generationConfig = payload?.config as Record<string, unknown> | undefined;
      assert.equal(payload?.model, "gemini-3.1-pro-preview");
      assert.equal(generationConfig?.maxOutputTokens, 2_048);
      assert.deepEqual(generationConfig?.thinkingConfig, {
        includeThoughts: false,
        thinkingLevel: "MEDIUM",
      });
      assert.equal(Object.hasOwn(generationConfig ?? {}, "max_tokens"), false);
    },
  },
  {
    name: "DeepSeek judge uses max_tokens, enabled thinking, and supported high effort",
    run: async () => {
      const adapter = new DeepSeekAdapter(fixtureConfig());
      let payload: Record<string, unknown> | undefined;
      setClient(adapter, {
        chat: {
          completions: {
            create: async (body: Record<string, unknown>) => {
              payload = body;
              return {
                model: adapter.model,
                choices: [{ finish_reason: "stop", message: { content: JUDGE_JSON } }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              };
            },
          },
        },
      });

      await adapter.judgeEvidenceAsk(
        "Provide raw evidence.",
        "Draft under judgment.",
        judgeContext("deepseek"),
      );

      assert.equal(payload?.model, "deepseek-v4-pro");
      assert.equal(payload?.max_tokens, 2_048);
      assert.deepEqual(payload?.thinking, { type: "enabled" });
      assert.equal(
        payload?.reasoning_effort,
        "high",
        "DeepSeek V4 Pro supports high|max; shared medium must map to its lower supported tier",
      );
      assert.equal(Object.hasOwn(payload ?? {}, "max_output_tokens"), false);
    },
  },
  {
    name: "Grok judge uses Responses max_output_tokens and Grok 4.5 medium effort",
    run: async () => {
      const adapter = new GrokAdapter(fixtureConfig());
      let payload: Record<string, unknown> | undefined;
      setClient(adapter, {
        responses: {
          create: async (body: Record<string, unknown>) => {
            payload = body;
            return {
              status: "completed",
              output_text: JUDGE_JSON,
              model: adapter.model,
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            };
          },
        },
      });

      await adapter.judgeEvidenceAsk(
        "Provide raw evidence.",
        "Draft under judgment.",
        judgeContext("grok"),
      );

      assert.equal(payload?.model, "grok-4.5");
      assert.equal(payload?.max_output_tokens, 2_048);
      assert.deepEqual(payload?.reasoning, { effort: "medium" });
      assert.equal(Object.hasOwn(payload ?? {}, "max_tokens"), false);
    },
  },
  {
    name: "Perplexity judge uses max_tokens and Sonar medium reasoning effort",
    run: async () => {
      const config = fixtureConfig({
        perplexity: {
          search_context_size: "high",
          disable_search: false,
          probe_mode: "auth_only",
        },
      });
      const adapter = new PerplexityAdapter(config);
      let payload: Record<string, unknown> | undefined;
      setClient(adapter, {
        chat: {
          completions: {
            create: async (body: Record<string, unknown>) => {
              payload = body;
              return {
                model: adapter.model,
                choices: [{ finish_reason: "stop", message: { content: JUDGE_JSON } }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              };
            },
          },
        },
      });

      await adapter.judgeEvidenceAsk(
        "Provide raw evidence.",
        "Draft under judgment.",
        judgeContext("perplexity"),
      );

      assert.equal(payload?.model, "sonar-reasoning-pro");
      assert.equal(payload?.max_tokens, 2_048);
      assert.equal(payload?.reasoning_effort, "medium");
      assert.equal(
        payload?.disable_search,
        true,
        "judgeEvidenceAsk routes through generation; relator/judge synthesis must not launch search",
      );
      assert.deepEqual(payload?.web_search_options, { search_context_size: "high" });
      assert.equal(Object.hasOwn(payload ?? {}, "max_output_tokens"), false);
    },
  },
  {
    name: "OpenAI max_output_tokens recovery still performs one medium-effort retry",
    run: async () => {
      const base = fixtureConfig();
      const adapter = new OpenAIAdapter({
        ...base,
        retry: { ...base.retry, max_attempts: 2 },
        cost_rates: {
          ...base.cost_rates,
          codex: { input_per_million: 1, output_per_million: 1 },
        },
      });
      const payloads: Record<string, unknown>[] = [];
      setClient(adapter, {
        responses: {
          create: async (body: Record<string, unknown>) => {
            payloads.push(body);
            if (payloads.length === 1) {
              return {
                status: "incomplete",
                incomplete_details: { reason: "max_output_tokens" },
                output_text: "",
                model: adapter.model,
                usage: { input_tokens: 10, output_tokens: 2_048, total_tokens: 2_058 },
              };
            }
            return {
              status: "completed",
              output_text: JUDGE_JSON,
              model: adapter.model,
              usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12 },
            };
          },
        },
      });

      const result = await adapter.judgeEvidenceAsk(
        "Provide raw evidence.",
        "Draft under judgment.",
        recoveryContext("codex"),
      );

      assert.equal(payloads.length, 2);
      assert.deepEqual(
        payloads.map((payload) => (payload.reasoning as { effort?: unknown } | undefined)?.effort),
        ["max", "medium"],
      );
      assert.deepEqual(
        payloads.map((payload) => payload.max_output_tokens),
        [2_048, 2_048],
      );
      assert.deepEqual(
        payloads.map((payload) => payload.service_tier),
        ["default", "default"],
      );
      assert.equal(result.attempts, 2);
      assert.equal(result.usage?.input_tokens, 17);
      assert.equal(result.usage?.output_tokens, 2_053);
    },
  },
  {
    name: "Anthropic max_tokens recovery still performs one medium-effort retry",
    run: async () => {
      const base = fixtureConfig();
      const adapter = new AnthropicAdapter({
        ...base,
        retry: { ...base.retry, max_attempts: 2 },
        cost_rates: {
          ...base.cost_rates,
          claude: { input_per_million: 1, output_per_million: 1 },
        },
      });
      const payloads: Record<string, unknown>[] = [];
      setClient(adapter, {
        messages: {
          create: async (body: Record<string, unknown>) => {
            payloads.push(body);
            if (payloads.length === 1) {
              return {
                content: [{ type: "text", text: "discarded partial response" }],
                model: adapter.model,
                stop_reason: "max_tokens",
                usage: { input_tokens: 10, output_tokens: 2_048 },
              };
            }
            return {
              content: [{ type: "text", text: JUDGE_JSON }],
              model: adapter.model,
              stop_reason: "end_turn",
              usage: { input_tokens: 7, output_tokens: 5 },
            };
          },
        },
      });

      const result = await adapter.judgeEvidenceAsk(
        "Provide raw evidence.",
        "Draft under judgment.",
        recoveryContext("claude"),
      );

      assert.equal(payloads.length, 2);
      assert.deepEqual(
        payloads.map(
          (payload) => (payload.output_config as { effort?: unknown } | undefined)?.effort,
        ),
        ["max", "medium"],
      );
      assert.deepEqual(
        payloads.map((payload) => payload.max_tokens),
        [2_048, 2_048],
      );
      assert.equal(result.attempts, 2);
      assert.equal(result.usage?.input_tokens, 17);
      assert.equal(result.usage?.output_tokens, 2_053);
    },
  },
];

const failures: Array<{ name: string; error: string }> = [];
for (const regression of regressions) {
  try {
    await regression.run();
    console.log(`[v4.5.18-judge-wire] PASS: ${regression.name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ name: regression.name, error: message });
    console.error(`[v4.5.18-judge-wire] FAIL: ${regression.name}\n  ${message}`);
  }
}

console.log(
  JSON.stringify(
    {
      ok: failures.length === 0,
      regressions: regressions.length,
      failed: failures.length,
      failures,
    },
    null,
    2,
  ),
);
if (failures.length > 0) process.exitCode = 1;
