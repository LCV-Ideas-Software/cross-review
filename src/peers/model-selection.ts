// v2.27.1 (cold-start hardening): SDK ctors lazy-loaded inside the
// per-provider model-listing helpers so the SDK module trees are not
// pulled at server boot. `resolveBestModels` only runs when an operator
// explicitly invokes model probing — paying the SDK load cost there is
// expected and amortized across all 6 peer probes (v3.7.0 / AUDIT-5:
// corrected stale "5" — the roster is 6 since Perplexity in v3.0.0) via
// the per-module promise cache shared with the runtime adapters.
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
  // v3.0.0: Perplexity Sonar API documents 4 models. Reference page
  // lists `sonar`, `sonar-pro`, `sonar-reasoning-pro`, and
  // `sonar-deep-research`. The Sonar API does NOT publish a
  // `models.list` endpoint via the OpenAI-SDK base path, so model
  // selection here is documented-priority only (no live API probe).
  perplexity: "https://docs.perplexity.ai/getting-started/models",
} satisfies Record<PeerId, string>;

// v3.7.2 (AUDIT-3, Codex 3rd super-audit + operator directive 2026-05-14):
// NO MODEL FALLBACK. Every peer is pinned to a SINGLE canonical model — the
// most advanced "pro" model with reasoning for that provider. Operator
// directive: "não quero fallback de modelos. É um único modelo pinado e
// pronto. E sempre o modelo mais avançado, pro, com reasoning."
// `selectFromCandidates` picks the first PRIORITY entry the provider's live
// list contains; with a lone entry it either selects that canonical model
// or falls through to the configured `fallback` (config.models[peer]) — it
// can NEVER silently auto-select an off-policy model. The only escape hatch
// is the explicit per-host env override (CROSS_REVIEW_<PROVIDER>_MODEL).
// Pre-v3.7.2 codex/claude/grok kept multi-entry same-provider chains and
// gemini/deepseek were trimmed in v3.7.1; this completes the trim for all 6.
const PRIORITY: Record<PeerId, string[]> = {
  codex: ["gpt-5.5"],
  claude: ["claude-opus-4-7"],
  gemini: ["gemini-2.5-pro"],
  deepseek: ["deepseek-v4-pro"],
  // grok-4-latest: operator-chosen canonical pin for cross-review
  // (directive 2026-05-14, superseding the prior grok-4.20-multi-agent
  // pin). It does automatic reasoning and must omit the explicit
  // `reasoning.effort` field — the adapter handles that via
  // `modelAcceptsReasoningEffort`.
  grok: ["grok-4-latest"],
  perplexity: ["sonar-reasoning-pro"],
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
    case "perplexity":
      return "CROSS_REVIEW_PERPLEXITY_MODEL";
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
      ? `Validated availability of the canonical pin in the provider's model API: ${priority.join(", ")}.`
      : candidates.length > 0
        ? `Model API returned candidates, but the canonical pin (${priority.join(", ")}) was not among them; keeping the canonical pin ${fallback} so the run fails visibly instead of silently downgrading (no-fallback policy, operator directive 2026-05-14).`
        : `Model API unavailable; keeping the canonical pin ${fallback} (no-fallback policy).`,
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
      ? `${envOverrideName(peer)} is set to the canonical pin; the explicit override is acknowledged but matches the canonical pin exactly.`
      : `${envOverrideName(peer)}='${value}' is set and differs from the canonical pin (${PRIORITY[peer].join(", ")}); honoring the operator override (the only legitimate non-canonical path) but flagging confidence=inferred so any provider 404 surfaces here.`,
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

// v3.0.0: Perplexity does NOT expose a public `models.list` endpoint
// via the OpenAI-SDK base path (the Sonar API is the only documented
// surface). Operators choose among the 4 documented Sonar models via
// CROSS_REVIEW_PERPLEXITY_MODEL; this resolver returns an empty live-
// candidate set so `selectFromCandidates` falls through to the
// documented PRIORITY list with confidence "inferred". The probe step
// in `peers/perplexity.ts` still validates that the API key works at
// boot via a minimal `disable_search` round-trip.
async function perplexityModels(config: AppConfig): Promise<ModelCandidate[]> {
  const apiKey = config.api_keys.perplexity;
  if (!apiKey) return [];
  return [];
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
    case "perplexity":
      return perplexityModels(config);
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
        "API key is missing in the current process; keeping the canonical pin until the key is available (no-fallback policy).",
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
