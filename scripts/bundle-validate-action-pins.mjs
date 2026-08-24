// Bundles the pin validator with its pinned `yaml` parser so the composite
// action is self-contained on a clean runner (the release gate invokes it
// BEFORE any dependency installation - Codex review of PR #243). Runs as
// part of `npm run build`, keeping dist/ in lockstep with the source.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await build({
  absWorkingDir: root,
  entryPoints: [".github/actions/validate-action-pins/validate-action-pins.mjs"],
  outfile: ".github/actions/validate-action-pins/dist/index.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  // Inline license comments: the bundled `yaml` parser (MIT, documented in
  // THIRD-PARTY-NOTICES) travels with its attribution inside the artifact.
  legalComments: "inline",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});

console.log("validate-action-pins bundle: dist/index.mjs is self-contained.");
