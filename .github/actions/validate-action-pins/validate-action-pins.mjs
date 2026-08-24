#!/usr/bin/env node
// Fail-closed validator for GitHub Actions `uses:` references (v04.06.01).
//
// Codex review of PR #243 (P1): a plain-text grep misses YAML-normalized
// spellings such as `"uses":` or `uses :`, silently skipping the pinning
// property while the publish gate accepts Scorecard PinnedDependenciesID
// results. This validator extracts every `uses` mapping value with the
// quoting/spacing forms YAML actually permits for workflow files, and it
// FAILS CLOSED on any `uses`-keyed line it cannot parse. Accepted refs:
//   - local composite actions:      ./path/to/action
//   - immutable same-repo actions:  $/path/to/action  (same commit as the run)
//   - third-party actions pinned to a full 40-hex commit: owner/repo[/path]@<sha>
// Everything else (tags, branches, shortened SHAs) is rejected.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// `uses` as a mapping key, optionally quoted, optionally a sequence item,
// with optional spaces before the colon. Captures the raw value.
const USES_LINE = /^\s*(?:-\s+)?(?:"uses"|'uses'|uses)\s*:\s*(.*)$/;
// Any line that mentions a uses-like key but did not match USES_LINE above.
const SUSPICIOUS = /^\s*(?:-\s+)?["']?uses["']?\s*:/;

export function extractUses(line) {
  const match = USES_LINE.exec(line);
  if (!match) return SUSPICIOUS.test(line) ? { error: "unrecognized uses form" } : null;
  let value = match[1].trim();
  const comment = value.search(/\s#/);
  if (comment !== -1) value = value.slice(0, comment).trim();
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    value = value.slice(1, -1);
  }
  if (value === "" || value === ">" || value === ">-" || value === "|" || value === "|-") {
    // Block scalars and empty values hide the ref from line-based review.
    return { error: "unsupported uses value form" };
  }
  return { value };
}

export function validateRef(value) {
  if (value.startsWith("./") || value.startsWith("$/")) return null;
  const pinned = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}$/;
  if (pinned.test(value)) return null;
  return `not pinned to a 40-hex commit: ${value}`;
}

export function validateFile(path, content) {
  const problems = [];
  content.split(/\r?\n/).forEach((line, index) => {
    const extracted = extractUses(line);
    if (!extracted) return;
    if (extracted.error) {
      problems.push(`${path}:${index + 1}: ${extracted.error}: ${line.trim()}`);
      return;
    }
    const problem = validateRef(extracted.value);
    if (problem) problems.push(`${path}:${index + 1}: ${problem}`);
  });
  return problems;
}

export function collectTargets(root) {
  const targets = [];
  const workflows = join(root, ".github", "workflows");
  for (const name of readdirSync(workflows)) {
    if (name.endsWith(".yml") || name.endsWith(".yaml")) targets.push(join(workflows, name));
  }
  const actionsDir = join(root, ".github", "actions");
  let entries;
  try {
    entries = readdirSync(actionsDir);
  } catch {
    return targets;
  }
  for (const entry of entries) {
    const dir = join(actionsDir, entry);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of ["action.yml", "action.yaml"]) {
      try {
        statSync(join(dir, name));
        targets.push(join(dir, name));
      } catch {
        /* absent variant */
      }
    }
  }
  return targets;
}

if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())
) {
  const root = process.argv[2] ?? ".";
  const problems = collectTargets(root).flatMap((path) =>
    validateFile(path, readFileSync(path, "utf8")),
  );
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error(`validate-action-pins: ${problems.length} problem(s) found`);
    process.exit(1);
  }
  console.log(
    "validate-action-pins: every uses reference is local, immutable ($/) or 40-hex pinned.",
  );
}
