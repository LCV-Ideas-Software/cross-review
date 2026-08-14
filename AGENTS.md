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
npm run format:public:check
npm pack --dry-run
```

Regression suites are versioned (`npm run` lists the full set); a change that
touches a guarded contract must run the matching regression before closure.

## Workspace Policy

Follow the workspace-root `AGENTS.md` directives of the private workspace that
hosts this checkout (not versioned in this public repository). In
particular: no self-review in cross-review gates, `ultrabrain` plus
`cross-review-v2` before substantive closure, `cross-review-v1` only as fallback
for v2, `main` as the deployment branch, and Commit & Sync only after final
audit when requested.

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
formulario adequado em `.github/ISSUE_TEMPLATE/`.

**G3 — decisao ou aprendizado duravel.** Criterio objetivo: _"isto seria util para quem
enfrentar este problema daqui a tres meses?"_ Se sim, vira Discussion.

- Conhecimento especifico deste repo -> Discussions **deste repositorio** (Q&A ou Ideas).
- Conhecimento transversal a varios repos (politica de release, regra de ruleset, restricao
  de plataforma) -> Discussions **da organizacao**.

**G4 — trabalho nao-trivial.** Abra a issue **antes** do PR e referencie com `Closes #N`.
Isso ativa o fechamento automatico, o campo _Linked pull requests_ e a progressao de Status.

### Valvula de escape

Bump de dependencia, correcao de typo, lockfile e ajuste de formatacao **dispensam issue**.
O PR basta — ele entra no quadro sozinho.

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
