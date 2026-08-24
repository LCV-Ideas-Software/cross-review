#!/usr/bin/env node
// Fail-closed validator for GitHub Actions `uses:` references (v04.06.01).
//
// Codex reviews of PR #243: line-based scanning misses YAML-normalized
// spellings and flow-style mappings; a .github/actions-only walk misses
// local actions living elsewhere in the tree. This validator parses every
// workflow with the real YAML parser, collects every `uses` value from the
// parsed structure, RESOLVES each accepted local reference (./path or
// $/path) to its manifest and validates it recursively, and FAILS CLOSED
// on unparseable documents, non-string `uses` values or local references
// whose manifest cannot be found. Accepted references:
//   - local composite actions:      ./path/to/action  (manifest revalidated)
//   - immutable same-repo actions:  $/path/to/action  (manifest revalidated)
//   - third-party actions pinned to a full 40-hex commit: owner/repo[/path]@<sha>
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";

export function collectUsesFromYaml(path, content) {
  let doc;
  try {
    doc = parse(content);
  } catch (error) {
    return { problems: [`${path}: unparseable YAML: ${error.message ?? error}`], uses: [] };
  }
  const problems = [];
  const uses = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "uses") {
        if (typeof value === "string" && value.trim().length > 0) {
          uses.push(value.trim());
        } else {
          problems.push(`${path}: non-string or empty uses value: ${JSON.stringify(value)}`);
        }
      }
      walk(value);
    }
  };
  walk(doc);
  return { problems, uses };
}

export function validateRef(value) {
  if (value.startsWith("./") || value.startsWith("$/")) return null;
  const pinned = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}$/;
  if (pinned.test(value)) return null;
  return `not pinned to a 40-hex commit: ${value}`;
}

function manifestPathFor(root, localRef) {
  const relPath = localRef.replace(/^(\.\/|\$\/)/, "");
  for (const name of ["action.yml", "action.yaml"]) {
    const candidate = join(root, relPath, name);
    try {
      statSync(candidate);
      return candidate;
    } catch {
      /* try the other manifest name */
    }
  }
  return null;
}

// Validates the whole tree: every workflow, plus the manifest of EVERY
// accepted local reference (wherever it lives - Codex review: a local
// action outside .github/actions must not smuggle an unpinned uses), plus
// any manifests those manifests reference, breadth-first.
export function validateTree(root) {
  const problems = [];
  const queue = [];
  const seen = new Set();
  const enqueue = (absPath) => {
    if (!seen.has(absPath)) {
      seen.add(absPath);
      queue.push(absPath);
    }
  };
  const workflows = join(root, ".github", "workflows");
  for (const name of readdirSync(workflows)) {
    if (name.endsWith(".yml") || name.endsWith(".yaml")) enqueue(join(workflows, name));
  }
  while (queue.length > 0) {
    const absPath = queue.shift();
    const relPath = relative(root, absPath).replace(/\\/g, "/");
    let content;
    try {
      content = readFileSync(absPath, "utf8");
    } catch (error) {
      problems.push(`${relPath}: unreadable: ${error.message ?? error}`);
      continue;
    }
    const collected = collectUsesFromYaml(relPath, content);
    problems.push(...collected.problems);
    for (const value of collected.uses) {
      const problem = validateRef(value);
      if (problem) {
        problems.push(`${relPath}: ${problem}`);
        continue;
      }
      if (value.startsWith("./") || value.startsWith("$/")) {
        const manifest = manifestPathFor(root, value);
        if (manifest === null) {
          problems.push(`${relPath}: local action manifest not found for ${value}`);
        } else {
          enqueue(manifest);
        }
      }
    }
  }
  return problems;
}

export function validateFile(path, content) {
  const { problems, uses } = collectUsesFromYaml(path, content);
  for (const value of uses) {
    const problem = validateRef(value);
    if (problem) problems.push(`${path}: ${problem}`);
  }
  return problems;
}

if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())
) {
  const problems = validateTree(process.argv[2] ?? ".");
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error(`validate-action-pins: ${problems.length} problem(s) found`);
    process.exit(1);
  }
  console.log(
    "validate-action-pins: every uses reference is local, immutable ($/) or 40-hex pinned.",
  );
}
