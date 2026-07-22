import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const SDK_PACKAGE = "@modelcontextprotocol/sdk";
const ENTRY_POINT = "src/mcp/server.ts";
const OUTPUT_FILE = "dist/src/mcp/server.js";
const LICENSE_OUTPUT = "dist/THIRD_PARTY_LICENSES.txt";
const HTTP_ONLY_PACKAGES = new Set([
  "@hono/node-server",
  "body-parser",
  "content-type",
  "cors",
  "cross-spawn",
  "eventsource",
  "eventsource-parser",
  "express",
  "express-rate-limit",
  "hono",
  "jose",
  "json-schema-typed",
  "pkce-challenge",
  "raw-body",
  "serve-static",
]);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const productionDependencies = Object.keys(packageJson.dependencies ?? {}).sort();

if (Object.hasOwn(packageJson.dependencies ?? {}, SDK_PACKAGE)) {
  throw new Error(`${SDK_PACKAGE} must not be a published runtime dependency`);
}
if (!Object.hasOwn(packageJson.devDependencies ?? {}, SDK_PACKAGE)) {
  throw new Error(`${SDK_PACKAGE} must remain a development dependency for typechecking and tests`);
}

const result = await build({
  absWorkingDir: root,
  entryPoints: [ENTRY_POINT],
  outfile: OUTPUT_FILE,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  legalComments: "linked",
  external: productionDependencies,
  metafile: true,
});

function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0];
}

const entryOutput = Object.values(result.metafile.outputs).find((output) => output.entryPoint);
if (!entryOutput) throw new Error("esbuild did not report the MCP entry output");
for (const imported of entryOutput.imports.filter((item) => item.external)) {
  if (imported.path.startsWith("node:")) continue;
  const packageName = packageNameFromSpecifier(imported.path);
  if (!productionDependencies.includes(packageName)) {
    throw new Error(`bundle left undeclared runtime import external: ${imported.path}`);
  }
}

const packageDirectories = new Map();
for (const inputPath of Object.keys(result.metafile.inputs)) {
  const normalized = inputPath.replaceAll("\\", "/");
  const marker = "node_modules/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) continue;
  const remainder = normalized.slice(markerIndex + marker.length);
  const parts = remainder.split("/");
  const packageName = parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const relativeDirectory = normalized.slice(0, markerIndex + marker.length) + packageName;
  packageDirectories.set(path.resolve(root, relativeDirectory), packageName);
}

const bundledPackages = [];
for (const [directory, expectedName] of packageDirectories) {
  const bundledPackageJson = JSON.parse(
    await readFile(path.join(directory, "package.json"), "utf8"),
  );
  if (bundledPackageJson.name !== expectedName) {
    throw new Error(`bundled package identity mismatch at ${directory}`);
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const licenseFiles = entries
    .filter((entry) => entry.isFile() && /^licen[cs]e(?:$|[._-])/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (licenseFiles.length === 0) {
    throw new Error(`bundled package ${expectedName} has no license file`);
  }
  bundledPackages.push({
    name: expectedName,
    version: bundledPackageJson.version,
    declaredLicense: bundledPackageJson.license ?? "unspecified",
    directory,
    licenseFiles,
  });
}

if (!bundledPackages.some((item) => item.name === SDK_PACKAGE)) {
  throw new Error(`${SDK_PACKAGE} was not incorporated into the stdio bundle`);
}
const forbidden = bundledPackages
  .map((item) => item.name)
  .filter((name) => HTTP_ONLY_PACKAGES.has(name));
if (forbidden.length > 0) {
  throw new Error(`HTTP-only packages leaked into the stdio bundle: ${forbidden.join(", ")}`);
}

const licenseSections = [
  "Bundled third-party licenses",
  "",
  "This generated file covers packages incorporated into the MCP stdio bundle.",
  "",
];
for (const bundled of bundledPackages.sort((a, b) =>
  `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
)) {
  licenseSections.push(
    "=".repeat(80),
    `${bundled.name}@${bundled.version}`,
    `Declared license: ${bundled.declaredLicense}`,
    "",
  );
  for (const licenseFile of bundled.licenseFiles) {
    licenseSections.push(
      `--- ${licenseFile} ---`,
      (await readFile(path.join(bundled.directory, licenseFile), "utf8")).trim(),
      "",
    );
  }
}
await mkdir(path.dirname(path.join(root, LICENSE_OUTPUT)), { recursive: true });
await writeFile(path.join(root, LICENSE_OUTPUT), `${licenseSections.join("\n").trim()}\n`, "utf8");

process.stdout.write(
  `stdio bundle: ${bundledPackages.length} licensed packages, zero HTTP-only packages\n`,
);
