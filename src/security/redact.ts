const SECRET_PATTERNS = [
  // Native key prefixes start at a token boundary, not inside an ordinary
  // identifier such as signed-exit-ask-peers-independent-green.json.
  /(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9_])sk-ant-[A-Za-z0-9_-]{20,}/g,
  /AIza[A-Za-z0-9_-]{20,}/g,
  /cfut_[A-Za-z0-9_-]{30,}/g,
  // v4.5.44 / issue #215: ghs_ installation tokens migrated to a stateless
  // JWT shape (base64url segments joined by dots). The extended class MUST
  // run before the opaque gh-prefix pattern below: a partial match of the
  // first segment would strand the payload/signature AND break the generic
  // JWT pattern's 32-char first-segment expectation. {30,} keeps classic
  // opaque ghs_ tokens covered by this same pattern.
  /ghs_[A-Za-z0-9._-]{30,}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /npm_[A-Za-z0-9]{30,}/g,
  // Resend keys begin at a token boundary; do not restart inside ordinary
  // identifiers such as bare_async_failure_records_its_shape.
  /(?<![A-Za-z0-9_])re_[A-Za-z0-9_]{30,}/g,
  /xox[baprs]-[A-Za-z0-9-]{20,}/g,
  // v2.18.4 / Codex audit 2026-05-07 P1.2: xAI API keys have prefix
  // `xai-` and were not previously covered. Logs and session payloads
  // can persist provider error messages or environment dumps that
  // include the key, so adding this pattern closes a credential leak
  // surface at parity with sk-/sk-ant-/AIza/etc.
  /xai-[A-Za-z0-9_-]{20,}/g,
  /pplx-[A-Za-z0-9_-]{20,}/g,
  /AKIA[A-Z0-9]{16}/g,
  /Bearer\s+[A-Za-z0-9._-]{20,}/gi,
  /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
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
  /(?<![\w-])((?:[a-z0-9]+[_-])*(?:password|passwd|api[_-]?key|secret|token|access[_-]?key|auth(?:orization)?|bearer|private[_-]?key)\s*(?:["']\s*)?[:=]\s*["']?)([^\s"',}\\]{6,})/gi,
];

const SECRET_FIELD_PATTERN =
  /^(?:[a-z0-9]+[_-])*(?:password|passwd|api[_-]?key|secret|token|access[_-]?key|auth(?:orization)?|bearer|private[_-]?key)$/i;

const PRIVATE_KEY_LABELS = [
  "PRIVATE KEY",
  "OPENSSH PRIVATE KEY",
  "EC PRIVATE KEY",
  "RSA PRIVATE KEY",
  "DSA PRIVATE KEY",
];

const PRIVATE_KEY_MARKER_PATTERN = new RegExp(
  `-----(BEGIN|END) (${PRIVATE_KEY_LABELS.join("|")})-----`,
  "g",
);

function redactPrivateKeyBlocks(value: string): string {
  let cursor = 0;
  let beginIndex = 0;
  let depth = 0;
  let parts: string[] | undefined;

  // Scan forward through fixed markers. Repeated searches for absent labels
  // rescanned every remaining suffix for nested and separate blocks.
  const markers = new RegExp(PRIVATE_KEY_MARKER_PATTERN);
  while (true) {
    const marker = markers.exec(value);
    if (!marker) break;
    if (marker[1] === "BEGIN") {
      if (depth === 0) beginIndex = marker.index;
      depth += 1;
      continue;
    }
    if (depth === 0) {
      // An ignored orphan END can share its trailing delimiter with a BEGIN.
      // Preserve the old BEGIN-only outer search without skipping that prefix.
      markers.lastIndex = marker.index + 1;
      continue;
    }
    depth -= 1;
    if (depth > 0) continue;

    parts ??= [];
    parts.push(value.slice(cursor, beginIndex), "[REDACTED]");
    cursor = marker.index + marker[0].length;
  }
  if (depth > 0) {
    // Preserve the existing whole-tail refusal for a truncated or unclosed
    // private-key block, including nested or mismatched recognized labels.
    parts ??= [];
    parts.push(value.slice(cursor, beginIndex), "[REDACTED]");
    cursor = value.length;
  }

  if (!parts) return value;
  parts.push(value.slice(cursor));
  return parts.join("");
}

// Mask only recognized credential values. Preserve surrounding text and
// duplicate JSON members; normalizing complete documents would destroy evidence.
function redactSecretJsonContainers(value: string): string {
  // Native JSON.stringify escapes a field quote with 0, 1, or 3 backslashes
  // across zero, one, or two string layers. Higher encodings are not inferred.
  const assignment =
    /(?<![\w-])((?:[a-z0-9]+[_-])*(?:password|passwd|api[_-]?key|secret|token|access[_-]?key|auth(?:orization)?|bearer|private[_-]?key)\s*(?:((?:\\{3}|\\)?["'])\s*)?[:=]\s*)((?:\\{3}|\\)?"|\[|\{)/gi;
  let quotedContext = false;
  let encodedContext = false;
  let significant: string | undefined;
  let previousSignificant: string | undefined;
  let contextEscape = false;
  let contextCursor = 0;
  const advanceContext = (end: number): void => {
    for (; contextCursor < end; contextCursor += 1) {
      const char = value[contextCursor];
      if (contextEscape) contextEscape = false;
      else if (quotedContext && char === "\\") contextEscape = true;
      else if (char === '"') {
        if (!quotedContext) {
          // JSON value framing distinguishes encoded strings from ordinary
          // quoted error prose. This does not parse or normalize documents.
          encodedContext =
            significant === undefined ||
            significant === "[" ||
            significant === "," ||
            (significant === ":" && previousSignificant === '"');
        }
        quotedContext = !quotedContext;
      }
      if (char && !/\s/.test(char)) {
        previousSignificant = significant;
        significant = char;
      }
    }
  };
  const readEncodedUnit = (index: number): { char: string | undefined; next: number } => {
    if (value[index] !== "\\") return { char: value[index], next: index + 1 };
    const next = Math.min(value.length, index + (value[index + 1] === "u" ? 6 : 2));
    return { char: JSON.parse('"' + value.slice(index, next) + '"') as string, next };
  };
  const quotedTailEnd = (start: number, doubleEncoded: boolean): number => {
    if (doubleEncoded) {
      let index = start;
      while (index < value.length) {
        try {
          const unit = readEncodedUnit(index);
          if (unit.char === '"') return index;
          index = unit.char === "\\" ? readEncodedUnit(unit.next).next : unit.next;
        } catch {
          start = index;
          break;
        }
      }
    }
    for (let index = start; index < value.length; index += 1) {
      if (value[index] === "\\") index += 1;
      else if (value[index] === '"') return index;
    }
    return value.length;
  };
  const parts: string[] = [];
  let cursor = 0;
  while (true) {
    const match = assignment.exec(value);
    if (!match) break;
    const opener = match[3] ?? "";
    const scalar = opener.endsWith('"');
    const fieldQuote = match[2] ?? "";
    // Encoded scalars require a recognized JSON field and matching native
    // quote escapes. Raw scalars retain the env rule, including short values
    // such as the ordinary workflow permission "id-token":"write".
    if (
      scalar &&
      (!fieldQuote.startsWith("\\") ||
        !fieldQuote.endsWith('"') ||
        !(match[1] ?? "").trimEnd().endsWith(":") ||
        opener !== fieldQuote ||
        value.slice(match.index - fieldQuote.length, match.index) !== fieldQuote)
    ) {
      continue;
    }
    const start = assignment.lastIndex - opener.length;
    advanceContext(start);
    const withinString = quotedContext;
    const encodedField = withinString && fieldQuote.startsWith("\\");
    const doubleEncoded = encodedField && fieldQuote.length === 4;
    const encodedString = withinString && (encodedContext || encodedField);
    const closing: string[] = [];
    let quote: string | undefined;
    let containerEscape = false;
    let end = value.length;
    let index = scalar ? assignment.lastIndex : start;
    while (index < value.length) {
      let char = value[index];
      let next = index + 1;
      if (encodedString && char === '"') {
        end = index;
        break;
      }
      if (encodedString && char === "\\") {
        // Decode at most two fixed-size native JSON escapes, never a
        // document or recursively serialized provider response.
        try {
          const unit = readEncodedUnit(index);
          char = unit.char;
          next = unit.next;
          if (doubleEncoded && char === '"') {
            end = index;
            break;
          }
          if (doubleEncoded && char === "\\") {
            const escaped = readEncodedUnit(next);
            let jsonEscape = "\\" + escaped.char;
            next = escaped.next;
            if (escaped.char === "u") {
              for (let digit = 0; digit < 4; digit += 1) {
                const hex = readEncodedUnit(next);
                jsonEscape += hex.char;
                next = hex.next;
              }
            }
            char = JSON.parse('"' + jsonEscape + '"') as string;
          }
        } catch {
          end = quotedTailEnd(index, doubleEncoded);
          break;
        }
      }
      if (scalar) {
        if (containerEscape) containerEscape = false;
        else if (char === "\\") containerEscape = true;
        else if (char === '"') {
          end = next;
          break;
        }
      } else if (quote) {
        if (containerEscape) containerEscape = false;
        else if (char === "\\") containerEscape = true;
        else if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === "[" || char === "{") {
        closing.push(char === "[" ? "]" : "}");
      } else if (char === "]" || char === "}") {
        if (closing.pop() !== char) {
          end = encodedString ? quotedTailEnd(next, doubleEncoded) : value.length;
          break;
        }
        if (closing.length === 0) {
          end = next;
          break;
        }
      }
      index = next;
    }
    // GitHub's exact OIDC permission vocabulary is not an issued JWT.
    // Preserve only its two native scalar literals, with the original bytes.
    if (
      scalar &&
      (match[1] ?? "").startsWith("id-token" + fieldQuote) &&
      end - start <= fieldQuote.length * 2 + 5 &&
      [fieldQuote + "write" + fieldQuote, fieldQuote + "none" + fieldQuote].includes(
        value.slice(start, end),
      )
    ) {
      advanceContext(end);
      assignment.lastIndex = end;
      continue;
    }
    // An unterminated matched value loses its remaining tail, rather than
    // allowing a credential suffix to survive. Keep an enclosing string quote.
    let marker = encodedField
      ? '\\"[REDACTED]\\"'
      : withinString && !scalar
        ? "[REDACTED]"
        : '"[REDACTED]"';
    if (doubleEncoded) marker = JSON.stringify(marker).slice(1, -1);
    parts.push(value.slice(cursor, start), marker);
    cursor = end;
    advanceContext(end);
    assignment.lastIndex = end;
  }
  if (parts.length === 0) return value;
  parts.push(value.slice(cursor));
  return parts.join("");
}

export function redact(value: string): string {
  let output = redactSecretJsonContainers(redactPrivateKeyBlocks(value));
  for (const re of SECRET_PATTERNS) {
    // The env-style assignment pattern uses two capture groups so that
    // the key name is preserved; the standalone-token patterns do not
    // capture and we replace the whole match. We dispatch on the regex
    // shape (`re.source.includes("(")`) but the safer signal is the
    // number of groups we declared: only the env-style assignment pattern
    // declares two groups ((key)(value)). Standalone token patterns,
    // including JWT-shaped tokens, replace the whole match because there
    // is no key half to preserve.
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
        SECRET_FIELD_PATTERN.test(key) &&
        !(key === "id-token" && (child === "write" || child === "none"))
          ? "[REDACTED]"
          : redactJsonValue(child),
      ]),
    ) as T;
  }
  return value;
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return redact(error.message);
  return redact(String(error));
}
