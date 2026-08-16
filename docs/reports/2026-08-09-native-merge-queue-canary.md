# Native merge-queue canary

> **Registro histórico supersedido em 16/08/2026.** O controlador central citado
> abaixo foi aposentado. A admissão atual é uma ação humana explícita na merge
> queue nativa; os checks continuam executados no `merge_group`, sem parser ou
> controlador customizado de auto-merge.

Date: 9 August 2026
Scope: GitHub Actions governance only; no application or runtime behavior changes.

This documentation-only change is the inert workload used to verify the native
`cross-review` merge queue after the repository migration. The canary is successful only when
the central controller enables squash auto-merge for this exact pull-request head and GitHub
creates a synthetic `merge_group` commit where every declared GitHub Actions context succeeds:

- `Dependency Review`;
- `Analyze actions`;
- `Analyze javascript-typescript`;
- `Analyze python`;
- `Build, lint and smoke`;
- `Run zizmor / Run zizmor`.

The repository rulesets remain fail-closed: the canary must not bypass the queue, use an
administrator override, or merge through a direct API request.
