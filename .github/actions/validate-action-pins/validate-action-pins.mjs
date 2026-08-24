#!/usr/bin/env node
// Fail-closed validator for GitHub Actions `uses:` references (v04.06.01).
//
// Codex reviews of PR #243: line-based scanning misses YAML-normalized
// spellings (`"uses":`, `uses :`) and flow-style mappings
// (`- { uses: owner/action@main }`), and a first-level directory walk
// misses nested composite actions. This validator therefore parses every
// workflow and local action manifest with the real YAML parser (the
// project's pinned `yaml` dependency), collects every `uses` value from
// the parsed structure, and FAILS CLOSED on unparseable documents or
// non-string `uses` values. Accepted references:
//   - local composite actions:      ./path/to/action
//   - immutable same-repo actions:  $/path/to/action  (same commit as the run)
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

export function validateFile(path, content) {
  const { problems, uses } = collectUsesFromYaml(path, content);
  for (const value of uses) {
    const problem = validateRef(value);
    if (problem) problems.push(`${path}: ${problem}`);
  }
  return problems;
}

export function collectTargets(root) {
  const targets = [];
  const workflows = join(root, ".github", "workflows");
  for (const name of readdirSync(workflows)) {
    if (name.endsWith(".yml") || name.endsWith(".yaml")) targets.push(join(workflows, name));
  }
  // Local action manifests can nest arbitrarily deep under .github/actions
  // (Codex review: a first-level walk silently skips grouped actions whose
  // unpinned third-party uses would then ride in through the accepted $/
  // reference). Walk the whole tree.
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(dir, entry);
      let stat;
      try {
        stat = statSync(child);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(child);
      } else if (entry === "action.yml" || entry === "action.yaml") {
        targets.push(child);
      }
    }
  };
  walk(join(root, ".github", "actions"));
  return targets;
}

export function validateTree(root) {
  return collectTargets(root).flatMap((path) =>
    validateFile(relative(root, path).replace(/\\/g, "/"), readFileSync(path, "utf8")),
  );
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
