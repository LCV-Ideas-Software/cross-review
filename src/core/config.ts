import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCostRate } from "./cost.js";
import { applyFileConfigToEnv, inspectConfigFileFingerprint } from "./file-config.js";
import { type AppConfig, PEERS, type PeerId } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNTIME_ROOT = path.resolve(__dirname, "..", "..");
const PROJECT_ROOT =
  path.basename(RUNTIME_ROOT).toLowerCase() === "dist"
    ? path.resolve(RUNTIME_ROOT, "..")
    : RUNTIME_ROOT;

// v2.4.0 / audit closure (P3.12): tilde expansion for env-provided paths.
// `path.resolve` does NOT expand `~` to the user's home directory on any
// platform — operators routinely write `~/sessions` in env files and end
// up with a literal `~` directory. We honor `~`, `~/...`, and `~\...`
// (Windows) before resolving. The shell's `~user` syntax is intentionally
// NOT supported because it would require a passwd lookup.
function expandHome(rawPath: string): string {
  if (rawPath === "~") return os.homedir();
  if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return rawPath;
}

export const VERSION = "4.5.24";
export const RELEASE_DATE = releaseDateFromChangelog(VERSION);
export const DEFAULT_MAX_OUTPUT_TOKENS = 20_000;
const COST_RATE_ENV_PREFIX: Record<PeerId, string> = {
  codex: "CROSS_REVIEW_OPENAI",
  claude: "CROSS_REVIEW_ANTHROPIC",
  gemini: "CROSS_REVIEW_GEMINI",
  deepseek: "CROSS_REVIEW_DEEPSEEK",
  // v2.14.0: Grok pricing via env (no hardcoded defaults; operator
  // populates `CROSS_REVIEW_GROK_INPUT_USD_PER_MILLION` +
  // `CROSS_REVIEW_GROK_OUTPUT_USD_PER_MILLION`).
  grok: "CROSS_REVIEW_GROK",
  // v3.0.0: Perplexity pricing via env. Sonar API bills both per-token
  // (INPUT/OUTPUT) AND per-1000-requests where the fee scales with
  // search_context_size (REQUEST_FEE_LOW/MEDIUM/HIGH). Sonar Deep
  // Research model additionally bills citation_tokens, reasoning_tokens
  // and search_queries — those fields are optional and left undefined
  // for the other Perplexity models.
  perplexity: "CROSS_REVIEW_PERPLEXITY",
};

function releaseDateFromChangelog(version: string): string {
  const displayVersion = `v${version
    .split(".")
    .map((part) => part.padStart(2, "0"))
    .join(".")}`;
  const displayPattern = displayVersion.replaceAll(".", "\\.");
  const changelog = fs.readFileSync(path.join(PROJECT_ROOT, "CHANGELOG.md"), "utf8");
  const match = changelog.match(
    new RegExp(`^## \\[${displayPattern}\\] — (\\d{4}-\\d{2}-\\d{2})$`, "m"),
  );
  if (!match?.[1]) {
    throw new Error(`CHANGELOG.md missing release heading for ${displayVersion}`);
  }
  return match[1];
}

// v2.28.0 (cold-start hardening Part 3): single bulk read of the Windows
// registry environment scopes at first miss, then pure Map lookups. The
// previous per-var `reg query <root> /v NAME` design fired 2 subprocesses
// per missing env var (HKCU + HKLM, ~30 ms each). With ~140 config env
// vars consulted per `loadConfig()` and only some present in
// `process.env`, the missing-var fallback alone consumed 3-7 seconds of
// boot time on Windows — the dominant cost outside MCP SDK module load.
// Caching makes the cost O(1 + 2 registry reads) instead of O(N missing
// × 2 spawns). The cache is populated on the first call that would have
// gone to the registry; if `process.env` already has every var, it is
// never populated. Cross-process cache isolation is preserved (each Node
// process has its own).
let _winRegistryEnvCache: Map<string, string> | null = null;

// v3.7.0 (AUDIT-6, Codex super-audit 2026-05-14): cross-review's
// "API-only" claim means it does NOT execute caller-supplied shell or
// repo commands — it is not a CLI runner and never shells out on behalf
// of a caller. It DOES make a small number of fixed, internal process
// calls with constant arguments (this `reg query` for the Windows
// env-var fallback; `tasklist` for process-tree introspection in
// caller-tokens). Those args are constants or PID-derived, never
// caller-influenced. The precise statement is "no caller-supplied
// shell/repo execution", not "no child processes at all".
function loadWindowsRegistryEnvCache(): Map<string, string> {
  if (_winRegistryEnvCache) return _winRegistryEnvCache;
  const cache = new Map<string, string>();
  // HKCU wins over HKLM on collision (per Windows env-resolution order),
  // so populate HKLM first and overwrite with HKCU last.
  for (const root of [
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
    "HKCU\\Environment",
  ] as const) {
    try {
      const output = execFileSync("reg", ["query", root], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      // `reg query <root>` emits one line per value:
      //   <whitespace><Name><whitespace>REG_<TYPE><whitespace><Value>
      // Header lines (the root path itself) and blank lines are
      // filtered by the REG_<TYPE> token requirement.
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(
          /^\s*([^\s]+)\s+REG_(?:SZ|EXPAND_SZ|MULTI_SZ|DWORD|QWORD|BINARY)\s+(.*)$/,
        );
        if (!match) continue;
        const [, name, rawValue] = match;
        if (!name || rawValue == null) continue;
        cache.set(name, rawValue.trim());
      }
    } catch {
      // Missing root is unusual but not fatal — env-var lookups simply
      // fall back to `undefined` after the cache miss.
    }
  }
  _winRegistryEnvCache = cache;
  return cache;
}

function readWindowsRegistryEnv(name: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  return loadWindowsRegistryEnvCache().get(name);
}

function envValue(name: string): string | undefined {
  const processValue = process.env[name];
  if (processValue) return processValue;

  const registryValue = readWindowsRegistryEnv(name);
  if (registryValue) {
    process.env[name] = registryValue;
    return registryValue;
  }

  return undefined;
}

function boolEnv(name: string, fallback = false): boolean {
  const value = envValue(name);
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function intEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(envValue(name) ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalPositiveIntEnv(name: string): number | undefined {
  const raw = (envValue(name) ?? "").trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  console.error(
    `[cross-review] notice: ${name}="${raw}" must be a positive integer; ignoring this value.`,
  );
  return undefined;
}

function numberEnv(name: string): number | undefined {
  const raw = (envValue(name) ?? "").trim();
  if (raw === "") return undefined;
  const parsed = Number.parseFloat(raw);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  console.error(
    `[cross-review] notice: ${name}="${raw}" must be a non-negative number; ignoring this value.`,
  );
  return undefined;
}

function listEnv(name: string): string[] {
  return (envValue(name) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function logLevelEnv(name: string, fallback: AppConfig["log_level"]): AppConfig["log_level"] {
  const raw = (envValue(name) ?? "").trim().toLowerCase();
  if (raw === "") return fallback;
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  console.error(
    `[cross-review] notice: ${name}="${raw}" is not recognized; defaulting to "${fallback}". Recognized values: debug, info, warn, error.`,
  );
  return fallback;
}

function keyForPeer(peer: PeerId): string | undefined {
  switch (peer) {
    case "codex":
      return envValue("OPENAI_API_KEY");
    case "claude":
      return envValue("ANTHROPIC_API_KEY");
    case "gemini":
      return envValue("GEMINI_API_KEY");
    case "deepseek":
      return envValue("DEEPSEEK_API_KEY");
    // v2.14.0: Grok auth via GROK_API_KEY (canonical, operator-corrected
    // 2026-05-04 — peer name is "grok" not "xai", env var follows).
    case "grok":
      return envValue("GROK_API_KEY");
    // v3.0.0: Perplexity auth via PERPLEXITY_API_KEY (canonical per
    // docs.perplexity.ai). The Sonar API accepts the key as a Bearer
    // token in the Authorization header.
    case "perplexity":
      return envValue("PERPLEXITY_API_KEY");
  }
}

function reasoningEffort(
  name: string,
  fallback: AppConfig["reasoning_effort"][PeerId],
): AppConfig["reasoning_effort"][PeerId] {
  const value = envValue(name);
  if (!value) return fallback;
  if (/^(none|minimal|low|medium|high|xhigh|max|ultra)$/i.test(value)) {
    return value.toLowerCase() as AppConfig["reasoning_effort"][PeerId];
  }
  return fallback;
}

// v3.1.0: telemetry of the file-config load attempt; readers can call
// `getLastFileConfigResult()` to surface a boot notice or expose it via
// server_info. Not part of AppConfig (intentionally) so existing
// snapshots remain backward-compatible.
let LAST_FILE_CONFIG_RESULT: import("./file-config.js").ApplyFileConfigResult | undefined;

// prettier-ignore
export function getLastFileConfigResult():
  | import("./file-config.js").ApplyFileConfigResult
  | undefined {
  return LAST_FILE_CONFIG_RESULT;
}

export function getFileConfigRuntimeStatus():
  | (Omit<import("./file-config.js").ApplyFileConfigResult, "parse_error" | "model_cost_rates"> & {
      parse_error: string | null;
      live_reload_supported: false;
      current_file_exists: boolean;
      current_mtime_ms?: number | undefined;
      current_sha256?: string | undefined;
      current_read_error?: string | undefined;
      reload_required: boolean;
    })
  | undefined {
  const loaded = LAST_FILE_CONFIG_RESULT;
  if (!loaded) return undefined;
  const { model_cost_rates: _modelCostRates, ...runtimeLoaded } = loaded;
  const current = inspectConfigFileFingerprint(loaded.path);
  const reloadRequired =
    loaded.file_exists !== current.exists ||
    loaded.loaded_sha256 !== current.sha256 ||
    Boolean(current.read_error);
  return {
    ...runtimeLoaded,
    parse_error: loaded.parse_error ?? null,
    live_reload_supported: false,
    current_file_exists: current.exists,
    ...(current.mtime_ms === undefined ? {} : { current_mtime_ms: current.mtime_ms }),
    ...(current.sha256 === undefined ? {} : { current_sha256: current.sha256 }),
    ...(current.read_error === undefined ? {} : { current_read_error: current.read_error }),
    reload_required: reloadRequired,
  };
}

export function loadConfig(): AppConfig {
  const configuredDataDir = envValue("CROSS_REVIEW_DATA_DIR");
  const dataDir = configuredDataDir
    ? path.resolve(expandHome(configuredDataDir))
    : path.join(PROJECT_ROOT, "data");

  // v3.1.0 central config file: hydrate `process.env` with values from
  // `${dataDir}/config.json` (or path overridden via
  // CROSS_REVIEW_CONFIG_FILE) BEFORE any of the per-field readers
  // below consult envValue(). The file's contribution is a default
  // layer: env (process.env + Windows registry) wins, file second,
  // hardcoded defaults last. See src/core/file-config.ts for the
  // mapping table from structured JSON fields to flat env-var names.
  const fileConfigResult = applyFileConfigToEnv(dataDir, envValue);
  LAST_FILE_CONFIG_RESULT = fileConfigResult;

  return {
    version: VERSION,
    data_dir: dataDir,
    log_level: logLevelEnv("CROSS_REVIEW_LOG_LEVEL", "info"),
    stub: boolEnv("CROSS_REVIEW_STUB", false),
    dashboard_port: intEnv("CROSS_REVIEW_DASHBOARD_PORT", 4588),
    retry: {
      max_attempts: intEnv("CROSS_REVIEW_RETRY_ATTEMPTS", 3),
      base_delay_ms: intEnv("CROSS_REVIEW_RETRY_BASE_MS", 1000),
      max_delay_ms: intEnv("CROSS_REVIEW_RETRY_MAX_MS", 30000),
      timeout_ms: intEnv("CROSS_REVIEW_TIMEOUT_MS", 30 * 60 * 1000),
    },
    budget: {
      max_session_cost_usd: numberEnv("CROSS_REVIEW_MAX_SESSION_COST_USD"),
      until_stopped_max_cost_usd: numberEnv("CROSS_REVIEW_UNTIL_STOPPED_MAX_COST_USD"),
      preflight_max_round_cost_usd: numberEnv("CROSS_REVIEW_PREFLIGHT_MAX_ROUND_COST_USD"),
      require_rates_for_budget: true,
      // v2.5.0: configurable fallback for run_until_unanimous when the
      // caller does not pass `max_rounds` and `until_stopped` is false.
      // The MCP zod schema caps caller-supplied `max_rounds` at 1000
      // (v3.7.0 / AUDIT-5: corrected stale "32" in this comment); this
      // controls the SERVER-side default (previously hardcoded to 8 in
      // orchestrator.ts). Values <=0 fall back to 8.
      default_max_rounds: intEnv("CROSS_REVIEW_DEFAULT_MAX_ROUNDS", 8),
      // v2.25.0 (circular mode): maximum number of full rotations
      // permitted in a `mode: "circular"` session before the runtime
      // aborts with `circular_max_rotations_exceeded`. A "rotation" is
      // `rotation_order.length` rounds (one turn per non-caller peer).
      // The absolute round count depends on the enabled rotation order;
      // default 3 permits three complete turns through that order. This
      // is large enough that a well-behaved artifact converges, small
      // enough that runaway revisions abort within reasonable budget.
      // Empirical anchor: maestro-app circular sessions historically
      // converged within 2 rotations; 3 gives one safety margin.
      circular_max_rotations: intEnv("CROSS_REVIEW_CIRCULAR_MAX_ROTATIONS", 3),
    },
    prompt: {
      max_task_chars: intEnv("CROSS_REVIEW_MAX_TASK_CHARS", 8_000),
      max_review_focus_chars: intEnv("CROSS_REVIEW_MAX_REVIEW_FOCUS_CHARS", 2_000),
      max_history_chars: intEnv("CROSS_REVIEW_MAX_HISTORY_CHARS", 20_000),
      max_draft_chars: intEnv("CROSS_REVIEW_MAX_DRAFT_CHARS", 40_000),
      max_prior_rounds: intEnv("CROSS_REVIEW_MAX_PRIOR_ROUNDS", 5),
      max_peer_requests: intEnv("CROSS_REVIEW_MAX_PEER_REQUESTS", 8),
      // v2.14.0 (path-A structural fix): see AppConfig type docs.
      // v2.26.1 (2026-05-12): default raised 80_000 → 200_000 after the
      // stepsecurity v0.2.0 ship empirically demonstrated that 80K is
      // too low for multi-file evidence sets. session-store.ts:1507
      // computes `perFileCap = max(2_000, floor(totalCap * 0.6))`, then
      // each attachment consumes `min(perFileCap, totalCap - used)`. With
      // 5 attachments totaling ~95KB, the 4th+ attachments got truncated
      // because the budget was already exhausted (peers reported
      // `truncated to 33273 of 38412 bytes` while the file content
      // had legitimate 38KB). 200_000 default accommodates ~5 attachments
      // averaging ~30KB each before any per-file truncation. Operator
      // can still tune via CROSS_REVIEW_MAX_ATTACHED_EVIDENCE_CHARS.
      max_attached_evidence_chars: intEnv("CROSS_REVIEW_MAX_ATTACHED_EVIDENCE_CHARS", 200_000),
    },
    max_output_tokens: intEnv("CROSS_REVIEW_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS),
    max_output_tokens_by_peer: {
      codex: optionalPositiveIntEnv("CROSS_REVIEW_OPENAI_MAX_OUTPUT_TOKENS"),
      claude: optionalPositiveIntEnv("CROSS_REVIEW_ANTHROPIC_MAX_OUTPUT_TOKENS"),
      gemini: optionalPositiveIntEnv("CROSS_REVIEW_GEMINI_MAX_OUTPUT_TOKENS"),
      deepseek: optionalPositiveIntEnv("CROSS_REVIEW_DEEPSEEK_MAX_OUTPUT_TOKENS"),
      grok: optionalPositiveIntEnv("CROSS_REVIEW_GROK_MAX_OUTPUT_TOKENS"),
      perplexity: optionalPositiveIntEnv("CROSS_REVIEW_PERPLEXITY_MAX_OUTPUT_TOKENS"),
    },
    // v3.5.0 (CRV2-4): evidence preflight gate. Default ON — the check
    // is conservative (only trips on a completed-work claim with zero
    // evidence markers) and saves a full multi-round paid cross-review
    // on under-evidenced submissions. Operators set
    // CROSS_REVIEW_EVIDENCE_PREFLIGHT=off to disable.
    evidence_preflight_enabled: boolEnv("CROSS_REVIEW_EVIDENCE_PREFLIGHT", true),
    // v4.2.2: truthfulness preflight gate. Default ON — catches
    // current-runtime/version/model claims that contradict the runtime's
    // own facts before any paid peer calls. Operators set
    // CROSS_REVIEW_TRUTHFULNESS_PREFLIGHT=off to disable.
    truthfulness_preflight_enabled: boolEnv("CROSS_REVIEW_TRUTHFULNESS_PREFLIGHT", true),
    streaming: {
      events: boolEnv("CROSS_REVIEW_STREAM_EVENTS", true),
      tokens: boolEnv("CROSS_REVIEW_STREAM_TOKENS", true),
      include_text: boolEnv("CROSS_REVIEW_STREAM_TEXT", false),
    },
    models: {
      codex: envValue("CROSS_REVIEW_OPENAI_MODEL") || "gpt-5.6-sol",
      claude: envValue("CROSS_REVIEW_ANTHROPIC_MODEL") || "claude-fable-5",
      gemini: envValue("CROSS_REVIEW_GEMINI_MODEL") || "gemini-3.1-pro-preview",
      deepseek: envValue("CROSS_REVIEW_DEEPSEEK_MODEL") || "deepseek-v4-pro",
      // v4.5.0 (provider-doc refresh 2026-07-10): Grok 4.5 is xAI's
      // frontier coding/agentic model. Keep the concrete id so model
      // selection, reasoning clamps and model-aware pricing stay stable.
      grok: envValue("CROSS_REVIEW_GROK_MODEL") || "grok-4.5",
      // v3.0.0 (operator directive 2026-05-12): Perplexity default
      // `sonar-reasoning-pro` — reasoning + grounding + chain-of-thought,
      // best fit for cross-review where the peer must reason about the
      // attached draft (not just fact-lookup). Operator can override via
      // CROSS_REVIEW_PERPLEXITY_MODEL to switch to `sonar`, `sonar-pro`,
      // or `sonar-deep-research`. The adapter validates the chosen model
      // against the documented allowlist at call time.
      perplexity: envValue("CROSS_REVIEW_PERPLEXITY_MODEL") || "sonar-reasoning-pro",
    },
    fallback_models: {
      codex: listEnv("CROSS_REVIEW_OPENAI_FALLBACK_MODELS"),
      claude: listEnv("CROSS_REVIEW_ANTHROPIC_FALLBACK_MODELS"),
      gemini: listEnv("CROSS_REVIEW_GEMINI_FALLBACK_MODELS"),
      deepseek: listEnv("CROSS_REVIEW_DEEPSEEK_FALLBACK_MODELS"),
      grok: listEnv("CROSS_REVIEW_GROK_FALLBACK_MODELS"),
      perplexity: listEnv("CROSS_REVIEW_PERPLEXITY_FALLBACK_MODELS"),
    },
    reasoning_effort: {
      // Sol and Fable both document `max` on their API surfaces. Central
      // config and env inputs also accept `ultra` as an operator-facing
      // compatibility alias; each adapter normalizes it before transmission.
      codex: reasoningEffort("CROSS_REVIEW_OPENAI_REASONING_EFFORT", "max"),
      claude: reasoningEffort("CROSS_REVIEW_ANTHROPIC_REASONING_EFFORT", "max"),
      // Gemini 3.1 Pro exposes native LOW/MEDIUM/HIGH thinking levels.
      // The file-config loader already emits this environment key; keeping it
      // here is what makes central-config reloads actually reach the adapter.
      gemini: reasoningEffort("CROSS_REVIEW_GEMINI_REASONING_EFFORT", "high"),
      deepseek: reasoningEffort("CROSS_REVIEW_DEEPSEEK_REASONING_EFFORT", "max"),
      // Grok 4.5 accepts only low|medium|high. Keeping the canonical default
      // directly representable avoids relying on adapter-side clamping.
      grok: reasoningEffort("CROSS_REVIEW_GROK_REASONING_EFFORT", "high"),
      // v3.0.0: Perplexity Sonar API only accepts `minimal|low|medium|high`
      // for sonar-reasoning-pro / sonar-deep-research (other models
      // ignore the field entirely). Default `high` matches the
      // canonical "max reasoning per peer" stance the other peers take
      // (xhigh/max for OpenAI/Anthropic/Grok/DeepSeek). The adapter
      // clamps the internal scale (`xhigh`/`max`/`ultra`) to `high` for
      // Perplexity.
      perplexity: reasoningEffort("CROSS_REVIEW_PERPLEXITY_REASONING_EFFORT", "high"),
    },
    model_selection: {},
    api_keys: {
      codex: keyForPeer("codex"),
      claude: keyForPeer("claude"),
      gemini: keyForPeer("gemini"),
      deepseek: keyForPeer("deepseek"),
      grok: keyForPeer("grok"),
      perplexity: keyForPeer("perplexity"),
    },
    cost_rates: {
      codex: costRate(COST_RATE_ENV_PREFIX.codex),
      claude: costRate(COST_RATE_ENV_PREFIX.claude),
      gemini: costRate(COST_RATE_ENV_PREFIX.gemini),
      deepseek: costRate(COST_RATE_ENV_PREFIX.deepseek),
      grok: costRate(COST_RATE_ENV_PREFIX.grok),
      perplexity: costRate(COST_RATE_ENV_PREFIX.perplexity),
    },
    model_cost_rates: normalizeModelCostRates(fileConfigResult.model_cost_rates),
    evidence_judge_autowire: loadEvidenceJudgeAutowireConfig(),
    peer_enabled: loadPeerEnabledConfig(),
    cache: loadCacheConfig(),
    perplexity: loadPerplexityConfig(),
  };
}

function normalizeModelCostRates(
  source: import("./file-config.js").FileConfig["model_cost_rates"],
): AppConfig["model_cost_rates"] {
  const normalized: AppConfig["model_cost_rates"] = {};
  if (!source) return normalized;
  for (const [peer, cards] of Object.entries(source) as [
    PeerId,
    NonNullable<NonNullable<typeof source>[PeerId]>,
  ][]) {
    const normalizedCards: NonNullable<NonNullable<AppConfig["model_cost_rates"]>[PeerId]> = {};
    for (const [model, rawCard] of Object.entries(cards)) {
      const { promo_expires_at_utc: promoExpiresAt, ...card } = rawCard;
      normalizedCards[model] = {
        ...card,
        ...(promoExpiresAt == null ? {} : { promo_expires_at: promoExpiresAt }),
      };
    }
    normalized[peer] = normalizedCards;
  }
  return normalized;
}

// v3.0.0 (Perplexity 6th peer): per-call Perplexity-specific knobs.
// `search_context_size` controls the breadth of the web search and
// drives both quality AND per-1000-request fee (low=$5-6 / medium=$8-10
// / high=$12-14 depending on model). Default `low` minimizes noise
// and cost for cross-review use (peer reasons about attached draft;
// search is a fact-check overlay). `disable_search` turns off the
// web-search component entirely (peer becomes a pure LLM) but does not
// remove Perplexity's context-tier request fee. Default `false` per operator directive
// 2026-05-12 — search-active is the differentiator versus the other 5
// peers.
function loadPerplexityConfig(): AppConfig["perplexity"] {
  const sizeRaw = (envValue("CROSS_REVIEW_PERPLEXITY_SEARCH_CONTEXT_SIZE") ?? "")
    .trim()
    .toLowerCase();
  const probeModeRaw = (envValue("CROSS_REVIEW_PERPLEXITY_PROBE_MODE") ?? "").trim().toLowerCase();
  let searchContextSize: AppConfig["perplexity"]["search_context_size"] = "low";
  if (sizeRaw === "medium" || sizeRaw === "high") {
    searchContextSize = sizeRaw;
  } else if (sizeRaw !== "" && sizeRaw !== "low") {
    console.error(
      `[cross-review] notice: CROSS_REVIEW_PERPLEXITY_SEARCH_CONTEXT_SIZE="${sizeRaw}" not recognized; defaulting to "low". Recognized values: low, medium, high.`,
    );
  }
  let probeMode: AppConfig["perplexity"]["probe_mode"] = "auth_only";
  if (probeModeRaw === "live") {
    probeMode = "live";
  } else if (probeModeRaw !== "" && probeModeRaw !== "auth_only") {
    console.error(
      `[cross-review] notice: CROSS_REVIEW_PERPLEXITY_PROBE_MODE="${probeModeRaw}" not recognized; defaulting to "auth_only". Recognized values: auth_only, live.`,
    );
  }
  return {
    search_context_size: searchContextSize,
    disable_search: boolEnv("CROSS_REVIEW_PERPLEXITY_DISABLE_SEARCH", false),
    probe_mode: probeMode,
  };
}

// v2.21.0 (caching): config loader. Default ON; switch off via
// CROSS_REVIEW_DISABLE_CACHE=true (operator panic button when a
// provider misbehaves or the operator wants strictly-fresh runs for
// audit reproducibility). TTL options gated to the documented values
// to prevent typos silently sending nonsense to providers — Anthropic
// API rejects unknown ttl values with 400. OpenAI does NOT publish
// per-call retention values; we still parse the env so future
// migrations can flip the default without touching adapter code.
function loadCacheConfig(): AppConfig["cache"] {
  const enabled = !boolEnv("CROSS_REVIEW_DISABLE_CACHE", false);
  const schemaVersion = (envValue("CROSS_REVIEW_CACHE_SCHEMA_VERSION") ?? "v1").trim() || "v1";
  const anthropicTtl = parseTtlEnv("CROSS_REVIEW_CACHE_TTL_ANTHROPIC", "1h");
  const openaiTtl = parseTtlEnv("CROSS_REVIEW_CACHE_TTL_OPENAI", "1h");
  // v3.7.5 (A3, logs+sessions study 2026-05-15): per-provider cache
  // disable. Default for Anthropic (claude) is `true` (cache off) based
  // on empirical $1.18 wasted to save $0.0035 over 244 sessions
  // (0.3% hit-rate). All other providers default `false` (cache on,
  // preserving v2.21.0 behavior). Operators may flip any per-provider
  // flag via `CROSS_REVIEW_DISABLE_CACHE_<PROVIDER>` (`true|false`).
  // Recognized truthy values match the parser used by peer_enabled:
  // on/true/1/yes/enabled (case-insensitive). Anything else is "off".
  // v3.7.5 (A3): env vars use PROVIDER names (ANTHROPIC/OPENAI/...) matching
  // the v2.21.0 TTL convention (`CROSS_REVIEW_CACHE_TTL_ANTHROPIC` +
  // `CROSS_REVIEW_CACHE_TTL_OPENAI`). Internal `disable_per_peer` is
  // keyed by PeerId (claude/codex/...). Mapping below is the only place
  // provider names cross with peer ids.
  const disablePerPeer: Record<PeerId, boolean> = {
    codex: parseDisableCacheEnv("CROSS_REVIEW_DISABLE_CACHE_OPENAI", false),
    claude: parseDisableCacheEnv("CROSS_REVIEW_DISABLE_CACHE_ANTHROPIC", true),
    gemini: parseDisableCacheEnv("CROSS_REVIEW_DISABLE_CACHE_GEMINI", false),
    deepseek: parseDisableCacheEnv("CROSS_REVIEW_DISABLE_CACHE_DEEPSEEK", false),
    grok: parseDisableCacheEnv("CROSS_REVIEW_DISABLE_CACHE_GROK", false),
    perplexity: parseDisableCacheEnv("CROSS_REVIEW_DISABLE_CACHE_PERPLEXITY", false),
  };
  return {
    schema_version: schemaVersion,
    enabled,
    ttl: {
      anthropic: anthropicTtl,
      openai: openaiTtl,
    },
    disable_per_peer: disablePerPeer,
  };
}

// v3.7.5 (A3): per-provider cache-disable env var parser. Same shape as
// the peer_enabled parser but with a per-call default since Anthropic
// defaults true and others default false.
function parseDisableCacheEnv(name: string, fallback: boolean): boolean {
  const raw = (envValue(name) ?? "").trim().toLowerCase();
  if (raw === "") return fallback;
  if (/^(on|true|1|yes|enabled)$/i.test(raw)) return true;
  if (/^(off|false|0|no|disabled)$/i.test(raw)) return false;
  console.error(
    `[cross-review] notice: ${name}="${raw}" is not recognized; defaulting to "${fallback ? "on" : "off"}". Recognized values: on/true/1/yes/enabled vs off/false/0/no/disabled.`,
  );
  return fallback;
}

function parseTtlEnv(name: string, fallback: "5m" | "1h"): "5m" | "1h" {
  const raw = (envValue(name) ?? "").trim().toLowerCase();
  if (raw === "5m" || raw === "1h") return raw;
  if (raw !== "") {
    console.error(
      `[cross-review] notice: ${name}="${raw}" not recognized; defaulting to "${fallback}". Recognized values: 5m, 1h.`,
    );
  }
  return fallback;
}

// v2.14.0 (operator directive 2026-05-04): per-peer enable/disable
// parser. Default `on` for every peer. Recognized truthy values:
// "on", "true", "1", "yes", "enabled". Recognized falsy: "off",
// "false", "0", "no", "disabled". Unrecognized values fall back to
// `on` with a stderr warning so a typo never silently disables a peer.
// Boot-time minimum-2-enabled validation lives at the boundary
// (orchestrator construction) — keeping the parser pure makes it easy
// to test in isolation.
function loadPeerEnabledConfig(): Record<PeerId, boolean> {
  const result = {} as Record<PeerId, boolean>;
  for (const peer of PEERS) {
    const envName = `CROSS_REVIEW_PEER_${peer.toUpperCase()}`;
    const raw = (envValue(envName) ?? "").trim().toLowerCase();
    if (raw === "") {
      result[peer] = true;
      continue;
    }
    if (/^(on|true|1|yes|enabled)$/i.test(raw)) {
      result[peer] = true;
    } else if (/^(off|false|0|no|disabled)$/i.test(raw)) {
      result[peer] = false;
    } else {
      console.error(
        `[cross-review] notice: ${envName}="${raw}" is not recognized; defaulting to "on". Recognized values: on/true/1/yes/enabled vs off/false/0/no/disabled.`,
      );
      result[peer] = true;
    }
  }
  return result;
}

// v2.12.0: parse the judge auto-wire env vars into a typed struct that
// server_info, the boot notice and the orchestrator share. Invalid
// values do NOT throw — `mode` keeps the literal string for the boot
// notice, `peer` is undefined when not in PEERS, `active` is true iff
// the runtime will actually emit shadow_decision events.
function loadEvidenceJudgeAutowireConfig(): import("./types.js").EvidenceJudgeAutowireConfig {
  const rawMode = (envValue("CROSS_REVIEW_EVIDENCE_JUDGE_AUTOWIRE_MODE") ?? "")
    .trim()
    .toLowerCase();
  const rawPeer = (envValue("CROSS_REVIEW_EVIDENCE_JUDGE_AUTOWIRE_PEER") ?? "").trim();
  const rawConsensusPeers = (
    envValue("CROSS_REVIEW_EVIDENCE_JUDGE_AUTOWIRE_CONSENSUS_PEERS") ?? ""
  ).trim();
  const peer = (PEERS as readonly string[]).includes(rawPeer) ? (rawPeer as PeerId) : undefined;
  // v2.15.0 (item 1): parse consensus peers list. Comma-separated; only
  // peers that are members of PEERS are kept. Need >=2 valid entries
  // for consensus to apply (orchestrator guard); below 2 falls back to
  // single-peer autowire.
  const consensusPeers: PeerId[] = rawConsensusPeers
    ? rawConsensusPeers
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => (PEERS as readonly string[]).includes(entry))
        .map((entry) => entry as PeerId)
    : [];
  const mode = rawMode === "" ? "off" : rawMode;
  // v2.14.0 (item 2): "active" promoted to first-class autowire mode.
  // v2.15.0 (item 1): consensus path also activates `active` when
  // consensus_peers >= 2 (single-peer field becomes optional in that case).
  const active =
    (mode === "shadow" || mode === "active") && (peer !== undefined || consensusPeers.length >= 2);
  // v4.4.1: parse as a positive integer at the config boundary. Older
  // versions let negative typo values flow through to the orchestrator's
  // clamp; that preserved history but made `server_info` expose an
  // impossible negative `max_items_per_pass`.
  // v2.18.4 / Codex audit 2026-05-07 P1.4: defensive cap reduction
  // 8 → 4. Math: with default consensus_peers=4 (codex+gemini+
  // deepseek+grok), worst-case round fires `consensus_peers ×
  // max_items_per_pass = 4 × 8 = 32` paid judge calls per round.
  // Lowering the default to 4 puts the worst case at `4 × 4 = 16`
  // paid calls, halving the budget exposure without a code change.
  // Operators wanting the prior 8 (or higher) set the env-var
  // explicitly. Single-peer mode goes from 1×8=8 to 1×4=4 — a coverage
  // reduction, but the operator can always raise via env-var. This
  // is a *default* change, not a hard cap.
  const rawCap = Number.parseInt(
    envValue("CROSS_REVIEW_EVIDENCE_JUDGE_MAX_ITEMS_PER_PASS") ?? "4",
    10,
  );
  const maxItemsPerPass = Number.isFinite(rawCap) && rawCap > 0 ? rawCap : 4;
  const rawOutputCap = Number.parseInt(
    envValue("CROSS_REVIEW_EVIDENCE_JUDGE_MAX_OUTPUT_TOKENS") ?? "2048",
    10,
  );
  const maxOutputTokens =
    Number.isFinite(rawOutputCap) && rawOutputCap >= 256 ? rawOutputCap : 2048;
  const judgeReasoningEffort =
    reasoningEffort("CROSS_REVIEW_EVIDENCE_JUDGE_REASONING_EFFORT", "medium") ?? "medium";
  return {
    mode,
    peer,
    active,
    max_items_per_pass: maxItemsPerPass,
    max_output_tokens: maxOutputTokens,
    reasoning_effort: judgeReasoningEffort,
    configured_mode_raw: rawMode,
    configured_peer_raw: rawPeer,
    consensus_peers: consensusPeers,
    configured_consensus_peers_raw: rawConsensusPeers,
  };
}

function addMissingPerplexityDimensions(
  config: AppConfig,
  effectiveModel: string,
  missing: Set<string>,
): void {
  const normalizedModel = effectiveModel.trim().replace(/^models\//i, "");
  const rate = resolveCostRate(config, "perplexity", effectiveModel);
  if (!rate) return;
  const rateRecord = rate as unknown as Record<string, unknown>;
  const isPrimary = normalizedModel === config.models.perplexity.trim().replace(/^models\//i, "");
  const addField = (field: string, envSuffix: string) => {
    if (rateRecord[field] != null) return;
    missing.add(
      isPrimary
        ? `${COST_RATE_ENV_PREFIX.perplexity}_${envSuffix}`
        : `model_cost_rates.perplexity[${JSON.stringify(effectiveModel)}].${field}`,
    );
  };

  if (["sonar", "sonar-pro", "sonar-reasoning-pro"].includes(normalizedModel)) {
    const size = config.perplexity.search_context_size;
    if (size === "high") {
      addField("request_fee_high_per_1000", "REQUEST_FEE_HIGH_USD_PER_1000_REQUESTS");
    } else if (size === "medium") {
      addField("request_fee_medium_per_1000", "REQUEST_FEE_MEDIUM_USD_PER_1000_REQUESTS");
    } else {
      addField("request_fee_low_per_1000", "REQUEST_FEE_LOW_USD_PER_1000_REQUESTS");
    }
    return;
  }

  if (normalizedModel === "sonar-deep-research") {
    addField("citation_tokens_per_million", "CITATION_TOKENS_USD_PER_MILLION");
    addField(
      "deep_research_reasoning_tokens_per_million",
      "DEEP_RESEARCH_REASONING_TOKENS_USD_PER_MILLION",
    );
    addField("search_queries_per_1000", "SEARCH_QUERIES_USD_PER_1000_REQUESTS");
    // These three dimensions are provider-controlled and have no documented
    // pre-dispatch cap. A rate card makes post-call accounting exact, but it
    // cannot make a hard cost preflight truthful.
    missing.add("CROSS_REVIEW_PERPLEXITY_DEEP_RESEARCH_PREFLIGHT_UNBOUNDED");
  }
}

export function missingFinancialControlVars(
  config: AppConfig,
  peers: PeerId[],
  options: { untilStopped?: boolean | undefined } = {},
): string[] {
  const missing = new Set<string>();
  const configLoad = getFileConfigRuntimeStatus();
  if (configLoad?.file_exists && configLoad.parse_error) {
    missing.add("CROSS_REVIEW_CONFIG_FILE_INVALID");
  }
  if (configLoad?.reload_required) {
    missing.add("CROSS_REVIEW_CONFIG_RELOAD_REQUIRED");
  }

  if (config.budget.max_session_cost_usd == null) {
    missing.add("CROSS_REVIEW_MAX_SESSION_COST_USD");
  }
  if (config.budget.preflight_max_round_cost_usd == null) {
    missing.add("CROSS_REVIEW_PREFLIGHT_MAX_ROUND_COST_USD");
  }
  if (options.untilStopped && config.budget.until_stopped_max_cost_usd == null) {
    missing.add("CROSS_REVIEW_UNTIL_STOPPED_MAX_COST_USD");
  }

  for (const peer of peers) {
    if (resolveCostRate(config, peer, config.models[peer])) continue;
    const prefix = COST_RATE_ENV_PREFIX[peer];
    missing.add(`${prefix}_INPUT_USD_PER_MILLION`);
    missing.add(`${prefix}_OUTPUT_USD_PER_MILLION`);
  }

  for (const peer of peers) {
    for (const fallbackModel of config.fallback_models[peer] ?? []) {
      if (resolveCostRate(config, peer, fallbackModel)) continue;
      missing.add(`model_cost_rates.${peer}[${JSON.stringify(fallbackModel)}]`);
    }
  }

  // Perplexity has model-specific non-token dimensions. Apply the same
  // fail-closed contract to the primary pin and every fallback: regular Sonar
  // products require the active context-tier request fee, while Deep Research
  // requires citation, reasoning and search-query rates. A complete
  // input/output card alone is not a complete financial control for either.
  if (peers.includes("perplexity")) {
    const effectiveModels = [
      config.models.perplexity,
      ...(config.fallback_models.perplexity ?? []),
    ];
    for (const model of new Set(effectiveModels)) {
      addMissingPerplexityDimensions(config, model, missing);
    }
  }

  return [...missing].sort();
}

// v2.26.0: cost rate parser expanded to a complete pricing model.
// Required: _INPUT_USD_PER_MILLION + _OUTPUT_USD_PER_MILLION (backward
// compat). Optional extensions:
//   - Extended tier (≤ vs > threshold): _INPUT_EXTENDED, _OUTPUT_EXTENDED
//   - Cache pricing: _CACHE_READ, _CACHE_WRITE, _CACHE_READ_EXTENDED,
//     _CACHE_WRITE_EXTENDED
//   - Promo pricing (limited-time discount): _PROMO_INPUT, _PROMO_OUTPUT,
//     _PROMO_INPUT_EXTENDED, _PROMO_OUTPUT_EXTENDED, _PROMO_CACHE_READ,
//     _PROMO_CACHE_WRITE, _PROMO_CACHE_READ_EXTENDED,
//     _PROMO_CACHE_WRITE_EXTENDED, _PROMO_EXPIRES_AT_UTC (ISO 8601)
//   - Tier threshold: _THRESHOLD_TOKENS (e.g., 200000 for Gemini)
// Selection logic (in cost.ts selectRate()): if today < promo_expires_at
// AND a corresponding promo field is set, use promo. Else if total input
// tokens > threshold AND extended field is set, use extended. Else use
// base. Each category (input/output/cache_read/cache_write) selects
// independently.
function costRate(
  prefix: string,
): NonNullable<import("./types.js").AppConfig["cost_rates"]["codex"]> | undefined {
  const input = numberEnv(`${prefix}_INPUT_USD_PER_MILLION`);
  const output = numberEnv(`${prefix}_OUTPUT_USD_PER_MILLION`);
  if (input == null || output == null) return undefined;
  const opt = (suffix: string): number | undefined => numberEnv(`${prefix}_${suffix}`) ?? undefined;
  const promoExpiresRaw = envValue(`${prefix}_PROMO_EXPIRES_AT_UTC`);
  const thresholdTokensRaw = numberEnv(`${prefix}_THRESHOLD_TOKENS`);
  const rate: NonNullable<import("./types.js").AppConfig["cost_rates"]["codex"]> = {
    input_per_million: input,
    output_per_million: output,
  };
  const fields: [keyof typeof rate, string][] = [
    ["input_extended_per_million", "INPUT_EXTENDED_USD_PER_MILLION"],
    ["output_extended_per_million", "OUTPUT_EXTENDED_USD_PER_MILLION"],
    ["cache_read_per_million", "CACHE_READ_USD_PER_MILLION"],
    ["cache_write_per_million", "CACHE_WRITE_USD_PER_MILLION"],
    ["cache_read_extended_per_million", "CACHE_READ_EXTENDED_USD_PER_MILLION"],
    ["cache_write_extended_per_million", "CACHE_WRITE_EXTENDED_USD_PER_MILLION"],
    ["promo_input_per_million", "PROMO_INPUT_USD_PER_MILLION"],
    ["promo_output_per_million", "PROMO_OUTPUT_USD_PER_MILLION"],
    ["promo_input_extended_per_million", "PROMO_INPUT_EXTENDED_USD_PER_MILLION"],
    ["promo_output_extended_per_million", "PROMO_OUTPUT_EXTENDED_USD_PER_MILLION"],
    ["promo_cache_read_per_million", "PROMO_CACHE_READ_USD_PER_MILLION"],
    ["promo_cache_write_per_million", "PROMO_CACHE_WRITE_USD_PER_MILLION"],
    ["promo_cache_read_extended_per_million", "PROMO_CACHE_READ_EXTENDED_USD_PER_MILLION"],
    ["promo_cache_write_extended_per_million", "PROMO_CACHE_WRITE_EXTENDED_USD_PER_MILLION"],
    // v3.0.0 (Perplexity 6th peer): Perplexity bills both per-token AND
    // per-1000-requests where the request fee scales with
    // `search_context_size`. Other peers' costRate calls leave these
    // suffixes undefined; perplexity costRate (env prefix
    // CROSS_REVIEW_PERPLEXITY) sets them when operator configures them.
    ["request_fee_low_per_1000", "REQUEST_FEE_LOW_USD_PER_1000_REQUESTS"],
    ["request_fee_medium_per_1000", "REQUEST_FEE_MEDIUM_USD_PER_1000_REQUESTS"],
    ["request_fee_high_per_1000", "REQUEST_FEE_HIGH_USD_PER_1000_REQUESTS"],
    // v3.0.0 (Perplexity Sonar Deep Research): three distinct line
    // items billed separately from input/output. Other Sonar models
    // (sonar / sonar-pro / sonar-reasoning-pro) leave these undefined.
    ["citation_tokens_per_million", "CITATION_TOKENS_USD_PER_MILLION"],
    [
      "deep_research_reasoning_tokens_per_million",
      "DEEP_RESEARCH_REASONING_TOKENS_USD_PER_MILLION",
    ],
    ["search_queries_per_1000", "SEARCH_QUERIES_USD_PER_1000_REQUESTS"],
  ];
  for (const [key, suffix] of fields) {
    const value = opt(suffix);
    if (value != null) {
      (rate as unknown as Record<string, unknown>)[key as string] = value;
    }
  }
  if (thresholdTokensRaw != null && thresholdTokensRaw > 0) {
    rate.threshold_tokens = Math.floor(thresholdTokensRaw);
  }
  if (promoExpiresRaw && promoExpiresRaw.trim() !== "") {
    const trimmed = promoExpiresRaw.trim();
    // Validate ISO 8601 parseability so a typo doesn't silently disable promo.
    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) {
      console.error(
        `[cross-review] notice: ${prefix}_PROMO_EXPIRES_AT_UTC="${trimmed}" is not a valid ISO 8601 timestamp; promo rates will be ignored.`,
      );
    } else {
      rate.promo_expires_at = trimmed;
    }
  }
  return rate;
}
