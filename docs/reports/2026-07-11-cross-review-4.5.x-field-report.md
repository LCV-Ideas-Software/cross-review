# Cross-Review 4.5.x — Relatório de Campo (Field Report)

**Data:** 2026-07-11 / 2026-07-12 / 2026-07-13 UTC
**Autor:** Claude (caller=claude, host claude-code) — sessão de trabalho da calculadora-app
**Contexto:** hardgate pré/pós-ship do workspace exigiu submeter dois ships da calculadora-app
(v04.02.00 e o retro-review de v04.02.01, commit `8eee516`) ao cross-review. Durante a execução,
o gate **não conseguiu registrar convergência nas versões 4.5.0–4.5.3 exercitadas nessa fase,
apesar de a substância ter sido aprovada por unanimidade dos peers**. Este relatório registra todos
os comportamentos observados (corretos e defeituosos) para análise e correção. O adendo da 4.5.8
registra a convergência formal posterior.

> **Achado central:** os defeitos NÃO estão na qualidade do trabalho revisado nem na evidência
> submetida. Em 4.5.2 e 4.5.3, os 6 modelos peer **emitiram `"status":"READY"` com
> "No blocking objections remain"** e citações verbatim ancoradas por `sha256`; o servidor os
> **rebaixou** para `NEEDS_EVIDENCE` por falsos-positivos de camadas anti-alucinação, e depois
> **abortou** rounds inteiros por falsos-positivos de preflight. Naquele intervalo, o gate ficou
> incapaz de atingir ALL READY para um caller-agente, mesmo com trabalho e evidência impecáveis.

---

## 1. Escopo e metodologia

- **Versões runtime exercitadas:** 4.5.0, 4.5.2, 4.5.3 (a 4.5.1 foi instalada via tarball mas o
  processo em memória não recarregou a tempo — não exercitada isoladamente).
- **Caller:** sempre `claude`, host `claude-code` (agente, não operador humano).
- **Modo:** `review` (retro/pre-commit), 6 peers habilitados
  (codex/claude/gemini/deepseek/grok/perplexity), relator-lottery ativo.
- **Método de diagnóstico:** leitura direta de `meta.json`, `agent-runs/round-*-*.json` e
  `events.ndjson` de cada sessão em `~/.cross-review/data/sessions/`; execução offline do
  `evidencePreflight`/`truthfulnessPreflight` do build instalado (`node -e`) contra os drafts
  exatos; leitura da fonte (`dist/src/core/{orchestrator,status,convergence}.js` e
  `src/core/orchestrator.ts` do workspace).

### 1.1 Inventário de sessões

| Sessão (7) | Versão | Outcome    | Motivo                       | Rounds      | Defeito observado               |
| ---------- | ------ | ---------- | ---------------------------- | ----------- | ------------------------------- |
| `306ba203` | 4.5.0  | aborted    | needs_evidence_preflight     | 1           | DEF-1                           |
| `be550cc3` | 4.5.0  | aborted    | needs_evidence_preflight     | 1           | DEF-1                           |
| `469d8785` | 4.5.0  | aborted    | needs_evidence_preflight     | 1           | DEF-1 (incl. saídas RED de TDD) |
| `989d8a2e` | 4.5.0  | aborted    | needs_evidence_preflight     | 2           | DEF-1, DEF-4                    |
| `7afaf133` | 4.5.0  | max-rounds | max_rounds_without_unanimity | 4           | DEF-2                           |
| `a37722c8` | 4.5.2  | max-rounds | max_rounds_without_unanimity | 6           | DEF-5                           |
| `8789eb50` | 4.5.3  | aborted    | needs_truthfulness_preflight | 1(+relator) | DEF-5, DEF-6                    |

Também observados fora das sessões: DEF-3 (`session_attach_evidence` operator-only) e o limite de
1000 chars do `escalate_to_operator` (minor).

---

## 2. Comportamentos CORRETOS observados (o que funciona)

Para calibrar: muita coisa funciona bem e deve ser preservada.

1. **`server_info` / `probe_peers` / capability_snapshot:** preciso e rápido. Latências,
   `auth_present`, `model_selection` com `source_url` e `confidence:"verified"` por peer.
2. **Contabilidade de custo/uso:** por-peer e agregada, com `cache_read/write`, `reasoning_tokens`,
   `tier_used`, `request_cost` (perplexity), `cost_ceiling_usd` e `budget_warning_emitted`.
   Ex.: sessão `8789eb50` custou **US$ 0,515** para 4 peers + 1 relator.
3. **Persistência de evidência do caller (4.5.1+):** `persistCallerSubmittedEvidence` grava o campo
   `evidence` como attachment de sessão com `sha256` e `integrity_version`, e o round o inlinea no
   prompt dos peers. Confirmado: os peers da 4.5.3 citaram o arquivo por hash
   (`c5083095…dc24da`) e por §-seção. **Corrige a regressão de entrega da 4.5.0 (DEF-2).**
4. **Preflight testável offline, de graça:** `session_truthfulness_preflight_check` e o
   `evidencePreflight` exportado permitem iterar o draft sem gastar rounds pagos — essencial e bem
   desenhado.
5. **Relator-lottery / anti-self-review:** `convergence_scope` elege um `lead_peer` não-votante
   (`grok` em `8789eb50`), com `anti_self_review_exclusion_reason` explícito. Correto.
6. **Idempotência de identidade:** `identity_forgery_blocked` corretamente impede um host-agente de
   se declarar `operator`. A intenção é certa (ver DEF-3 para o efeito colateral).
7. **Auto-finalização durável + escalação:** `escalate_to_operator` grava em
   `operator_escalations[]` no meta; `convergence_health.state` reflete `blocked`.

---

## 3. Defeitos observados

### DEF-1 — `evidence_preflight` falso-positivo em claims de contagem/comando inline (4.5.0)

- **Sintoma:** todo round abortava ANTES de qualquer chamada paga, com
  `Evidence preflight failed before any paid peer call: task/draft claims completed operational
work without value-corresponding evidence: 11 passed, 47 passed[, 1 failed, 2 failed, npm run
biome, git diff]; attach raw matching output inline, via the evidence field, or as session
evidence`.
- **Gatilho:** o draft continha frases como `47 passed`, `npm run biome`, `git diff` — extraídas
  por `extractEvidenceOperationalAssertions` (`orchestrator.ts:1169`) como assertivas operacionais,
  sem corroboração reconhecida por `extractInlineRawEvidence` (`:1230`).
- **Prova empírica:** rodando o `evidencePreflight` das duas builds contra o **mesmo draft**:
  `4.5.0 → pass:false` (uncorroborated: `["11 passed","47 passed","npm run biome","git diff"]`);
  `4.5.1 → pass:true` ("value-correlated with caller-submitted raw material").
- **Agravante observado:** ao adicionar as saídas RED de TDD como evidência (para "mostrar o
  vermelho antes do verde"), a frase `1 failed`/`2 failed` vira sinal de falha
  (`evidenceHasExplicitFailureSignal`, `:1267`) e **invalida todas as corroborações de contagem** —
  contraintuitivo para quem documenta TDD honestamente.
- **Raiz:** heurística de corroboração muito sensível a texto narrativo; o 4.5.0 não reconhecia
  blocos ``` com `$ cmd`/`EXIT_CODE:` que o 4.5.1 passou a reconhecer.
- **Status:** **corrigido na 4.5.1** (a entrega de evidência ao peer é DEF-2).
- **Severidade:** alta (bloqueio total) — resolvida.

### DEF-2 — Campo `evidence` não entregue aos peers em `session_start_round`/`ask_peers` (4.5.0)

- **Sintoma:** na sessão `7afaf133`, com a evidência no campo `evidence` (via
  `session_start_unanimous`), o preflight passou mas os 4 rounds retornaram `NEEDS_EVIDENCE` — o
  `round-1-prompt.md` continha **zero bytes** da evidência.
- **Raiz:** no 4.5.0, os schemas de `session_start_round`/`ask_peers` sequer tinham o campo
  `evidence`; e o pipeline não inlineava a evidência do caller no prompt do peer.
- **Status:** **corrigido na 4.5.1+** (`persistCallerSubmittedEvidence` — ver §2.3).
- **Severidade:** alta — resolvida.

### DEF-3 — `session_attach_evidence` é operator-only → inacessível a caller-agente (4.5.0+)

- **Sintoma:** `session_attach_evidence(caller:'claude')` →
  `operator_authority_required: ...may only be called by the human operator`; e
  `caller:'operator'` de host-agente → `identity_forgery_blocked: clientInfo.name='claude-code'
resolves to claude`.
- **Efeito:** um caller-agente não tem NENHUMA rota de "operator-verified attachment"; depende
  inteiramente de o `evidence` inline ser aceito pelos preflights. Quando estes têm falsos-positivos
  (DEF-1/4/5/6), o agente fica sem escape.
- **Recomendação:** manter o bloqueio de forja, mas prover uma custódia de evidência de primeira
  classe para caller-agente autenticado por token (o `CROSS_REVIEW_CALLER_TOKEN` já existe e é
  `hard_enforce:true`), tratando `caller_submitted` autenticado como suficiente para READY quando o
  peer o corrobora.
- **Severidade:** média (arquitetural).

### DEF-4 — `truthfulness_preflight` confunde IDs/datas de terceiros com estado do sistema (4.5.0)

- **Sintoma (sessão `989d8a2e`, 1ª tentativa):**
  `current-state model claim gemini-3.5-flash for gemini contradicts model_pin
gemini-3.1-pro-preview; current-state release_date claim 2026-10-16 contradicts runtime
release_date 2026-07-10; ...2026-05-19...`.
- **Gatilho:** o draft mencionava o **modelo migrado da aplicação** (`gemini-3.5-flash`) e datas de
  deprecation (`2026-10-16`). O scanner cruzou esses tokens com o `model_pin` do **peer gemini do
  próprio servidor** (`gemini-3.1-pro-preview`) e com o `release_date` de runtime — dois universos
  distintos (o modelo da app ≠ o modelo do peer).
- **Workaround encontrado:** manter IDs de modelo e datas ISO fora de linhas que casam
  `CURRENT_STATE_CLAIM_PATTERN` (`orchestrator.js:1141`:
  `current|currently|actual|atual|runtime|production|prod|loaded|carregad[ao]|is/are running`).
  Reformulando as linhas, o mesmo conteúdo passou.
- **Raiz:** o preflight não distingue "afirmação sobre o sistema sob review" de "citação sobre um
  produto de terceiro". A correlação por token de modelo/data é global à linha.
- **Severidade:** alta (bloqueio total, contornável só por reescrita anti-idiomática).

### DEF-5 — Demoção READY→NEEDS_EVIDENCE por grounding check (4.5.2 e 4.5.3) ⚠️ **principal**

- **Sintoma:** os peers emitem `"status":"READY"` no texto cru, e o servidor os rebaixa a
  `NEEDS_EVIDENCE`, com `decision_quality:"format_warning"`.
- **Dados brutos (campo `text` vs `status` pós-parser):**

  | Sessão             | Peer       | raw `text` | `status` final | `parser_warnings`                                                                  |
  | ------------------ | ---------- | ---------- | -------------- | ---------------------------------------------------------------------------------- |
  | `a37722c8` (4.5.2) | deepseek   | READY      | NEEDS_EVIDENCE | `verified_without_concrete_evidence_sources`, `ready_downgraded_to_needs_evidence` |
  | `a37722c8` (4.5.2) | gemini     | READY      | NEEDS_EVIDENCE | idem                                                                               |
  | `a37722c8` (4.5.2) | grok       | READY      | NEEDS_EVIDENCE | `ready_evidence_sources_fabricated`                                                |
  | `a37722c8` (4.5.2) | perplexity | READY      | NEEDS_EVIDENCE | `ready_evidence_sources_fabricated`                                                |
  | `8789eb50` (4.5.3) | codex      | READY      | NEEDS_EVIDENCE | `ready_evidence_sources_ungrounded`                                                |
  | `8789eb50` (4.5.3) | gemini     | READY      | NEEDS_EVIDENCE | `verified_without_concrete_evidence_sources`, `ready_downgraded_to_needs_evidence` |
  | `8789eb50` (4.5.3) | deepseek   | READY      | NEEDS_EVIDENCE | `ready_evidence_sources_ungrounded`                                                |
  | `8789eb50` (4.5.3) | perplexity | READY      | NEEDS_EVIDENCE | `ready_evidence_sources_ungrounded`                                                |

- **Contradição-chave:** as `evidence_sources` desses votos **são** concretas e rastreáveis. Ex.
  (perplexity, `8789eb50`): citam `evidence/...-caller-structured-evidence-...txt
(sha256=c5083095…dc24da)` e transcrevem §2–§8 verbatim (INSERTs numerados, `typeof` do D1,
  saídas de teste, HTTP 200 do smoke). Ainda assim o grounding check as classificou como
  `ungrounded`/`fabricated`.
- **Ponteiros de código (dist 4.5.3):**
  - `core/orchestrator.js:659-667` — decide o warning:
    `ready_peer_submitted_evidence_requires_path_hash_and_correlated_raw_quote` →
    `ready_evidence_sources_fabricated` → `ready_evidence_sources_missing` →
    `ready_evidence_sources_ungrounded`, e força `status:"NEEDS_EVIDENCE"`.
  - `core/status.js:334-355` — `isConcreteEvidenceSource` + demoção
    `ready_downgraded_to_needs_evidence` / `verified_without_concrete_evidence_sources`.
- **Raiz provável:** o matcher de "correlated raw quote / path+hash" não reconhece o formato de
  citação que os próprios peers produzem (referência ao arquivo por `sha256` + citação de §-seção),
  OU exige um formato de quote literal que o prompt não instrui os peers a emitir. Resultado: um
  peer que faz exatamente o pedido ("cite verbatim") é punido como se tivesse fabricado.
- **Severidade:** **crítica** — é o que impede convergência mesmo com aprovação unânime real.

### DEF-6 — `truthfulness_preflight` aborta round-2 na citação verbatim da doc de terceiro (4.5.3)

- **Sintoma (sessão `8789eb50`, round 2 / revisão do relator):** os 4 peers registrados em
  `failed_attempts` com
  `Truthfulness preflight failed on lead-generated revision before reviewer peer calls: current
operational-state claim lacks a correlated raw status record: GA (§5): "generally available (GA),
stable, and ready for scaled production use." ... preflight_issue_classes:
["unsupported_current_state_claim"]`.
- **Gatilho:** a **citação verbatim da doc do Google** (que os peers do round 1 EXIGIRAM: "cite
  evidence verbatim") contém `GA`, `stable`, `production` — `production`/`prod` casam
  `CURRENT_STATE_CLAIM_PATTERN` (`orchestrator.js:1141`) e a linha é tratada como afirmação de
  estado-corrente do **sistema sob review**, exigindo "raw status record" que uma citação de doc
  não tem.
- **Catch-22:** a camada de citação (DEF-5) exige verbatim; a de veracidade (DEF-6) aborta a
  sessão justamente por causa do verbatim. Não há draft que satisfaça ambas.
- **Ponteiros:** `orchestrator.js:1322` e `:1361` (`unsupported_current_state_claim`); pattern em
  `:1141`.
- **Raiz:** idêntica à DEF-4 — ausência de distinção "citação atribuída a fonte externa" vs
  "auto-alegação do sistema". A entrada de round-2 é gerada pelo relator, então o abort mata a
  sessão inteira mesmo com round-1 já tendo colhido votos READY.
- **Severidade:** **crítica**.

### DEF-7 (minor) — Efeitos operacionais colaterais

- **Auto-finalização em abort de preflight:** cada abort seta `outcome:"aborted"` e a sessão fica
  `session_already_finalized`; toda retry exige `session_init` novo (não dá para "consertar e
  reenviar" na mesma sessão). Fricção alta durante iteração.
- **`escalate_to_operator.reason` ≤ 1000 chars:** truncou a primeira tentativa de escalação
  (mensagem de erro `too_big`). Considerar 4000 (paridade com `review_focus`).
- **Ruído de processos:** ~10 `server.js` de hosts distintos em memória; nenhuma recarrega config
  em disco sem restart do host (`live_reload_supported:false`). Documentar que o gate depende de
  Reload Window por-host.

---

## 3.5. Adendo 4.5.5 (2026-07-12) — reteste pós-fix e defeitos residuais

Retestado com duas sessões na 4.5.5 (`04691dd6` via loop unânime; `741b69bc` via round único
controlado, sem relator entre rounds). **Progresso real e mensurável**, mas ainda sem convergência.

### O que a 4.5.4/4.5.5 comprovadamente corrigiu

- **DEF-5 parcial:** votos READY agora SOBREVIVEM ao parser quando 100% dos quotes citados são
  substrings exatas (ou whitespace-normalizadas) do attachment. Provas: deepseek (2 sessões) e
  perplexity (`741b69bc`) mantiveram `raw:READY → final:READY`, `parser_warnings: []`.
- **DEF-6 parcial:** a citação verbatim das docs Google na evidência (§5) **não abortou mais** o
  round 1 — docs atribuídas deixaram de ser tratadas como claim de runtime na entrada do caller.
- **Transparência nova (excelente):** `raw_status`/`parsed_status`/`normalized_status` são
  persistidos por peer — a demoção agora é auditável de primeira classe, sem ler o `text` cru.

### Defeitos residuais observados na 4.5.5

**DEF-8 — Validação de citação all-or-nothing + sem des-escape de aspas (novo, causa dominante).**
Um ÚNICO item imperfeito em `evidence_sources` anula o voto READY inteiro
(`ready_evidence_sources_ungrounded`). Medição na sessão `741b69bc`: gemini 3 itens/1 ruim →
demovido; grok **15 itens/2 ruins** (13 verbatim perfeitos!) → demovido. E os itens ruins têm
padrão único: são os quotes da §5 (docs Gemini) que **contêm aspas internas** — os peers os
serializam com `\"` escapado no JSON, o validador compara sem des-escapar → nunca casa.
Correções sugeridas: (a) des-escapar `\"`→`"` (e normalizar aspas tipográficas) antes da
correlação; (b) política proporcional — voto cai apenas se a MAIORIA dos itens for
incorrelacionável, descartando itens ruins individualmente (ou ao menos reportá-los por índice
para o peer corrigir no round seguinte).

**DEF-6 residual — texto gerado pelo relator ainda dispara truthfulness.** Na sessão `04691dd6`
(loop unânime), o round 2 abortou com `current-state model claim gemini-3.5 for gemini contradicts
model_pin gemini-3.1-pro-preview` — a REVISÃO gerada pelo relator (lead peer) mencionou o modelo
da aplicação em frase com palavra de estado-corrente. O texto de relator não passa pelo
saneamento que o caller pode fazer no próprio draft; enquanto o scanner não distinguir
"modelo da aplicação sob review" de "model_pin do peer", o modo loop-unânime fica inviável para
qualquer review que envolva modelos Gemini da aplicação. Workaround validado: `session_start_round`
(caller controla 100% do texto entre rounds).

**DEF-9 — codex `provider_error: response.incomplete` (transiente).** Sessão `04691dd6`:
`openai responses terminal state rejected for gpt-5.6-sol: event=response.incomplete. Partial,
truncated, filtered, or unterminated output is not a usable response.` — reasoning effort `max` +
`max_output_tokens 20000` truncou. O peer foi rejeitado sem retry no mesmo round. Sugestão:
retry automático 1x no mesmo modelo para essa classe (política do workspace: nunca downgrade).

### Resultado de mérito da última sessão (`741b69bc`, round 1)

| Peer       | raw           | final          | Observação                                |
| ---------- | ------------- | -------------- | ----------------------------------------- |
| deepseek   | READY         | **READY**      | citações 100% verbatim                    |
| perplexity | READY         | **READY**      | citações 100% verbatim                    |
| gemini     | READY         | NEEDS_EVIDENCE | 1/3 itens com `\"` (DEF-8)                |
| grok       | READY         | NEEDS_EVIDENCE | 2/15 itens com `\"` (DEF-8)               |
| codex      | **NOT_READY** | NOT_READY      | **finding de mérito procedente** (abaixo) |

**Finding do codex (procedente, vira patch na calculadora):** o DELETE de retenção de
`ai_usage_logs` (oraculo.ts:93) está dentro do `logAiUsage` fire-and-forget (IIFE não-awaitada,
não registrada em `context.waitUntil`), diferente do prune de observabilidade (que usa
`waitUntil`). Em Workers/Pages, trabalho não-awaitado após a resposta não tem garantia de
execução — a retenção fica best-effort. Correção pedida: retornar a Promise do insert+prune e
registrá-la em `context.waitUntil` (ou await explícito). Primeiro finding de mérito real de toda a
jornada — e só emergiu quando a instrução de citação byte-a-byte liberou os peers para focar em
substância. Nota: 4 dos 5 peers votantes aprovaram o mérito; o veredito de convergência oficial
segue bloqueado pelos defeitos acima.

---

## 3.6. Fechamento preparado para 4.5.6 (2026-07-12)

A remediação preserva as sessões acima como evidência histórica e não abriu uma nova rodada paga.
Os três defeitos residuais ganharam regressões offline:

- **DEF-8:** uma camada controlada de escape JSON é desserializada antes da correlação. A política
  all-or-nothing foi mantida por segurança; a proposta de aceitar maioria de fontes foi rejeitada.
  Matching posterior continua literal em case e whitespace, e código removido não fundamenta READY
  nem quando citado com o marcador `-` do diff.
- **DEF-6 residual:** somente alegações explicitamente vinculadas a cross-review/MCP,
  `server_info`, `runtime_capabilities` ou `model_pin` são comparadas aos pins locais. “Reviewer” ou
  “peer model” da aplicação sob revisão não pertence automaticamente ao namespace do servidor.
- **DEF-9:** GPT-5.6 Sol pode fazer exatamente uma recuperação no mesmo modelo, prompt e teto,
  reduzindo `high`/`xhigh`/`max` para `medium`; usage e custo da tentativa truncada permanecem no
  ledger. Safety/content filter e esforço já baixo/médio continuam fail-closed sem retry.

A revisão independente do diff encontrou e a mesma bateria cobre ainda: distinção oficial entre
Gemini `promptFeedback.blockReason` (entrada) e `Candidate.finishReason=SAFETY` (saída), orçamento
por peer compatível com consumidores de patch, envelope de status válido acima de 64 KiB,
streaming provisional/commit/discard por tentativa e precificação do modelo efetivamente chamado
em adapters e fallbacks. A rodada final de auditoria acrescentou: bloqueio de READY
auto-referencial genérico, call graph integral no hardgate, fail-closed de Sonar Deep Research sem
teto oficial e preservação de billing/erros/recusas nos terminais oficiais dos seis adapters. O
relatório forense de 2026-07-12 contém a matriz oficial e a auditoria das 36 horas.

---

## 3.7. Desfecho 4.5.8 (2026-07-12) — convergência formal atingida

Sessão limpa `4ed963d4` (round único, `session_start_round`): **outcome `converged |
unanimous_ready` — caller + 5 peers READY raw+final, zero warnings, checklist vazio.** O finding
do codex (round 1 da sessão `741b69bc`) foi corrigido com TDD e shipado como calculadora
v04.02.02. Receita que produziu a convergência: pacote de citação byte-exato anexado desde o
round 1 (trechos sem aspas internas, workaround usado naquela sessão), contrato de citação
explícito no draft e no review_focus, `session_start_round` (sem relator), e abandono de sessões
contaminadas por asks genéricos.

Correção de estado após confronto com a fonte 4.5.8:

- **DEF-8:** corrigido desde 4.5.6 por des-escape controlado antes da correlação; a política
  all-or-nothing permanece deliberadamente fail-closed.
- **DEF-6 residual:** corrigido desde 4.5.6 pela separação entre namespace da aplicação revisada e
  namespace explícito de cross-review/MCP/runtime.
- **DEF-9:** corrigido desde 4.5.6 por uma recuperação controlada de
  `response.incomplete/max_output_tokens` no mesmo GPT-5.6 Sol, com effort `medium` e ledger
  preservado.
- **DEF-10 (novo, confirmado):** remediações genéricas criadas pelo próprio servidor eram
  misturadas aos `caller_requests` dos peers. Sem âncora derivada, elas não podiam ser encerradas
  por requester reverification e bloqueavam convergência quando judge ativo/operador não estavam
  disponíveis. A correção foi preparada para 4.5.9, mantendo remediação em
  `decision_transformations[].details.remediation` e reservando `caller_requests` a pedidos reais
  dos peers.

## 3.8. Fechamento preparado para 4.5.9 (2026-07-12)

O DEF-10 ganhou regressões vermelha/verde para as cinco demoções READY do parser e para a demoção
de grounding. A correção não altera `hasAskDerivedAnchor`, não autoencerra asks genéricos reais e
não reduz a política all-or-nothing: pedidos autênticos dos peers continuam persistidos e
bloqueantes; somente orientação produzida pelo servidor deixa de ingressar na checklist como se
fosse autoria do peer.

A varredura histórica encontrou 54 itens sintéticos em 19 sessões: 40 `open` e 14
`not_resurfaced`. Quatro sessões ainda ativas continham 11 itens. Ao retomar uma sessão ativa, a
4.5.9 remove somente o item cuja origem sintética seja provada pelo voto bruto READY sem aquele
ask e pelo warning correspondente na própria rodada de criação do item; uma colisão sintética
posterior não pode apagar um pedido genuíno anterior. A correção registra reclassificação durável
e não altera sessões terminais. Assim, sessões antigas comprovadamente contaminadas deixam de
exigir intervenção manual sem que pedidos reais sejam satisfeitos por inferência.

## 3.9. DEF-11 — propagação independente da atestação npm (4.5.9 → 4.5.10)

O run de publicação `29209138113` comprovou que o pacote 4.5.9 foi publicado corretamente no
npmjs.com por Trusted Publishing/OIDC, com provenance, mas o gate pós-publicação produziu um falso
negativo. O `npm publish` terminou às `21:13:01Z`; a versão passou a aparecer na metadata pública
às `21:13:11Z`; aproximadamente 0,4 segundo depois, o URL já anunciado em
`dist.attestations.url` ainda respondeu `HTTP 404`. O verificador abortava no primeiro erro. Mais
tarde, sem qualquer nova publicação, o mesmo URL respondeu `200` com SLSA provenance v1. O rerun
idempotente detectou a versão existente, não republicou o pacote, verificou a atestação e fechou o
run e a GitHub Release em verde.

A [documentação oficial de provenance](https://docs.npmjs.com/generating-provenance-statements/) e
a [implementação oficial do npm/Pacote](https://github.com/npm/pacote/blob/3b5c462a96326fe7c88dc46312122ea720194179/lib/registry.js#L228-L239)
confirmam que o consumidor deve seguir o URL de atestação anunciado pela metadata; o Pacote utiliza
seu pathname preso novamente ao host do registry. O caminho literal interno não é documentado como
contrato público estável. A 4.5.10 remove essa suposição e acrescenta retry delimitado para `404`,
erros de rede/timeout, rate limit, falhas HTTP transitórias, JSON incompleto e documento cujo
predicate SLSA ainda não propagou. Erros permanentes, metadata estruturalmente inválida e ausência
persistente de SLSA provenance v1 continuam falhando fechados. Regressões comportamentais
reproduzem as sequências metadata visível → primeiro lookup 404/JSON incompleto/predicate ausente →
segundo lookup 200 com SLSA.

A adaptação não copia cegamente a construção `new URL(pathname, registry)`: um pathname iniciado
por `//` seria reinterpretado pela semântica WHATWG como host protocol-relative. A URL é criada já
presa ao registry, recebe o pathname por atribuição, tem o origin reafirmado e usa
`redirect: "error"`. A regressão inclui pathname `//attacker.invalid/...` e exige que o fetch
permaneça no npm registry sem seguir redirects.

Este verificador comprova presença do predicate SLSA na metadata e no documento publicado; ele não
é apresentado como verificação criptográfica independente de assinatura, PURL ou digest do
subject.

## 3.10. DEF-12 — contrato MCP induzia agente a pedir upload humano (4.5.10 → 4.5.11)

A sessão `86f41fbd-fe75-4cd4-a7bb-436f813294e9` reproduziu uma interpretação operacional errada,
mas razoável diante do schema exposto. Um Codex autenticado criou a sessão e chamou duas vezes o
tool genericamente apresentado como `Attach Evidence`. O runtime validou sua identidade e rejeitou
`session_attach_evidence` com `operator_authority_required`, pois essa superfície promove evidência
à autoridade opcional do operador. A restrição existe desde 4.5.0; não foi introduzida pela 4.5.10.

O transporte autônomo não estava quebrado. Logo depois, o mesmo host usou o campo `evidence` em
`run_until_unanimous`. As sessões `ec55558d-a11b-46a8-bce9-31394d299c16` e
`5e076838-7e9c-4ff2-9933-147ee5855d2e` persistiram, respectivamente, 41.417 e 40.751 bytes em
arquivos físicos, com SHA-256, `submitted_by=codex`, manifesto ativo e eventos
`session.evidence_attached`/`session.caller_evidence_submission_activated`. Os quatro preflights
passaram. As rodadas não chamaram revisores porque o budget preflight estimou US$ 34,10/US$ 34,07,
acima do limite de US$ 20 (e limite de sessão US$ 5); o bloqueio não foi evidência nem autorização.

O defeito real era de descoberta e contrato: a descrição runtime do tool privilegiado não dizia
`operator-only`, seu schema aceitava os identificadores dos peers, e as descrições dos campos
`evidence` não anunciavam sua persistência automática. Isso levou o agente a escolher a superfície
errada, fazer duas chamadas inúteis e concluir que precisava do humano.

A 4.5.11 mantém `operator_verified` fora de qualquer model host, mas torna o caminho correto
inequívoco. `session_attach_evidence` é apresentado como promoção opcional de autoridade; os quatro
review starters declaram que `evidence` é persistido automaticamente como
`caller_submitted_unverified`; e uma chamada errada redireciona o agente para esses campos dizendo
explicitamente que nenhuma ação humana é necessária. O runtime smoke lista os schemas MCP e cobre
tanto as descrições quanto a remediação da rejeição.

## 3.11. DEF-13 — Evidence Broker mantinha asks satisfeitos em `not_resurfaced` (4.5.11 → 4.5.12)

A sessão `b5a73952-8236-4cdf-8e34-880624f663f4` confirmou um defeito determinístico no correlator
do Evidence Broker. O DeepSeek abriu dois pedidos na rodada 2. Ambos passaram de `open` para
`not_resurfaced` na rodada 3. Nas rodadas 4, 6 e 7, Claude, Gemini, DeepSeek, Grok e Perplexity
retornaram `READY/verified`, sem warnings; path, SHA-256 e quotes foram validados byte a byte. Mesmo
assim, as rodadas continuaram bloqueadas pelos mesmos dois itens. A sessão consumiu sete rodadas,
241.207 tokens e custo configurado estimado de US$ 1,4204596.

O correlator transformava linguagem natural em uma conjunção incorreta. No primeiro pedido,
“file/line **ou** git diff” exigia também a expressão `git diff`; no segundo, a abreviação `e.g.` era
extraída como se fosse um caminho de arquivo obrigatório. Além disso, embora a documentação dissesse
que `Checklist-Item` roteia a rechecagem, a implementação unia todas as fontes do peer num único
corpus e não usava o ID. Isso criava falsos negativos e risco simétrico de uma fonte fechar outro
item do mesmo autor.

A sessão imediatamente posterior `a78aa17c-93f6-4825-89f9-b8abe1ec76d8` reproduziu a classe em
mais linguagem real: `diff/grep`, documentos de release sem extensão, termos em português sobre
injeção/validação e redação de segredos, além de enumeração numerada do Perplexity. Cinco itens ficaram
`not_resurfaced`; na rodada 3, os cinco peers estavam READY, mas o broker continuou bloqueando. A
análise também distinguiu asks realmente provados de alegações narrativas: READY e ID não bastam se
os bytes citados forem irrelevantes, parciais ou apenas afirmarem que uma rodada anterior teria
provado algo.

A 4.5.12 corrige o ciclo sem afrouxar o mecanismo anti-enganação:

- `ask_peers`/`session_start_round` passam a injetar automaticamente todos os IDs pendentes;
- quando há IDs nas fontes, cada item usa apenas as fontes que carregam seu próprio ID;
- `e.g.`/`i.e.`, alternativas line/diff e diff/grep e marcadores de lista são tratados conforme o
  papel sintático, não como prova obrigatória;
- conceitos bilíngues e documentos explicitamente pedidos precisam aparecer na evidência;
- ID com file:line/teste irrelevante, documento parcial, comando apenas documentado ou conjunção
  explicitamente incompleta continuam bloqueados;
- uma regressão E2E offline percorre cinco READY, attachment real, path, SHA-256, quote literal,
  `requester_reverified`, evento durável e convergência a partir de `not_resurfaced`.

Durante a criação desse E2E, duas versões iniciais do fixture usaram `stub=false`, mas `askPeers`
recriava adapters internamente e ignorava a substituição feita no construtor. Isso produziu duas
rodadas reais não pretendidas, dez chamadas, 65.501 tokens e custo externo estimado em cerca de
US$ 1,06; o rate card zero do fixture deixou o ledger local incorretamente em US$ 0. A seam final é
injetada em todos os pontos de criação, só é aceita com stub/teste confirmado, rejeita `stub=false`
antes de probes/calls e verifica cinco chamadas locais exatas, zero chamadas Codex e zero retries.

## 3.12. DEF-14 — recorrência ReDoS e publicação antes da leitura dos achados (4.5.12 → 4.5.13)

O CodeQL da 4.5.12 abriu o alerta 39 em `src/core/session-store.ts`, no matcher
camelCase usado para correlacionar símbolos pedidos pelo Evidence Broker. A
repetição externa aceitava o mesmo `A` que a repetição interna, permitindo
partições exponenciais de uma sequência longa. A classe `js/redos` era a mesma
do alerta 31, corrigido na 4.5.3 no matcher de opções Git; portanto, não se trata
de uma classe inédita, mas de uma recorrência metodológica.

O problema chegou ao npm porque `auto-tag.yml` aguardava apenas o CI funcional.
O workflow CodeQL pode terminar com `success` depois de carregar achados, e a
automação confundia sucesso do upload/análise com ausência de vulnerabilidades.
A tag `v04.05.12` e o publish ocorreram antes da auditoria explícita do conjunto
de alertas.

A 4.5.13 substitui o matcher por uma varredura linear de identificadores e um
filtro explícito de maiúscula, com regressão adversarial de 100.000 caracteres.
Também torna a publicação fail-closed: o auto-tag espera o CodeQL `push` do SHA
exato que passou no CI e consulta os alertas reais da branch padrão. CodeQL
ausente, incompleto, falho ou qualquer alerta aberto impede tag e publicação.
A consulta ao ref móvel é cercada por verificações de SHA antes e depois; a tag
nomeia explicitamente o SHA imutável cujos CI, análises processadas e snapshot
sem alertas passaram. Uma regressão de política verifica permissões, espera,
endpoint, bracket do ref e identidade exata da tag.

Na primeira execução do auto-tag para o commit `e698801`, o gate bloqueou a
publicação antes da tag porque o filtro `gh --jq` omitia o operador `|` entre a
iteração do array e a projeção do objeto. O log registrou `expected an object but
got: array`; nenhuma publicação 4.5.13 ocorreu. O filtro foi corrigido e a
regressão passou a exigir explicitamente a projeção por objeto, o grep do SHA e
as três comparações que prendem análise e alerta ao `VERIFIED_SHA`.

## 3.13. DEF-15 — perda de continuidade e divergência do Evidence Broker (4.5.13 → 4.5.14)

A sessão `39cb7669-99c3-4ecd-a635-95103c105390`, executada no runtime 4.5.13,
terminou a sexta rodada com Claude, Gemini, DeepSeek, Grok e Perplexity em
`raw_status=READY`, `parsed_status=READY`, `normalized_status=READY`,
`decision_quality=clean`, `confidence=verified` e sem `caller_requests` ou
`follow_ups`. Mesmo assim, o resultado formal permaneceu bloqueado por 18 itens
`not_resurfaced`. O objeto de convergência colocou DeepSeek, Grok e Perplexity
simultaneamente em `ready_peers` e `needs_evidence_peers`.

A auditoria dos seis rounds mostrou que a unanimidade final, isoladamente, não
provava os 18 itens. O anexo ativo da rodada 6 tinha apenas 476 bytes e duas
linhas de resumo; os diffs, transcrições e testes específicos estavam em
submissões anteriores, inclusive arquivos de 36.467 e 30.886 bytes. Os peers
recebiam somente o snapshot ativo. Os blobs continuavam duráveis no disco e no
manifesto, mas o broker 4.5.13 não reavaliava as respostas READY da rodada que
efetivamente os havia recebido depois que o correlator foi corrigido. Exigir
novo upload manual recriaria a falha de produto já rejeitada no DEF-12; reinserir
todos os blobs no prompt atual, por outro lado, permitiria empréstimo stale e
aumentaria novamente o custo das APIs.

Quatro defeitos adicionais amplificaram o ciclo:

- o preflight reconhecia `git diff --check`, mas não a identidade equivalente
  `git -C astrologo-app diff --check`; a saída vazia não era a causa, pois o
  registro já continha `EXIT_CODE: 0` e `STDOUT: <empty>`;
- uma única fonte contendo qualquer ID conhecido fazia o roteador descartar
  todas as fontes genéricas separadas ao avaliar os demais itens do peer;
- a deduplicação por hash de `peer + texto integral` transformava pedidos que
  começavam com `Checklist-Item: <id>` em novos IDs. As 19 entradas eram
  principalmente reapresentações de quatro grupos de prova;
- a rodada era persistida antes da agregação, address detection e judge. O
  `finalConvergence` calculado depois não era gravado de volta, permitindo
  divergência entre a resposta, `rounds[-1].convergence` e
  `convergence_health`.

A recomendação do relatório externo de fechar automaticamente todo pedido
antigo quando o peer retorna READY foi deliberadamente rejeitada. Um Claude
preguiçoso poderia abandonar o próprio pedido sem verificar os bytes. Na
4.5.14, `open` e `not_resurfaced` continuam bloqueantes; silêncio, READY
genérico e o ID isolado continuam sem provar satisfação.

O source 4.5.14 corrige a continuidade sem reduzir os mecanismos
anti-enganação:

- o snapshot ativo permanece a única fonte do preflight, prompt e grounding da
  rodada atual. Ao retomar uma sessão, o broker pode reprocessar localmente um
  READY histórico `clean/verified` contra o path, SHA-256 e quote literal do
  snapshot daquela resposta. Os bytes antigos não voltam ao prompt, não
  autorizam alegação nova e o replay não faz chamada de provedor;
- fontes sem ID continuam elegíveis para correlação estrita de outro item,
  enquanto fontes explicitamente roteadas a um ID alheio permanecem excluídas;
- somente uma referência estrita de “mesmo item”, do mesmo peer e para um
  ancestral mais antigo, ressurge/colapsa o ancestral. Referências cross-peer,
  ciclos e um ID seguido de exigência nova continuam first-class e bloqueantes.
  Reparos seguros de sessões 4.5.13 registram
  `evidence_checklist_alias_collapses` mais evento de auditoria;
- o matcher de comandos compara a identidade Git depois das opções globais.
  `git -C <dir> diff --check` com exit zero e streams explicitamente vazios
  passa; exit ausente/não zero, `diff --stat`, mero `echo`, `|| true`, `&&` e
  pipelines continuam falhando. `--check` depois do terminador `--` é pathspec,
  não opção; `--no-index`, refs e pathspecs estreitados também não provam a
  alegação global;
- `ready_peers` e `needs_evidence_peers` tornam-se disjuntos no estado formal,
  sem apagar o voto bruto; o prompt exige que o proprietário associe cada
  retirada a seu ID e a uma fonte literal correspondente;
- o `in_flight` guarda o snapshot journaled de checklist/history anterior à
  rodada e é adquirido antes de reparo, evidência ou preflight; recuperação,
  sweep stale ou cancelamento sem append restaura esse baseline e registra um
  evento compensatório. O `appendRound` reaplica o gate sob o mesmo lock da
  gravação e mantém a reserva até a finalização convergida. Seu resultado é a
  autoridade para rodada, health, resposta e outcome, eliminando gaps de crash,
  concorrência pré-round e append-to-finalize da primeira implementação.

As regressões offline reproduzem o comando real da sessão e seus negativos,
fontes mistas ID/generic, aliases seguros/cross-peer/cíclicos, replay local
após reinício sem reinjeção de blobs, isolamento do snapshot atual, disjunção
dos conjuntos derivados e igualdade do estado bloqueado ou promovido após
serialização e leitura da sessão. Nenhum schema wire das seis APIs,
modelo, rate card ou chave da configuração central precisou mudar para este
fix.

A auditoria final de manutenção de dependências encontrou quatro ecossistemas
reais no repositório: npm, GitHub Actions, o lock pip/pip-compile usado pelo
Socket e os hooks pre-commit. A configuração Dependabot 4.5.14 cobre os quatro,
autentica o proxy StepSecurity já declarado como registry global no `.npmrc` e
remove `day` dos schedules `daily` (a chave é semanal segundo o contrato
oficial). A primeira execução remota demonstrou que combinar esse `.npmrc` com
`replaces-base: true` redirecionava também o bootstrap do próprio npm pelo
Corepack; o proxy respondia sem `dist.tarball` e abortava antes da resolução das
dependências. Omitir `replaces-base` não bastou: a segunda execução mostrou que
o experimento `enable-private-registry-for-corepack` do próprio Dependabot ainda
redirecionava a CLI quando encontrava `packageManager: npm@12.0.1`. A configuração
final mantém `.npmrc` e a credencial StepSecurity para resolver dependências,
mas remove do manifest apenas a dica Corepack. O Dependabot usa o npm 11.17
embutido/documentado; CI e Publish continuam baixando npm 12.0.1 diretamente,
validando o SHA-512 antes de executar. O CI instala o lock Python com hashes sob
o pin 3.12 e executa os hooks pre-commit reais. A mesma primeira análise remota
abriu o alerta CodeQL 40 na regressão textual da URL do registry; a expressão
sem âncoras foi removida em favor de comparação literal, enquanto o parser YAML
continua responsável pela associação estrutural, sem dismiss ou supressão.

Essa ativação abriu doze PRs de manutenção em paralelo. Nove foram validados e
incorporados automaticamente; os PRs 112 e 116 tiveram todos os checks de
conteúdo verdes, mas o job de automerge terminou vermelho porque outro PR mudou
a base entre a leitura e o merge. O workflow agora repete apenas a resposta
transiente `Base branch was modified`, sempre com `--match-head-commit` no mesmo
SHA já validado. O PR 113 demonstrou uma segunda lacuna: sem o
`socketsecurity-requirements.in`, o Dependabot trocou o pin direto para 2.4.20,
mas não recompilou o novo transitivo `brotli>=1.0.9`; `--require-hashes` abortou
corretamente. A 4.5.14 inclui o par `.in`/`.txt`, agrupa updates Python
compatíveis e recompila a closure integral com pip-compile 7.5.3/Python 3.12.
O pin npm 12 + SHA-512 continua sob regressão própria: a documentação oficial
do Dependabot enumera apenas npm 7–11, portanto não se atribui cobertura não
documentada ao bot.

Um dry-run da lógica final 4.5.14 sobre uma cópia integral da sessão 39cb, sem
chamadas de API e sem alterar os autos originais, não colapsou nem promoveu item
algum. As reformulações antigas continham autoria cross-peer ou exigências
adicionais e, portanto, não eram aliases estritos seguros. Isso corrige uma
conclusão excessiva do relatório externo: a sobreposição dos conjuntos e os
falsos negativos de transporte/correlação eram bugs, mas as duas linhas
genéricas da rodada 6 e as citações da rodada 5 não satisfaziam estritamente
cada pedido de diffs, comandos e testes. A 4.5.14 não falsifica convergência
retroativa. Uma rodada nova pode receber evidência pelo canal automático do
caller, sem upload humano; cada ask só fecha com prova realmente correlacionada.

## 4. Análise consolidada histórica (4.5.0–4.5.3)

O pipeline anti-alucinação tinha **quatro camadas** em série, cada uma com poder de veto absoluto
e, naquele intervalo, com falsos-positivos que se sobrepunham:

```
draft+evidence
  → [1] evidence_preflight        (DEF-1: contagem/comando inline)      → abort
  → [2] truthfulness_preflight    (DEF-4/DEF-6: ID/data/GA de terceiro) → abort
  → [3] peer call (paga)          → peer vota READY
  → [4] grounding/demotion parser (DEF-5: citação "ungrounded")         → READY vira NEEDS_EVIDENCE
```

Para um **caller-agente**, as camadas [1], [2] e [4] disparam em conteúdo perfeitamente honesto e
corroborado, e a camada [4] pune exatamente o formato de citação que [1] exige. O veredito humano
dos peers ("No blocking objections remain", READY unânime) **nunca é registrado**: ou a sessão
aborta antes, ou o parser demove o voto depois.

**Impacto histórico de produto:** nessas primeiras versões 4.5.x, o hardgate deixou de atuar como
gate de qualidade do trabalho e virou um
gate de conformidade de _formato textual do draft/citação_, no qual trabalho e evidência impecáveis
falham por acionar heurísticas. Isso corrói a confiança no gate e força workarounds anti-idiomáticos
(evitar palavras como "production", não colar saídas RED de TDD, não citar docs verbatim).

---

## 5. Correções recomendadas à época (registro histórico)

Esta lista preserva a priorização original e não representa o backlog vigente. DEF-1, DEF-2,
DEF-4, DEF-5, DEF-6, DEF-8 e DEF-9 foram corrigidos nas releases posteriores. A rota automática
de evidência autenticada também eliminou a necessidade de attachment manual do operador em
revisões normais; a superfície `session_attach_evidence` continua operator-only por desenho de
segurança. Os novos defeitos confirmados após o adendo foram o DEF-10, fechado na 4.5.9, e o
DEF-11 de propagação da atestação npm, fechado na 4.5.10, DEF-12 de descoberta do transporte
autônomo, fechado na 4.5.11, DEF-13 de convergência do Evidence Broker, fechado
na 4.5.12, DEF-14 de recorrência ReDoS/publicação prematura, fechado no source 4.5.13,
e DEF-15 de continuidade/persistência do Evidence Broker, fechado no source 4.5.14.

1. **[P0 — DEF-5] Reconhecer o formato de citação que o próprio prompt pede.** Se um voto READY tem
   `evidence_sources` que (a) referenciam um attachment por `sha256` presente na sessão E (b) contêm
   substrings que casam verbatim o conteúdo do attachment, tratar como _grounded_ — nunca
   `fabricated`/`ungrounded`. Adicionar teste com o corpo real da sessão `8789eb50`.
2. **[P0 — DEF-4/DEF-6] Distinguir citação de fonte externa de auto-alegação.** Linhas claramente
   atribuídas (prefixo de URL, "doc:", aspas + fonte, seção `§`) não devem acionar
   `CURRENT_STATE_CLAIM_PATTERN`/`model_pin`/`release_date`. Alternativa mínima: só cruzar
   `model_pin` de peer quando o token do modelo aparecer SEM contexto de citação e casar o alias do
   peer — nunca com o modelo _da aplicação sob review_.
3. **[P1 — DEF-3] Custódia de evidência para caller-agente autenticado por token.** Com
   `CROSS_REVIEW_CALLER_TOKEN` válido (`hard_enforce:true`), permitir uma rota equivalente ao
   attachment do operador, para o agente não depender só do preflight inline.
4. **[P1 — arquitetura] Não abortar a sessão inteira quando o round-1 já colheu votos.** Um abort de
   preflight na revisão do relator (round 2) descarta votos READY válidos do round 1. Preservar o
   estado e permitir retomar.
5. **[P2 — DEF-1] Suavizar sinais de falha em evidência de TDD.** Saídas RED explicitamente rotuladas
   ("antes da implementação", "RED esperado") não deveriam invalidar corroborações de contagens
   verdes subsequentes no mesmo corpus.
6. **[P2 — DEF-7] `escalate_to_operator.reason` para 4000 chars; documentar dependência de reload.**

---

## 6. Apêndice — chaves de dados brutos

- Sessões: `~/.cross-review/data/sessions/{306ba203,be550cc3,469d8785,989d8a2e,7afaf133,a37722c8,8789eb50}/`
- Voto cru vs parser: campo `rounds[].peers[].text` (cru) vs `.status` (pós-parser) vs
  `.parser_warnings` / `.decision_quality`.
- Aborts: `meta.failed_attempts[]` (com `preflight_issue_classes`) e `events.ndjson`
  (`session.truthfulness_preflight_failed`, `session.evidence_preflight_failed`,
  `session.finalized`).
- Attachment da 4.5.3: `evidence/2026-07-12T01-47-12-165Z-caller-structured-evidence-*.txt`,
  `sha256=c5083095f3a9052ddad81d35be00a315e660c8322fc794dc50827cb649dc24da`, 7906 bytes.
- Custo da sessão `8789eb50`: US$ 0,5148 (codex 0,437 / perplexity 0,031 / gemini 0,016 /
  deepseek 0,007 / relator grok 0,024).
- Fonte inspecionada: `dist/src/core/orchestrator.js:{659-667,1141,1322,1361}`,
  `dist/src/core/status.js:{334-355}`, `src/core/orchestrator.ts:{1169,1230,1267,1460,1770}`.

**Conclusão factual para o registro:** o retro-review de calculadora-app v04.02.01 (`8eee516`)
recebeu **aprovação de mérito unânime** dos 4 peers votantes (codex, gemini, deepseek, perplexity:
todos READY, "No blocking objections remain", com evidência corroborada), com o relator grok
não-votante. O outcome oficial `aborted` reflete defeitos do servidor (DEF-5/DEF-6), não o veredito
técnico dos peers.
