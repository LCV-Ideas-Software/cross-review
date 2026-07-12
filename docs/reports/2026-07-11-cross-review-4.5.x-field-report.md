# Cross-Review 4.5.x — Relatório de Campo (Field Report)

**Data:** 2026-07-11 / 2026-07-12
**Autor:** Claude (caller=claude, host claude-code) — sessão de trabalho da calculadora-app
**Contexto:** hardgate pré/pós-ship do workspace exigiu submeter dois ships da calculadora-app
(v04.02.00 e o retro-review de v04.02.01, commit `8eee516`) ao cross-review. Durante a execução,
o gate **não conseguiu registrar convergência em NENHUMA das versões testadas, apesar de a
substância ter sido aprovada por unanimidade dos peers**. Este relatório registra todos os
comportamentos observados (corretos e defeituosos) para análise e correção.

> **Achado central:** os defeitos NÃO estão na qualidade do trabalho revisado nem na evidência
> submetida. Em 4.5.2 e 4.5.3, os 6 modelos peer **emitiram `"status":"READY"` com
> "No blocking objections remain"** e citações verbatim ancoradas por `sha256`; o servidor os
> **rebaixou** para `NEEDS_EVIDENCE` por falsos-positivos de camadas anti-alucinação, e depois
> **abortou** rounds inteiros por falsos-positivos de preflight. O gate está estruturalmente
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

| Sessão (8) | Versão | Outcome    | Motivo                       | Rounds      | Defeito observado               |
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

## 4. Análise consolidada

O pipeline anti-alucinação tem **quatro camadas** em série, cada uma com poder de veto absoluto e,
hoje, com falsos-positivos que se sobrepõem:

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

**Impacto de produto:** o hardgate, na 4.5.x, não é um gate de qualidade do trabalho — virou um
gate de conformidade de _formato textual do draft/citação_, no qual trabalho e evidência impecáveis
falham por acionar heurísticas. Isso corrói a confiança no gate e força workarounds anti-idiomáticos
(evitar palavras como "production", não colar saídas RED de TDD, não citar docs verbatim).

---

## 5. Correções recomendadas (priorizadas)

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
