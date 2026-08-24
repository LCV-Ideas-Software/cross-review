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
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
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
  // Codex review of PR #244: manifests under .github/actions are validated
  // even when nothing references them yet - the Scorecard allowance covers
  // that prefix, so an orphaned unpinned manifest must not slip through.
  const seededReal = new Set();
  const seedActions = (dir) => {
    let realDir;
    try {
      realDir = realpathSync(dir);
    } catch (error) {
      problems.push(
        `${relative(root, dir).replace(/\\/g, "/")}: unreadable action subtree: ${error.message ?? error}`,
      );
      return;
    }
    if (seededReal.has(realDir)) return;
    seededReal.add(realDir);
    let entries;
    try {
      entries = readdirSync(dir);
    } catch (error) {
      problems.push(
        `${relative(root, dir).replace(/\\/g, "/")}: unreadable action subtree: ${error.message ?? error}`,
      );
      return;
    }
    for (const entry of entries) {
      const child = join(dir, entry);
      let childStat;
      try {
        // lstat: never descend through symlinks (a cyclic link below the
        // checked-out tag must not stall the release gate).
        childStat = lstatSync(child);
      } catch (error) {
        problems.push(
          `${relative(root, child).replace(/\\/g, "/")}: unreadable action entry: ${error.message ?? error}`,
        );
        continue;
      }
      if (childStat.isDirectory()) {
        seedActions(child);
      } else if (childStat.isFile() && (entry === "action.yml" || entry === "action.yaml")) {
        enqueue(child);
      }
    }
  };
  {
    const actionsDir = join(root, ".github", "actions");
    let hasActionsDir;
    try {
      hasActionsDir = statSync(actionsDir).isDirectory();
    } catch {
      hasActionsDir = false; // absent is fine; unreadable inner trees fail above
    }
    if (hasActionsDir) seedActions(actionsDir);
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
        // Codex review of PR #244: classify the local target by its
        // FILESYSTEM type, never by suffix - a directory named
        // release-action.yml is an action directory, and a reusable
        // workflow is a plain file.
        const relTarget = value.replace(/^(\.\/|\$\/)/, "");
        const target = join(root, relTarget);
        let targetStat;
        try {
          targetStat = statSync(target);
        } catch {
          problems.push(`${relPath}: local reference target not found for ${value}`);
        }
        if (targetStat?.isFile()) {
          if (/\.(yml|yaml)$/i.test(relTarget)) {
            enqueue(target);
          } else {
            // A plain file that is not a workflow (e.g. ./build/script.js)
            // is neither an action directory nor a reusable workflow.
            problems.push(`${relPath}: local file reference is not a reusable workflow: ${value}`);
          }
        } else if (targetStat?.isDirectory()) {
          const manifest = manifestPathFor(root, value);
          if (manifest === null) {
            problems.push(`${relPath}: local action manifest not found for ${value}`);
          } else {
            enqueue(manifest);
          }
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
