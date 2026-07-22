import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PACKAGE_NAME = "@lcv-ideas-software/cross-review";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmExecPath = process.env.npm_execpath;
assert.ok(npmExecPath, "npm_execpath is required to run the published consumer gate");
const registry = "https://registry.npmjs.org";
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cross-review-consumer-"));
const packDirectory = path.join(tempRoot, "pack");
const consumerDirectory = path.join(tempRoot, "consumer");
const blockedInheritedNpmConfig = new Set([
  "npm_config_allow_git",
  "npm_config_allow_remote",
  "npm_config_allow_scripts",
]);

function command(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...options,
  });
}

function npmCommand(args, options = {}) {
  return command(process.execPath, [npmExecPath, ...args], {
    ...options,
    env: cleanEnv(options.env),
  });
}

function cleanEnv(extra = {}) {
  return Object.fromEntries(
    Object.entries({ ...process.env, ...extra }).filter(
      ([key, value]) => value !== undefined && !blockedInheritedNpmConfig.has(key.toLowerCase()),
    ),
  );
}

function forbiddenInstalledPackages(lock) {
  const forbidden = ["@hono/node-server", "@modelcontextprotocol/sdk", "hono"];
  return Object.keys(lock.packages ?? {}).filter((packagePath) => {
    const normalized = packagePath.replaceAll("\\", "/");
    return forbidden.some(
      (name) =>
        normalized === `node_modules/${name}` || normalized.endsWith(`/node_modules/${name}`),
    );
  });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForOutput(child, expected, timeoutMs = 15_000) {
  let output = "";
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`timed out waiting for ${expected}; output=${output}`));
    }, timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(expected)) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (!output.includes(expected)) {
        clearTimeout(timeout);
        reject(new Error(`process exited ${code} before ${expected}; output=${output}`));
      }
    });
  });
}

try {
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(consumerDirectory, { recursive: true }),
  ]);
  npmCommand(["pack", "--pack-destination", packDirectory, "--ignore-scripts=false"], {
    cwd: root,
    env: cleanEnv({ npm_config_registry: registry }),
  });
  const tarballs = (await readdir(packDirectory)).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1);
  const tarball = path.join(packDirectory, tarballs[0]);

  await writeFile(
    path.join(consumerDirectory, "package.json"),
    `${JSON.stringify({ name: "consumer-fixture", version: "1.0.0", private: true }, null, 2)}\n`,
    "utf8",
  );
  npmCommand(
    [
      "install",
      "--save-exact",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--allow-git=none",
      "--allow-remote=none",
      "--registry",
      registry,
      tarball,
    ],
    { cwd: consumerDirectory },
  );

  const installedRoot = path.join(
    consumerDirectory,
    "node_modules",
    "@lcv-ideas-software",
    "cross-review",
  );
  const installedPackage = JSON.parse(
    await readFile(path.join(installedRoot, "package.json"), "utf8"),
  );
  assert.equal(installedPackage.dependencies?.["@modelcontextprotocol/sdk"], undefined);
  assert.equal(installedPackage.main, "dist/src/mcp/server.js");
  assert.equal(installedPackage.bin?.["cross-review"], "dist/src/mcp/server.js");

  const consumerLock = JSON.parse(
    await readFile(path.join(consumerDirectory, "package-lock.json"), "utf8"),
  );
  assert.deepEqual(forbiddenInstalledPackages(consumerLock), []);

  const audit = JSON.parse(
    npmCommand(["audit", "--omit=dev", "--json", "--registry", registry], {
      cwd: consumerDirectory,
    }),
  );
  assert.equal(audit.metadata?.vulnerabilities?.total, 0);

  const licenses = await readFile(
    path.join(installedRoot, "dist", "THIRD_PARTY_LICENSES.txt"),
    "utf8",
  );
  assert.match(licenses, /@modelcontextprotocol\/sdk@1\.29\.0/);
  assert.match(licenses, /Permission is hereby granted/);

  const stateDirectory = path.join(tempRoot, "state");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(installedRoot, "dist", "src", "mcp", "server.js")],
    cwd: consumerDirectory,
    env: cleanEnv({
      CROSS_REVIEW_DATA_DIR: stateDirectory,
      CROSS_REVIEW_STUB: "1",
      CROSS_REVIEW_STUB_CONFIRMED: "1",
    }),
  });
  const client = new Client(
    { name: "fresh-consumer-regression", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "session_init"));
  } finally {
    await client.close();
  }

  command(process.execPath, ["--input-type=module", "--eval", `await import("${PACKAGE_NAME}")`], {
    cwd: consumerDirectory,
  });

  const dashboardPort = await reservePort();
  const dashboard = spawn(
    process.execPath,
    [path.join(installedRoot, "dist", "src", "dashboard", "server.js")],
    {
      cwd: consumerDirectory,
      env: cleanEnv({
        CROSS_REVIEW_DASHBOARD_PORT: String(dashboardPort),
        CROSS_REVIEW_DATA_DIR: stateDirectory,
        CROSS_REVIEW_STUB: "1",
        CROSS_REVIEW_STUB_CONFIRMED: "1",
      }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  try {
    await waitForOutput(dashboard, `http://127.0.0.1:${dashboardPort}`);
    const response = await globalThis.fetch(`http://127.0.0.1:${dashboardPort}/api/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  } finally {
    dashboard.kill();
    if (dashboard.exitCode === null) {
      await new Promise((resolve) => dashboard.once("exit", resolve));
    }
  }

  console.log("published consumer security regression: PASS");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
