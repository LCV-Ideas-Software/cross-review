# Third-Party Components

Direct dependencies declared by this repository:

| Component                 | License           | Scope       | Source                                                  |
| ------------------------- | ----------------- | ----------- | ------------------------------------------------------- |
| @anthropic-ai/sdk         | MIT               | runtime     | https://www.npmjs.com/package/@anthropic-ai/sdk         |
| @google/genai             | Apache-2.0        | runtime     | https://www.npmjs.com/package/@google/genai             |
| @modelcontextprotocol/sdk | MIT               | bundled/dev | https://www.npmjs.com/package/@modelcontextprotocol/sdk |
| openai                    | Apache-2.0        | runtime     | https://www.npmjs.com/package/openai                    |
| pino                      | MIT               | runtime     | https://www.npmjs.com/package/pino                      |
| proper-lockfile           | MIT               | runtime     | https://www.npmjs.com/package/proper-lockfile           |
| protobufjs                | BSD-3-Clause      | runtime     | https://www.npmjs.com/package/protobufjs                |
| zod                       | MIT               | runtime     | https://www.npmjs.com/package/zod                       |
| @biomejs/biome            | MIT OR Apache-2.0 | development | https://www.npmjs.com/package/@biomejs/biome            |
| @eslint/js                | MIT               | development | https://www.npmjs.com/package/@eslint/js                |
| @types/node               | MIT               | development | https://www.npmjs.com/package/@types/node               |
| @types/proper-lockfile    | MIT               | development | https://www.npmjs.com/package/@types/proper-lockfile    |
| eslint                    | MIT               | development | https://www.npmjs.com/package/eslint                    |
| eslint-config-prettier    | MIT               | development | https://www.npmjs.com/package/eslint-config-prettier    |
| esbuild                   | MIT               | development | https://www.npmjs.com/package/esbuild                   |
| prettier                  | MIT               | development | https://www.npmjs.com/package/prettier                  |
| tsx                       | MIT               | development | https://www.npmjs.com/package/tsx                       |
| typescript                | Apache-2.0        | development | https://www.npmjs.com/package/typescript                |
| typescript-eslint         | MIT               | development | https://www.npmjs.com/package/typescript-eslint         |
| yaml                      | ISC               | development | https://www.npmjs.com/package/yaml                      |

`package.json` is the source of truth for declared ranges.
`package-lock.json` records the exact resolution for this repository checkout;
consumers resolve those ranges through their own lockfiles.

The package build writes the complete license texts for the exact components
incorporated into the stdio bundle to `dist/THIRD_PARTY_LICENSES.txt`.

GitHub Actions used by the workflows in `.github/workflows/` (each pinned to a
full-length commit SHA in the workflow files, where Dependabot updates them):

| Action                           | License    | Source                                              |
| -------------------------------- | ---------- | --------------------------------------------------- |
| actions/checkout                 | MIT        | https://github.com/actions/checkout                 |
| actions/configure-pages          | MIT        | https://github.com/actions/configure-pages          |
| actions/dependency-review-action | MIT        | https://github.com/actions/dependency-review-action |
| actions/deploy-pages             | MIT        | https://github.com/actions/deploy-pages             |
| actions/download-artifact        | MIT        | https://github.com/actions/download-artifact        |
| actions/setup-node               | MIT        | https://github.com/actions/setup-node               |
| actions/setup-python             | MIT        | https://github.com/actions/setup-python             |
| actions/upload-artifact          | MIT        | https://github.com/actions/upload-artifact          |
| actions/upload-pages-artifact    | MIT        | https://github.com/actions/upload-pages-artifact    |
| github/codeql-action             | MIT        | https://github.com/github/codeql-action             |
| linear/linear-release-action     | MIT        | https://github.com/linear/linear-release-action     |
| ossf/scorecard-action            | Apache-2.0 | https://github.com/ossf/scorecard-action            |
| zizmorcore/zizmor-action         | MIT        | https://github.com/zizmorcore/zizmor-action         |
