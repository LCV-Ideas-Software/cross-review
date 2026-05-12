// v2.27.1 (cold-start hardening): SDK ctors lazy-loaded inside the
// per-provider model-listing helpers so the SDK module trees are not
// pulled at server boot. `resolveBestModels` only runs when an operator
// explicitly invokes model probing — paying the SDK load cost there is
// expected and amortized across all 5 peer probes via the per-module
// promise cache shared with the runtime adapters.
import type { AppConfig, ModelCandidate, ModelSelection, PeerId } from "../core/types.js";
import { loadAnthropicCtor } from "./anthropic.js";
import { loadGenaiModule } from "./gemini.js";
import { loadOpenAICtor } from "./openai.js";

const DOCS = {
  codex: "https://developers.openai.com/api/docs/guides/latest-model",
  claude: "https://platform.claude.com/docs/en/about-claude/models/overview",
  gemini: "https://ai.google.dev/gemini-api/docs/models",
  deepseek: "https://api-docs.deepseek.com/updates",
  grok: "https://docs.x.ai/developers/model-capabilities/text/reasoning",
} satisfies Record<PeerId, string>;

const PRIORITY: Record<PeerId, string[]> = {
  codex: [
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.2",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex",
    "gpt-5.1",
    "gpt-5-pro",
    "gpt-5",
  ],
  claude: ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"],
  gemini: ["gemini-2.5-pro", "gemini-3.1-pro-preview"],
  deepseek: ["deepseek-v4-pro", "deepseek-v4-flash"],
  // v2.16.0 official-doc refresh (2026-05-05): xAI's reasoning docs
  // distinguish automatic-reasoning Grok models from the explicit
  // multi-agent model. `grok-4.20-multi-agent` remains first because it
  // accepts `reasoning.effort`; `grok-4-latest` / `grok-4.3` /
  // `grok-4.20-reasoning` / `grok-4.20` follow and must omit the
  // explicit reasoning field.
  grok: [
    "grok-4.20-multi-agent",
    "grok-4-latest",
    "grok-4.3",
    "grok-4.20-reasoning",
    "grok-4.20",
    "grok-4-1-fast",
    "grok-4",
    "grok-3-fast",
    "grok-3",
  ],
};

function envOverrideName(peer: PeerId): string {
  switch (peer) {
    case "codex":
      return "CROSS_REVIEW_OPENAI_MODEL";
    case "claude":
      return "CROSS_REVIEW_ANTHROPIC_MODEL";
    case "gemini":
      return "CROSS_REVIEW_GEMINI_MODEL";
    case "deepseek":
      return "CROSS_REVIEW_DEEPSEEK_MODEL";
    case "grok":
      return "CROSS_REVIEW_GROK_MODEL";
  }
}

function keyPresent(config: AppConfig, peer: PeerId): boolean {
  return Boolean(config.api_keys[peer]);
}

function modelId(value: string): string {
  return value.replace(/^models\//, "");
}

export function selectFromCandidates(
  peer: PeerId,
  candidates: ModelCandidate[],
  fallback: string,
): ModelSelection {
  const available = new Set(candidates.map((candidate) => modelId(candidate.id)));
  const priority = PRIORITY[peer];
  const selected = priority.find((id) => available.has(id));
  return {
    peer,
    selected: modelId(selected ?? fallback),
    candidates,
    source_url: DOCS[peer],
    confidence: selected ? "verified" : candidates.length > 0 ? "unknown" : "inferred",
    reason: selected
      ? `Selected the first available advanced thinking model from the documented priority list: ${priority.join(" > ")}.`
      : candidates.length > 0
        ? `Model API returned candidates, but none matched the advanced thinking priority list (${priority.join(" > ")}); using documented fallback ${fallback} so the run fails visibly if unavailable instead of silently downgrading.`
        : `Model API unavailable; using documented fallback ${fallback}.`,
  };
}

function overrideSelection(peer: PeerId, value: string): ModelSelection {
  // v2.4.0 / audit closure: warn when an env override does not match any
  // entry in the documented PRIORITY list. Pre-v2.4.0 a typo
  // (`gpt-5.5-fast` vs `gpt-5.5`) would silently propagate to the
  // provider and surface as a 404/invalid-model error mid-round, far
  // from the env-config root cause. We do NOT throw — the operator may
  // legitimately pin a model outside the maintained list — but the
  // `confidence: "inferred"` plus the explicit notice in the reason
  // string make the deviation observable.
  const known = PRIORITY[peer].includes(value);
  return {
    peer,
    selected: value,
    candidates: [{ id: value, source: "env-override" }],
    source_url: DOCS[peer],
    confidence: known ? "verified" : "inferred",
    reason: known
      ? `${envOverrideName(peer)} is set; the explicit override has priority over automatic selection.`
      : `${envOverrideName(peer)}='${value}' is set but is not in the documented priority list (${PRIORITY[peer].join(" > ")}); honoring the operator override but flagging confidence=inferred so any provider 404 surfaces here.`,
  };
}

async function openAIModels(config: AppConfig): Promise<ModelCandidate[]> {
  const apiKey = config.api_keys.codex;
  if (!apiKey) return [];
  const Ctor = await loadOpenAICtor();
  const list = await new Ctor({ apiKey }).models.list();
  return list.data
    .map((model) => ({
      id: model.id,
      source: "api" as const,
      metadata: { owned_by: model.owned_by, created: model.created },
    }))
    .filter((model) => /^gpt-|^o\d|codex/i.test(model.id));
}

async function anthropicModels(config: AppConfig): Promise<ModelCandidate[]> {
  const apiKey = config.api_keys.claude;
  if (!apiKey) return [];
  const Ctor = await loadAnthropicCtor();
  const client = new Ctor({ apiKey, timeout: config.retry.timeout_ms });
  const page = await client.models.list({ limit: 100 });
  return page.data.map((model) => ({
    id: model.id,
    display_name: model.display_name,
    source: "api" as const,
    metadata: {
      created_at: model.created_at,
      max_input_tokens: model.max_input_tokens,
      max_tokens: model.max_tokens,
      capabilities: model.capabilities,
    },
  }));
}

async function geminiModels(config: AppConfig): Promise<ModelCandidate[]> {
  const apiKey = config.api_keys.gemini;
  if (!apiKey) return [];
  const genai = await loadGenaiModule();
  const pager = await new genai.GoogleGenAI({ apiKey }).models.list({
    config: { pageSize: 1000 },
  });
  const candidates: ModelCandidate[] = [];
  for await (const model of pager) {
    const id = modelId(model.name ?? model.displayName ?? "");
    if (!id) continue;
    const supported = model.supportedActions ?? [];
    if (!supported.includes("generateContent")) continue;
    candidates.push({
      id,
      display_name: model.displayName,
      source: "api",
      metadata: {
        description: model.description,
        inputTokenLimit: model.inputTokenLimit,
        outputTokenLimit: model.outputTokenLimit,
        thinking: model.thinking,
        supportedActions: supported,
      },
    });
  }
  return candidates;
}

async function deepSeekModels(config: AppConfig): Promise<ModelCandidate[]> {
  const apiKey = config.api_keys.deepseek;
  if (!apiKey) return [];
  const Ctor = await loadOpenAICtor();
  const list = await new Ctor({ apiKey, baseURL: "https://api.deepseek.com" }).models.list();
  return list.data.map((model) => ({
    id: model.id,
    source: "api" as const,
    metadata: { owned_by: model.owned_by, created: model.created },
  }));
}

// v2.14.0: Grok models via xAI's OpenAI-compatible API at api.x.ai/v1.
async function grokModels(config: AppConfig): Promise<ModelCandidate[]> {
  const apiKey = config.api_keys.grok;
  if (!apiKey) return [];
  const Ctor = await loadOpenAICtor();
  const list = await new Ctor({ apiKey, baseURL: "https://api.x.ai/v1" }).models.list();
  return list.data.map((model) => ({
    id: model.id,
    source: "api" as const,
    metadata: { owned_by: model.owned_by, created: model.created },
  }));
}

async function candidatesForPeer(config: AppConfig, peer: PeerId): Promise<ModelCandidate[]> {
  switch (peer) {
    case "codex":
      return openAIModels(config);
    case "claude":
      return anthropicModels(config);
    case "gemini":
      return geminiModels(config);
    case "deepseek":
      return deepSeekModels(config);
    case "grok":
      return grokModels(config);
  }
}

export async function resolveBestModel(config: AppConfig, peer: PeerId): Promise<ModelSelection> {
  const envOverride = process.env[envOverrideName(peer)];
  if (envOverride) return overrideSelection(peer, envOverride);
  if (!keyPresent(config, peer)) {
    return {
      peer,
      selected: config.models[peer] ?? PRIORITY[peer][0],
      candidates: [],
      source_url: DOCS[peer],
      confidence: "inferred",
      reason:
        "API key is missing in the current process; using the documented fallback until the key is available.",
    };
  }
  try {
    const candidates = await candidatesForPeer(config, peer);
    return selectFromCandidates(peer, candidates, PRIORITY[peer][0]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      peer,
      selected: config.models[peer] ?? PRIORITY[peer][0],
      candidates: [],
      source_url: DOCS[peer],
      confidence: "unknown",
      reason: `Failed to query the model API; using the current fallback. Error: ${message}`,
    };
  }
}

export async function resolveBestModels(
  config: AppConfig,
): Promise<Partial<Record<PeerId, ModelSelection>>> {
  const entries = await Promise.all(
    (Object.keys(config.models) as PeerId[]).map(
      async (peer) => [peer, await resolveBestModel(config, peer)] as const,
    ),
  );
  const selections = Object.fromEntries(entries) as Partial<Record<PeerId, ModelSelection>>;
  for (const [peer, selection] of entries) {
    config.models[peer] = selection.selected;
    config.model_selection[peer] = selection;
  }
  return selections;
}
