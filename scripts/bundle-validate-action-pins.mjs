// Bundles the pin validator with its pinned `yaml` parser so the composite
// action is self-contained on a clean runner (the release gate invokes it
// BEFORE any dependency installation - Codex review of PR #243). Runs as
// part of `npm run build`, keeping dist/ in lockstep with the source.
//
// Codex review of PR #244: the bundled artifact carries a substantial
// portion of `yaml` (ISC), so its full copyright + permission + disclaimer
// text is read from the package and prepended to the bundle - the dist is
// committed and distributed, and inline legal comments alone preserve
// nothing for this package.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const yamlLicense = await readFile(path.join(root, "node_modules", "yaml", "LICENSE"), "utf8");
const licenseBanner = [
  "/*!",
  " * yaml (ISC):",
  ...yamlLicense
    .trim()
    .split("\n")
    .map((line) => ` * ${line}`.trimEnd()),
  " */",
].join("\n");

await build({
  absWorkingDir: root,
  entryPoints: [".github/actions/validate-action-pins/validate-action-pins.mjs"],
  outfile: ".github/actions/validate-action-pins/dist/index.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  legalComments: "inline",
  banner: {
    js:
      licenseBanner +
      "\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});

console.log("validate-action-pins bundle: dist/index.mjs is self-contained (ISC notice embedded).");
