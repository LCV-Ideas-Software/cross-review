const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /AIza[A-Za-z0-9_-]{20,}/g,
  /cfut_[A-Za-z0-9_-]{30,}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /npm_[A-Za-z0-9]{30,}/g,
  /re_[A-Za-z0-9_]{30,}/g,
  /xox[baprs]-[A-Za-z0-9-]{20,}/g,
  // v2.18.4 / Codex audit 2026-05-07 P1.2: xAI API keys have prefix
  // `xai-` and were not previously covered. Logs and session payloads
  // can persist provider error messages or environment dumps that
  // include the key, so adding this pattern closes a credential leak
  // surface at parity with sk-/sk-ant-/AIza/etc.
  /xai-[A-Za-z0-9_-]{20,}/g,
  /AKIA[A-Z0-9]{16}/g,
  /Bearer\s+[A-Za-z0-9._-]{20,}/gi,
  /[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
  // v2.4.0 / audit closure: env-style assignments. Catches `PASSWORD=value`
  // / `API_KEY="value"` / `SECRET: value` / `Authorization: token` shapes
  // that providers, smoke fixtures or stack traces sometimes echo back.
  // The replacement preserves the key name so audit consumers see WHICH
  // var was redacted, only the value is replaced. Mirrors the pattern in
  // v1's `REDACTION_PATTERNS`.
  // v2.25.1 (2026-05-11): exclude `\` from value char class. Without the
  // exclusion the {6,} quantifier would consume the JSON-escape backslash
  // in `token: write\"` (a peer-response string that survived round-1
  // serialization), replace `write\` → `[REDACTED]`, and leave a bare `"`
  // that closes the outer JSON string prematurely → corrupt meta.json.
  // Empirically observed in 3 sessions today (be47a5b0, 77c47284, 7edf63e3)
  // when the scorecard hotfix peer responses quoted `id-token: write` in
  // backtick-fenced YAML excerpts. Excluding `\` keeps the regex from
  // crossing JSON-escape boundaries.
  /\b((?:password|passwd|api[_-]?key|secret|token|access[_-]?key|auth(?:orization)?|bearer|private[_-]?key)\s*[:=]\s*["']?)([^\s"',}\\]{6,})/gi,
];

const PRIVATE_KEY_LABELS = [
  "PRIVATE KEY",
  "OPENSSH PRIVATE KEY",
  "EC PRIVATE KEY",
  "RSA PRIVATE KEY",
  "DSA PRIVATE KEY",
];

const PRIVATE_KEY_BEGIN_MARKERS = PRIVATE_KEY_LABELS.map((label) => `-----BEGIN ${label}-----`);
const PRIVATE_KEY_END_MARKERS = PRIVATE_KEY_LABELS.map((label) => `-----END ${label}-----`);

function findNextMarker(
  value: string,
  markers: readonly string[],
  fromIndex: number,
): { index: number; marker: string } | undefined {
  let found: { index: number; marker: string } | undefined;
  for (const marker of markers) {
    const index = value.indexOf(marker, fromIndex);
    if (index !== -1 && (!found || index < found.index)) {
      found = { index, marker };
    }
  }
  return found;
}

function findNextPrivateKeyMarker(
  value: string,
  fromIndex: number,
): { index: number; marker: string; side: "BEGIN" | "END" } | undefined {
  const begin = findNextMarker(value, PRIVATE_KEY_BEGIN_MARKERS, fromIndex);
  const end = findNextMarker(value, PRIVATE_KEY_END_MARKERS, fromIndex);
  if (!begin) return end ? { ...end, side: "END" } : undefined;
  if (!end) return { ...begin, side: "BEGIN" };
  return begin.index <= end.index ? { ...begin, side: "BEGIN" } : { ...end, side: "END" };
}

function redactPrivateKeyBlocks(value: string): string {
  let cursor = 0;
  let parts: string[] | undefined;

  while (cursor < value.length) {
    const begin = findNextMarker(value, PRIVATE_KEY_BEGIN_MARKERS, cursor);
    if (!begin) break;

    let depth = 1;
    let scan = begin.index + begin.marker.length;
    let close: { index: number; marker: string } | undefined;

    while (scan < value.length) {
      const marker = findNextPrivateKeyMarker(value, scan);
      if (!marker) break;

      scan = marker.index + marker.marker.length;
      if (marker.side === "BEGIN") {
        depth += 1;
        continue;
      }

      depth -= 1;
      if (depth === 0) {
        close = marker;
        break;
      }
    }

    parts ??= [];
    parts.push(value.slice(cursor, begin.index), "[REDACTED]");

    if (!close) {
      // v4.1.0 hardening: an unterminated PRIVATE KEY block (BEGIN
      // without a matching END — e.g. when a log/error message was
      // truncated mid-key by an upstream buffer cap) must STILL be
      // redacted from `begin.index` to the end of the input. The
      // pre-v4.1.0 implementation `break`-ed without pushing the
      // [REDACTED] token, then fell through to the `if (!parts) return
      // value` branch and leaked the partial key in plaintext to
      // events.ndjson / persistent logs. Marking the whole tail as
      // redacted preserves the no-leak guarantee for partial-key
      // payloads while still emitting a single [REDACTED] token.
      cursor = value.length;
      break;
    }

    cursor = close.index + close.marker.length;
  }

  if (!parts) return value;
  parts.push(value.slice(cursor));
  return parts.join("");
}

export function redact(value: string): string {
  let output = redactPrivateKeyBlocks(value);
  for (const re of SECRET_PATTERNS) {
    // The env-style assignment pattern uses two capture groups so that
    // the key name is preserved; the standalone-token patterns do not
    // capture and we replace the whole match. We dispatch on the regex
    // shape (`re.source.includes("(")`) but the safer signal is the
    // number of groups we declared — both env-style and JWT use groups,
    // but only the env-style declares two ((key)(value)). For the JWT
    // pattern we still replace the whole match because there is no key
    // half to preserve.
    output = output.replace(re, (...args) => {
      const groups = args.slice(1, -2).filter((g) => typeof g === "string");
      if (groups.length >= 2) {
        return `${groups[0]}[REDACTED]`;
      }
      return "[REDACTED]";
    });
  }
  return output;
}

export function redactJsonValue<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        redactJsonValue(child),
      ]),
    ) as T;
  }
  return value;
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return redact(error.message);
  return redact(String(error));
}
