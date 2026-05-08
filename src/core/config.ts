import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AppConfig, PeerId } from "./types.js";

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

export const VERSION = "2.18.6";
export const RELEASE_DATE = "2026-05-07";
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
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNTIME_ROOT = path.resolve(__dirname, "..", "..");
const PROJECT_ROOT =
  path.basename(RUNTIME_ROOT).toLowerCase() === "dist"
    ? path.resolve(RUNTIME_ROOT, "..")
    : RUNTIME_ROOT;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readWindowsRegistryEnv(name: string): string | undefined {
  if (process.platform !== "win32") return undefined;

  const roots = [
    "HKCU\\Environment",
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  ];

  for (const root of roots) {
    try {
      const output = execFileSync("reg", ["query", root, "/v", name], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      const match = output.match(
        new RegExp(`^\\s*${escapeRegExp(name)}\\s+REG_\\w+\\s+(.*)$`, "im"),
      );
      const value = match?.[1]?.trim();
      if (value) return value;
    } catch {
      // Missing values are expected when users store a key in another scope.
    }
  }

  return undefined;
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

function numberEnv(name: string): number | undefined {
  const parsed = Number.parseFloat(envValue(name) ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function listEnv(name: string): string[] {
  return (envValue(name) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
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
  }
}

function reasoningEffort(
  name: string,
  fallback: AppConfig["reasoning_effort"][PeerId],
): AppConfig["reasoning_effort"][PeerId] {
  const value = envValue(name);
  if (!value) return fallback;
  if (/^(none|minimal|low|medium|high|xhigh|max)$/i.test(value)) {
    return value.toLowerCase() as AppConfig["reasoning_effort"][PeerId];
  }
  return fallback;
}

export function loadConfig(): AppConfig {
  const configuredDataDir = envValue("CROSS_REVIEW_V2_DATA_DIR");
  const dataDir = configuredDataDir
    ? path.resolve(expandHome(configuredDataDir))
    : path.join(PROJECT_ROOT, "data");

  return {
    version: VERSION,
    data_dir: dataDir,
    log_level: envValue("CROSS_REVIEW_V2_LOG_LEVEL") || "info",
    stub: boolEnv("CROSS_REVIEW_V2_STUB", false),
    dashboard_port: intEnv("CROSS_REVIEW_V2_DASHBOARD_PORT", 4588),
    retry: {
      max_attempts: intEnv("CROSS_REVIEW_V2_RETRY_ATTEMPTS", 3),
      base_delay_ms: intEnv("CROSS_REVIEW_V2_RETRY_BASE_MS", 1000),
      max_delay_ms: intEnv("CROSS_REVIEW_V2_RETRY_MAX_MS", 30000),
      timeout_ms: intEnv("CROSS_REVIEW_V2_TIMEOUT_MS", 30 * 60 * 1000),
    },
    budget: {
      max_session_cost_usd: numberEnv("CROSS_REVIEW_V2_MAX_SESSION_COST_USD"),
      until_stopped_max_cost_usd: numberEnv("CROSS_REVIEW_V2_UNTIL_STOPPED_MAX_COST_USD"),
      preflight_max_round_cost_usd: numberEnv("CROSS_REVIEW_V2_PREFLIGHT_MAX_ROUND_COST_USD"),
      require_rates_for_budget: true,
      // v2.5.0: configurable fallback for run_until_unanimous when the
      // caller does not pass `max_rounds` and `until_stopped` is false.
      // The MCP zod schema still caps caller-supplied values at 32; this
      // controls the SERVER-side default (previously hardcoded to 8 in
      // orchestrator.ts). Values <=0 fall back to 8.
      default_max_rounds: intEnv("CROSS_REVIEW_V2_DEFAULT_MAX_ROUNDS", 8),
    },
    prompt: {
      max_task_chars: intEnv("CROSS_REVIEW_V2_MAX_TASK_CHARS", 8_000),
      max_review_focus_chars: intEnv("CROSS_REVIEW_V2_MAX_REVIEW_FOCUS_CHARS", 2_000),
      max_history_chars: intEnv("CROSS_REVIEW_V2_MAX_HISTORY_CHARS", 20_000),
      max_draft_chars: intEnv("CROSS_REVIEW_V2_MAX_DRAFT_CHARS", 40_000),
      max_prior_rounds: intEnv("CROSS_REVIEW_V2_MAX_PRIOR_ROUNDS", 5),
      max_peer_requests: intEnv("CROSS_REVIEW_V2_MAX_PEER_REQUESTS", 8),
      // v2.14.0 (path-A structural fix): see AppConfig type docs.
      max_attached_evidence_chars: intEnv("CROSS_REVIEW_V2_MAX_ATTACHED_EVIDENCE_CHARS", 80_000),
    },
    max_output_tokens: intEnv("CROSS_REVIEW_V2_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS),
    streaming: {
      events: boolEnv("CROSS_REVIEW_V2_STREAM_EVENTS", true),
      tokens: boolEnv("CROSS_REVIEW_V2_STREAM_TOKENS", true),
      include_text: boolEnv("CROSS_REVIEW_V2_STREAM_TEXT", false),
    },
    models: {
      codex: envValue("CROSS_REVIEW_OPENAI_MODEL") || "gpt-5.5",
      claude: envValue("CROSS_REVIEW_ANTHROPIC_MODEL") || "claude-opus-4-7",
      gemini: envValue("CROSS_REVIEW_GEMINI_MODEL") || "gemini-2.5-pro",
      deepseek: envValue("CROSS_REVIEW_DEEPSEEK_MODEL") || "deepseek-v4-pro",
      // v2.16.0 clarification: operator may choose `grok-4-latest`,
      // `grok-4.3`, `grok-4.20`, or `grok-4.20-reasoning` (xAI automatic
      // reasoning; no reasoning.effort body field) or
      // `grok-4.20-multi-agent` (explicit reasoning.effort supported) through
      // CROSS_REVIEW_GROK_MODEL. The adapter detects the chosen model
      // before deciding whether to send the reasoning field.
      grok: envValue("CROSS_REVIEW_GROK_MODEL") || "grok-4.20-multi-agent",
    },
    fallback_models: {
      codex: listEnv("CROSS_REVIEW_OPENAI_FALLBACK_MODELS"),
      claude: listEnv("CROSS_REVIEW_ANTHROPIC_FALLBACK_MODELS"),
      gemini: listEnv("CROSS_REVIEW_GEMINI_FALLBACK_MODELS"),
      deepseek: listEnv("CROSS_REVIEW_DEEPSEEK_FALLBACK_MODELS"),
      grok: listEnv("CROSS_REVIEW_GROK_FALLBACK_MODELS"),
    },
    reasoning_effort: {
      codex: reasoningEffort("CROSS_REVIEW_OPENAI_REASONING_EFFORT", "xhigh"),
      claude: reasoningEffort("CROSS_REVIEW_ANTHROPIC_REASONING_EFFORT", "xhigh"),
      deepseek: reasoningEffort("CROSS_REVIEW_DEEPSEEK_REASONING_EFFORT", "max"),
      grok: reasoningEffort("CROSS_REVIEW_GROK_REASONING_EFFORT", "xhigh"),
    },
    model_selection: {},
    api_keys: {
      codex: keyForPeer("codex"),
      claude: keyForPeer("claude"),
      gemini: keyForPeer("gemini"),
      deepseek: keyForPeer("deepseek"),
      grok: keyForPeer("grok"),
    },
    cost_rates: {
      codex: costRate(COST_RATE_ENV_PREFIX.codex),
      claude: costRate(COST_RATE_ENV_PREFIX.claude),
      gemini: costRate(COST_RATE_ENV_PREFIX.gemini),
      deepseek: costRate(COST_RATE_ENV_PREFIX.deepseek),
      grok: costRate(COST_RATE_ENV_PREFIX.grok),
    },
    evidence_judge_autowire: loadEvidenceJudgeAutowireConfig(),
    peer_enabled: loadPeerEnabledConfig(),
  };
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
  const peers: PeerId[] = ["codex", "claude", "gemini", "deepseek", "grok"];
  const result = {} as Record<PeerId, boolean>;
  for (const peer of peers) {
    const envName = `CROSS_REVIEW_V2_PEER_${peer.toUpperCase()}`;
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
        `[cross-review-v2] notice: ${envName}="${raw}" is not recognized; defaulting to "on". Recognized values: on/true/1/yes/enabled vs off/false/0/no/disabled.`,
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
  const rawMode = (process.env.CROSS_REVIEW_V2_EVIDENCE_JUDGE_AUTOWIRE_MODE ?? "")
    .trim()
    .toLowerCase();
  const rawPeer = (process.env.CROSS_REVIEW_V2_EVIDENCE_JUDGE_AUTOWIRE_PEER ?? "").trim();
  const rawConsensusPeers = (
    process.env.CROSS_REVIEW_V2_EVIDENCE_JUDGE_AUTOWIRE_CONSENSUS_PEERS ?? ""
  ).trim();
  const peerKnown: PeerId[] = ["codex", "claude", "gemini", "deepseek", "grok"];
  const peer = (peerKnown as readonly string[]).includes(rawPeer) ? (rawPeer as PeerId) : undefined;
  // v2.15.0 (item 1): parse consensus peers list. Comma-separated; only
  // peers that are members of PEERS are kept. Need >=2 valid entries
  // for consensus to apply (orchestrator guard); below 2 falls back to
  // single-peer autowire.
  const consensusPeers: PeerId[] = rawConsensusPeers
    ? rawConsensusPeers
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => (peerKnown as readonly string[]).includes(entry))
        .map((entry) => entry as PeerId)
    : [];
  const mode = rawMode === "" ? "off" : rawMode;
  // v2.14.0 (item 2): "active" promoted to first-class autowire mode.
  // v2.15.0 (item 1): consensus path also activates `active` when
  // consensus_peers >= 2 (single-peer field becomes optional in that case).
  const active =
    (mode === "shadow" || mode === "active") && (peer !== undefined || consensusPeers.length >= 2);
  // v2.12.0: preserve EXACT pre-v2.12 semantics. The legacy inline read
  // was `Number.parseInt(env ?? "8", 10) || 8` — this lets negative
  // values flow through (because `-5 || 8 === -5` in JS) so the
  // orchestrator's `Math.max(1, Math.min(100, cap))` clamps -5 to 1, NOT 8.
  // We don't use `intEnv` here because that helper has a `parsed > 0`
  // filter, which would change the consumer's clamp result for negatives.
  // codex R1 ship-review of v2.12.0 caught the divergence.
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
    process.env.CROSS_REVIEW_V2_EVIDENCE_JUDGE_MAX_ITEMS_PER_PASS ?? "4",
    10,
  );
  const maxItemsPerPass = Number.isFinite(rawCap) && rawCap !== 0 ? rawCap : 4;
  return {
    mode,
    peer,
    active,
    max_items_per_pass: maxItemsPerPass,
    configured_mode_raw: rawMode,
    configured_peer_raw: rawPeer,
    consensus_peers: consensusPeers,
    configured_consensus_peers_raw: rawConsensusPeers,
  };
}

export function missingFinancialControlVars(
  config: AppConfig,
  peers: PeerId[],
  options: { untilStopped?: boolean } = {},
): string[] {
  const missing = new Set<string>();

  if (config.budget.max_session_cost_usd == null) {
    missing.add("CROSS_REVIEW_V2_MAX_SESSION_COST_USD");
  }
  if (config.budget.preflight_max_round_cost_usd == null) {
    missing.add("CROSS_REVIEW_V2_PREFLIGHT_MAX_ROUND_COST_USD");
  }
  if (options.untilStopped && config.budget.until_stopped_max_cost_usd == null) {
    missing.add("CROSS_REVIEW_V2_UNTIL_STOPPED_MAX_COST_USD");
  }

  for (const peer of peers) {
    if (config.cost_rates[peer]) continue;
    const prefix = COST_RATE_ENV_PREFIX[peer];
    missing.add(`${prefix}_INPUT_USD_PER_MILLION`);
    missing.add(`${prefix}_OUTPUT_USD_PER_MILLION`);
  }

  return [...missing].sort();
}

function costRate(
  prefix: string,
): { input_per_million: number; output_per_million: number } | undefined {
  const input = numberEnv(`${prefix}_INPUT_USD_PER_MILLION`);
  const output = numberEnv(`${prefix}_OUTPUT_USD_PER_MILLION`);
  if (input == null || output == null) return undefined;
  return { input_per_million: input, output_per_million: output };
}
