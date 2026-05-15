import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const packageName = globalThis.process.env.PACKAGE_NAME || pkg.name;
const packageVersion = globalThis.process.env.PACKAGE_VERSION || pkg.version;
const spec = `${packageName}@${packageVersion}`;
const npmBin = globalThis.process.platform === "win32" ? "npm.cmd" : "npm";

const raw = execFileSync(
  npmBin,
  ["view", spec, "dist", "--json", "--registry=https://registry.npmjs.org"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
const dist = JSON.parse(raw);

for (const key of ["shasum", "integrity", "tarball"]) {
  if (!dist[key] || typeof dist[key] !== "string") {
    throw new Error(`npm registry dist metadata for ${spec} is missing dist.${key}`);
  }
}

globalThis.console.log(
  JSON.stringify(
    {
      spec,
      shasum: dist.shasum,
      integrity: dist.integrity,
      tarball: dist.tarball,
    },
    null,
    2,
  ),
);
