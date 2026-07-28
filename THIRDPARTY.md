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

`package.json` is the source of truth for declared ranges.
`package-lock.json` records the exact resolution for this repository checkout;
consumers resolve those ranges through their own lockfiles.

The package build writes the complete license texts for the exact components
incorporated into the stdio bundle to `dist/THIRD_PARTY_LICENSES.txt`.
