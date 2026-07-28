import fs from "node:fs";
import path from "node:path";

function fail(message) {
  throw new Error(`Published package runtime contract verification failed: ${message}`);
}

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} is required`);
  return path.resolve(value);
}

function readJson(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    fail(`could not read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(`${label} must contain a JSON object`);
    }
    return value;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Published package runtime")) {
      throw error;
    }
    fail(`could not parse ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

const expected = readJson(requiredArgument("--expected"), "expected runtime contract");
const installed = readJson(requiredArgument("--installed"), "installed published package manifest");

if (installed.name !== expected.name || installed.version !== expected.version) {
  fail("installed package identity does not match the protected release identity");
}

for (const field of [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "bundleDependencies",
  "bundledDependencies",
  "engines",
  "bin",
]) {
  if (!sameJson(installed[field], expected[field])) {
    fail(`installed package ${field} does not match the protected source package`);
  }
}
