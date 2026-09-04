# AGENTS.md - cross-review

Pointer for AI agents working in this repository.

## Project

- Repository: `https://github.com/LCV-Ideas-Software/cross-review`
- Package: `@lcv-ideas-software/cross-review`
- Site: `https://cross-review.lcv.dev`
- Branch: `main`
- License: Apache-2.0

## Runtime Shape

This repository is the source of the cross-review MCP server: API-first
multi-model cross-review with unanimous convergence gates. Binaries published
by the package: `cross-review` and `cross-review-dashboard`.

## Mandatory Gates

```bash
npm test
npm run check
npm run lint
npm run biome
npm run typecheck
npm run format:check
npm pack --dry-run
```

Regression suites are versioned (`npm run` lists the full set); a change that
touches a guarded contract must run the matching regression before closure.

## Release

Publishing runs on GitHub's documented model with no manual gesture: a push to
`main` that changes the `package.json` version publishes the package to
npmjs.com through npm Trusted Publishing (OIDC) with provenance, mirrors it to
GitHub Packages, and then records the Release with the run's own token. The
repository owns no tagging or dispatch automation and holds no publishing
secret.

The merge is the deliberate act. A pull request that bumps the version
publishes when it lands, so a version that must not be published must not be
merged. The manifest version has to be a plain three-part numeric version,
never a prerelease: the workflow refuses anything else before deriving the
`vXX.XX.XX` tag. A push that changes `package.json` without changing the
version, such as a Dependabot merge, ends as a no-op that says so.

The release checks inside `publish.yml` are business logic with no
repository-owned regression, by the operator's decision: native scanners
(zizmor, CodeQL) own workflow security, and the script changes only through a
reviewed pull request. The regression rule above does not apply to them.

## Workspace Policy

Follow the workspace-root `AGENTS.md` directives of the private workspace that
hosts this checkout (not versioned in this public repository). In
particular: use `ultrabrain`, never allow self-review when a cross-review gate
is applicable, keep `main` as the deployment branch, and use Commit & Sync only
after the requested final audit.

Cross-review is a proportional gate, not a universal ceremony. Require it for
changes with material implementation, architecture, security, privacy,
financial, data-integrity, release-safety, or cross-system risk, and whenever
the operator explicitly requests it. Dispense it for simple mechanical work
such as documentation-only corrections, typo or formatting fixes, immutable
action/dependency pin updates, lockfile regeneration, and equivalent action
substitution when the relevant static validators and CI gates cover the
change. When in doubt, justify the risk classification from the actual diff;
do not invoke cross-review merely because this repository implements the
cross-review product. Do not use historical versioned names for the gate.

## Registro de trabalho (GitHub Projects, Issues e Discussions)

A equipe e composta por tres membros: o **operador** (humano), **Claude Code** e **ChatGPT-Codex**.
Quase todo trabalho acontece em par (operador+Claude ou operador+Codex). O que fica so no
transcript da sessao se perde para o outro membro. Por isso o registro abaixo e **obrigatorio**.

Quadro deste repositorio: `https://github.com/orgs/LCV-Ideas-Software/projects/6`
Quadro consolidado da organizacao: `https://github.com/orgs/LCV-Ideas-Software/projects/17`

### Os quatro gatilhos

**G1 — fim de bloco de trabalho.** Publique um _status update_ no quadro deste repositorio,
dizendo o que foi feito, o que ficou pendente e o que o proximo agente precisa saber:

```bash
gh api graphql -f query='
  mutation($id:ID!, $body:String!) {
    createProjectV2StatusUpdate(input:{projectId:$id, status:ON_TRACK, body:$body}) {
      statusUpdate { id }
    }
  }' -f id="$PROJECT_ID" -f body="..."
```

Use `AT_RISK` ou `OFF_TRACK` quando for o caso. O `PROJECT_ID` sai de
`gh api graphql -f query='query{organization(login:"LCV-Ideas-Software"){projectV2(number:6){id}}}'`.

**G2 — achado nao corrigido.** Todo bug, falha, limitacao de plataforma ou comportamento
inesperado que voce encontrar e **nao** resolver na hora vira issue imediatamente, com
reproducao, ambiente, evidencia, o que ja foi tentado e a hipotese de causa. Use o
formulario adequado em `.github/ISSUE_TEMPLATE/`. **Excecao de seguranca**: nenhum caso coberto
pelo reporte privado de `SECURITY.md` — nem a suspeita de um deles — vira issue
publica; siga o canal privado de la.

**G3 — decisao ou aprendizado duravel.** Criterio objetivo: _"isto seria util para quem
enfrentar este problema daqui a tres meses?"_ Se sim, vira Discussion.

- Conhecimento especifico deste repo -> Discussions **deste repositorio** (Q&A ou Ideas).
- Conhecimento transversal a varios repos (politica de release, regra de ruleset, restricao
  de plataforma) -> Discussions **da organizacao**.

**Excecao de seguranca** (tambem no G3): causa raiz, caminho de exploracao ou licao de
remediacao ligada a **qualquer caso coberto pelo reporte privado de `SECURITY.md`** nao
vira Discussion publica antes da divulgacao coordenada. Registre no canal privado de
`SECURITY.md`/advisory correspondente; apos a divulgacao, publique a versao saneada como
Discussion, sem detalhes de exploracao.
**G4 — trabalho nao-trivial.** Abra a issue **antes** do PR e referencie com `Closes #N`.
Isso ativa o fechamento automatico, o campo _Linked pull requests_ e a progressao de Status.
**Excecao de seguranca** (tambem no G4): trabalho que remedia **qualquer caso coberto
pelo reporte privado de `SECURITY.md`** — a lista de la, nao uma mais estreita: suspeita
de vulnerabilidade, vazamento de credencial, exposicao de dado privado, bypass de
autenticacao, problema em fluxo de pagamento, questao de cadeia de suprimentos ou
configuracao incorreta de deploy — nao abre issue publica nem carrega `Closes #N` de
superficie publica. O rastreio segue o canal privado do `SECURITY.md` e o advisory
correspondente; o PR referencia o advisory, sem detalhes de exploracao. Se `SECURITY.md`
mudar de escopo, vale o texto de la.

### Valvula de escape

Bump de dependencia, correcao de typo, lockfile e ajuste de formatacao **dispensam issue**.
O PR basta — ele entra no quadro sozinho quando o gatilho o alcanca; PR do Dependabot
e uma lacuna declarada do gatilho e pode depender do backfill/reconciliacao da ativacao.

### Campos

Classifique toda issue com **Type** (Task, Bug, Feature, Incident, Security, Maintenance,
Documentation, Spike) e preencha os campos de issue da organizacao **Agent** (quem esta
tocando) e **Origin** (de onde surgiu). Em Bug e Incident preencha tambem **Environment**.
Esses campos sao `ORG_ONLY`: nao aparecem para o publico, mesmo neste repositorio publico.

### Fluxo de Status no quadro

`Triagem` -> `Backlog` -> `Em andamento` -> `Em cross-review` -> `Em PR` -> `Concluido`,
com desvios `Bloqueado` e `Descartado`.

> **Invariante**: as opcoes `Triagem` e `Concluido` estao vinculadas **por ID** a workflows
> internos do GitHub que nao sao editaveis por API. Podem ser renomeadas; **nunca apagadas**.

> **Atualizacao por quadro**: `Status`, `Area` e `Ciclo` sao campos de projeto com IDs
> proprios em cada quadro. Atualize os DOIS quadros — o deste repositorio e o portfolio
> #17 — a cada transicao; ID de opcao de um quadro nunca vale no outro (Discussion org#176).

### Nada de identificador real em repositorio publico

Issues, PRs e Discussions deste repositorio sao publicos e permanentes. Use placeholders
(`proj-x`, `exemplo-projeto-000`, `exemplo.com`) no lugar de IDs de projeto de nuvem, nomes
de banco, dominios e contas. Detalhe operacional sensivel vai para o quadro privado ou para
`.github-private`. Neste repositorio a regra tem peso dobrado: fixtures de teste ja vazaram
identificadores reais no passado e a diretriz vigente exige placeholders desde o primeiro
commit.
