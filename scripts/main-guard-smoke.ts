import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isMainModule } from "../src/mcp/server.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cross-review-main-guard-"));
const repoLink = path.join(tempRoot, "repo-junction");

try {
  fs.symlinkSync(process.cwd(), repoLink, process.platform === "win32" ? "junction" : "dir");

  const physicalEntry = path.join(process.cwd(), "src", "mcp", "server.ts");
  const linkedEntry = path.join(repoLink, "src", "mcp", "server.ts");

  assert.equal(
    isMainModule(pathToFileURL(physicalEntry).href, linkedEntry),
    true,
    "main guard must recognize the same entry point through an npm-style junction/symlink",
  );
  assert.equal(
    isMainModule(pathToFileURL(physicalEntry).href, undefined),
    false,
    "main guard must remain false for imported modules without argv[1]",
  );
  assert.equal(
    isMainModule(pathToFileURL(physicalEntry).href, path.join(process.cwd(), "package.json")),
    false,
    "main guard must not boot when another file is the process entry point",
  );

  console.log("[main-guard-smoke] junction_entrypoint_test: PASS");
} finally {
  const resolvedTempRoot = path.resolve(tempRoot);
  const resolvedSystemTemp = path.resolve(os.tmpdir());
  if (
    resolvedTempRoot !== resolvedSystemTemp &&
    resolvedTempRoot.startsWith(`${resolvedSystemTemp}${path.sep}`)
  ) {
    fs.rmSync(resolvedTempRoot, { recursive: true, force: true });
  }
}
