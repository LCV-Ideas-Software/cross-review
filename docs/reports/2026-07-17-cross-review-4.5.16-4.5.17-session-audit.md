# Auditoria circunstanciada de sessões — cross-review 4.5.16 e 4.5.17

Data da auditoria: 2026-07-17  
Escopo: todas as sessões duráveis criadas desde a publicação de
`v04.05.16`, logs correspondentes, source `v04.05.16..v04.05.17`, contratos
oficiais das seis APIs e correções preparadas para `v04.05.18`.

## 1. Conclusão executiva

O corpus contém exatamente cinco sessões 4.5.16 e nenhuma sessão 4.5.17.
Houve 29 chamadas de modelo, 113.267 tokens e custo reconciliado de
US$ 0,964851031. Nenhum provider rejeitou o request, nenhum pin divergiu e
nenhum parser perdeu uma resposta completa. Uma sessão convergiu em uma rodada,
com quatro revisores `READY`, evidência automática e zero intervenção humana.

A auditoria, contudo, confirmou defeitos internos do cross-review:

1. votos factuais `NOT_READY` e fontes apresentadas com `NEEDS_EVIDENCE` não
   recebiam o mesmo grounding anti-fabricação aplicado a `READY`;
2. respostas concluídas só ganhavam artefato durável depois do peer mais lento;
3. loops recusados pelo preflight perdiam o draft e permaneciam abertos até o
   reaper;
4. cache e custo dos evidence judges não eram integralmente manifestados;
5. o judge shadow executava contra asks recém-criadas, quando ainda não podia
   existir nova evidência;
6. relatórios descartavam ações pedidas pelos peers e privilegiavam eventos de
   streaming;
7. sessões sem chamadas mostravam custo desconhecido em vez de zero;
8. a sessão não preservava snapshot redigido da configuração efetiva;
9. consenso unânime dos judges por `satisfied=false` era descrito como
   disagreement;
10. a expressão técnica “Service Bindings” acionava indevidamente o detector
    genérico de estado de um “service”.

Esses pontos estão cobertos no source 4.5.18 por regressões herméticas. O judge
automático foi desligado na configuração central como contenção até o reload do
novo runtime.

Uma revisão independente do patch, executada antes da suíte integral, encontrou
cinco lacunas residuais que ainda não apareciam no corpus: o artefato antecipado
do peer não participava do ledger de recovery; cache de geração era escrito
antes do resultado durável e com label de falha; judges herdavam effort `max`;
custo pendente desconhecido era convertido em zero; e a demoção de um
`NOT_READY` sem fonte não criava um ask acionável. Todas ganharam reproduções
vermelhas antes da correção e estão detalhadas em DEF-26 a DEF-30.

O fechamento independente encontrou ainda quatro janelas que também foram
reproduzidas antes de qualquer correção: uma quote autêntica mas irrelevante
mantinha um veto limpo; uma queda entre append da rodada e finalize deixava o
resultado material sem `final.md`; uma chamada de evidence judge podia ficar
reservada após crash ou ser contabilizada indevidamente por um recovery
concorrente; e o caminho de publicação aceitava um input de tag diferente do
ref do `workflow_dispatch`. Elas são DEF-33 a DEF-36. Nenhuma exigiu rodada
paga nem anexo/intervenção humana.

## 2. Método e limites

Foram examinados:

- 435 diretórios sob `<data_dir>/sessions`;
- 434 `meta.json` parseáveis e um diretório histórico sem metadata;
- todos os `meta.json`, `events.ndjson`, relatórios e artefatos relevantes das
  versões em escopo;
- o diff de produção entre 4.5.16 e 4.5.17;
- o source não publicado preparado para 4.5.18;
- documentação oficial e contratos de wire de OpenAI, Anthropic, Google,
  DeepSeek, xAI e Perplexity.

Não foram abertas sessões, não houve reteste pago de providers e nenhum
resultado material foi inferido de narrativa sem conferir o artefato
persistido. O tag 4.5.16 foi publicado em 2026-07-13T10:16:17Z; todas as sessões
posteriores traziam versão explícita.

## 3. Estado do runtime e da configuração

Um `server_info` novo, consultado durante esta auditoria, comprovou:

- runtime carregado: `4.5.17`;
- config carregada: SHA-256
  `57331b5b47bd80fedc9fed2cd4631554c10d1028048ce87e58130fcca38a054d`;
- config central atualizada: SHA-256
  `a8eec09cbafa07a11e814d7b46186d7e1769762ba20e2ecc31f24052e79fbef7`;
- `live_reload_supported=false`;
- `reload_required=true`;
- chamadas pagas bloqueadas por `CROSS_REVIEW_CONFIG_RELOAD_REQUIRED`.

Isso é o comportamento fail-closed esperado. A configuração em disco foi
alterada de forma atômica para:

- `evidence_judge_autowire.mode="off"`;
- Grok 4.5 acima de 200.000 prompt tokens: input `4`, cached input `1`,
  output `12` USD por milhão;
- card base Grok preservado em input `2`, cached input `0.5`, output `6`.

A chave nova `evidence_judge_autowire.max_output_tokens` não foi escrita
enquanto o host 4.5.17 permanecia carregado. O schema central é estrito e uma
chave desconhecida poderia invalidar o arquivo inteiro se o host antigo fosse
reiniciado. O runtime 4.5.18 usa default seguro de 2.048 tokens mesmo sem essa
chave.

## 4. Inventário completo

Todas as datas abaixo estão em UTC.

| Sessão                                 | Versão | Intervalo                       | Modo          | Resultado                                  | Rodadas |            Chamadas | Tokens |        Custo |
| -------------------------------------- | ------ | ------------------------------- | ------------- | ------------------------------------------ | ------: | ------------------: | -----: | -----------: |
| `5dd0845a-8ddf-4de8-9000-ffba7253aa76` | 4.5.16 | 15/07 09:26:43 → 16/07 23:06:38 | loop          | `aborted / stale_no_finalize_24h`          |       0 |             0 pagas |      0 |        US$ 0 |
| `e0b55698-d6d1-42fd-91e3-5ca7afd80c62` | 4.5.16 | 15/07 09:27:25 → 16/07 23:06:38 | loop          | `aborted / stale_no_finalize_24h`          |       0 |             0 pagas |      0 |        US$ 0 |
| `808fe68d-3985-428f-a048-5812a2ce7761` | 4.5.16 | 15/07 09:27:54 → 16/07 23:06:37 | rodada direta | `aborted / stale_no_finalize_24h`          |       1 | 5 review + 16 judge | 65.470 | US$ 0,782538 |
| `36214b31-1e47-42f4-addd-efc1385e2f55` | 4.5.16 | 17/07 00:17:29 → 00:19:32       | loop          | `max-rounds / generation_budget_preflight` |       1 |            4 review | 21.921 | US$ 0,089524 |
| `5e5d0389-6140-4454-b216-680864e7b12a` | 4.5.16 | 17/07 00:21:23 → 00:23:04       | loop          | `converged / unanimous_ready`              |       1 |            4 review | 25.876 | US$ 0,092789 |

Agregado:

- cinco sessões;
- três rodadas pagas;
- 13 reviews e 16 julgamentos;
- 92.854 tokens de review e 20.413 de judge;
- custo de review US$ 0,887963110;
- custo de judge US$ 0,076887921;
- total de 113.267 tokens e US$ 0,964851031;
- sete `READY`, três `NOT_READY` e três `NEEDS_EVIDENCE` no raw;
- seis `READY`, três `NOT_READY` e quatro `NEEDS_EVIDENCE` normalizados;
- uma demoção de `READY` correta, pois a quote composta pulava uma linha e não
  era substring literal.

## 5. Análise por sessão

### 5.1. Sessão `5dd0845a`

O evidence preflight recusou a afirmação agregada “163 passed” porque o pacote
listava `22 + 23 + 118` e não trazia a saída bruta correspondente ao total
agregado. O bloqueio antes de chamada paga foi defensável. O defeito foi de
durabilidade: o draft integral não foi persistido e a sessão só ganhou estado
terminal cerca de 37h40 depois, pelo stale reaper.

### 5.2. Sessão `e0b55698`

O pacote tinha resultados brutos de testes e uma seção de consulta live que
dizia `Pages bindings: WORKER->mainsite-motor; ADMIN_MOTOR->admin-motor`. A
frase do draft “caminho ativo Pages->Workers usa Service Bindings” foi
classificada como alegação genérica de saúde/estado de um `service`.

O problema não era exigir prova para um fato operacional; era a colisão lexical
entre o produto Cloudflare **Service Bindings** e o sujeito genérico
`service`. O runtime seguinte aceitou o mesmo fato quando recebeu JSON mais
literal, mas a categoria original ainda era incorreta. A 4.5.18 exclui
`Service Binding(s)` do detector de service-health e mantém bloqueado um claim
real como “the current service is healthy” quando não há status bruto.

Assim como na sessão anterior, o loop não preservou o draft e só terminou pelo
reaper cerca de 37h39 depois.

### 5.3. Sessão `808fe68d`

Cinco providers responderam sem rejeição:

- Gemini: `READY`;
- Claude: `NEEDS_EVIDENCE`;
- DeepSeek, Grok e Perplexity: `NOT_READY`.

A não convergência material não é bug. Os defeitos estão na confiança atribuída
aos vetos e na durabilidade:

- DeepSeek permaneceu `NOT_READY / clean` com zero `evidence_sources`;
- Claude permaneceu `NEEDS_EVIDENCE / clean` apesar de uma fonte declarar
  SHA-256
  `2e0d7ca35a1dd48478cc45cd6e918051b28d0ad6af76c86de9e409d94c48d841`,
  diferente do digest real
  `2e0d7ca35a1dd48478cc45cd6e918051b28ad6af76c86de9e409d94c48d8410d`;
- o código 4.5.16 retornava `grounded=true` para todo status que não fosse
  `READY`;
- pedidos factuais originados de um `NOT_READY` normalizado não eram
  encaminhados de forma consistente ao Evidence Broker.

As respostas já concluídas ficaram sem artefato final enquanto Perplexity
continuava executando. Atraso entre conclusão e persistência:

- Gemini: 422,746 s;
- Grok: 414,576 s;
- Claude: 315,135 s;
- DeepSeek: 295,506 s;
- Perplexity: 0,042 s.

O judge shadow executou 16 chamadas para quatro asks recém-criadas. Todos os 16
julgamentos disseram `satisfied=false`; mesmo assim, cada decisão agregada foi
rotulada `consensus_disagreement`. O manifesto de cache omitiu exatamente o
tráfego desses judges: 1.024 cache-read e 3.011 cache-write tokens.

O log tinha 123 eventos. O relatório usava somente os últimos 100 sem anunciar
o corte, omitindo 23 eventos iniciais. Dos 100 apresentados, 57 eram eventos de
stream (`peer.token.delta` ou `peer.token.completed`), enquanto
`caller_requests` e `follow_ups` não eram renderizados.

### 5.4. Sessão `36214b31`

O budget funcionou corretamente. Depois de quatro reviews, a geração de Claude
foi estimada em US$ 9,787594, acima do teto persistido de US$ 5; nenhuma chamada
de geração ocorreu. O outcome público `max-rounds` é mais amplo que o nome
sugere, mas está documentado desde versões anteriores como bucket de limite de
rodadas **ou orçamento**. Reclassificá-lo isoladamente quebraria métricas,
health, dashboard e consumidores.

Portanto, a 4.5.18 preserva `max-rounds / generation_budget_preflight`. Uma
eventual taxonomia futura deve criar um outcome próprio, como
`budget-exhausted`, em mudança deliberada de contrato.

### 5.5. Sessão `5e5d0389`

Este é o controle positivo:

- quatro revisores `READY / clean`;
- nenhum rejected;
- evidência persistida automaticamente;
- truthfulness e evidence preflight aprovados;
- convergência em uma rodada;
- zero upload, promoção ou finalização humana.

Ele comprova que o caminho feliz 4.5.16 funciona e que não havia
incompatibilidade generalizada de API. Não neutraliza os defeitos de caminhos
bloqueadores e de observabilidade descritos acima.

## 6. Defeitos e remediações 4.5.18

### DEF-17 — grounding assimétrico de vetos factuais

**Severidade:** alta.

`READY` era verificado contra artifact/attachments; `NOT_READY` e
`NEEDS_EVIDENCE` escapavam pelo retorno antecipado. Isso permitia que uma
alucinação bloqueadora impedisse unanimidade e gerasse rodadas adicionais.

**Correção:**

- `READY` e `NOT_READY` são verdicts definitivos e precisam de fonte grounded;
- `NOT_READY` factual sem fonte ou com fonte falsa vira `NEEDS_EVIDENCE`,
  `decision_quality` não-clean e transformação `blocking_grounding`;
- `NEEDS_EVIDENCE` pode legitimamente não ter fonte, mas uma fonte fornecida e
  fabricada/ungrounded gera warning auditável;
- pedidos originalmente escritos no `NOT_READY` continuam sendo asks do peer,
  não remediação inventada pelo servidor.

### DEF-18 — perda potencial antes da barreira do peer mais lento

**Severidade:** alta.

O `Promise.all` precisava terminar antes do primeiro `savePeerResult`.

**Correção:**

- cada resposta/falha é gravada como `provider-response`/`provider-failure`
  assim que a chamada termina;
- o settlement entra também em `in_flight.provider_settlements`, com path,
  usage, cost, attempts e billing status;
- restart/cancel move settlements já concluídos para o ledger interrompido e
  marcam como desconhecidos apenas os peers ainda não resolvidos;
- ao append normal, o ledger temporário é promovido sem dupla contagem;
- `peer.call.completed` é emitido depois da persistência;
- a versão normalizada continua sendo salva ao final, preservando raw e decisão
  pós-gates como artefatos distintos.

### DEF-19 — preflight sem draft durável e sessão stale-open

**Severidade:** alta para auditabilidade.

**Correção:**

- loops salvam o draft antes dos gates locais;
- truthfulness/evidence preflight recusado termina imediatamente em
  `aborted / needs_*_preflight`;
- `ask_peers`, que é iterativo, mantém sua rodada local recusada e aberta para a
  correção seguinte;
- nenhuma rota exige operador humano.

### DEF-20 — custo, cache e oportunidade dos judges

**Severidade:** média/alta por gasto repetitivo.

**Correção:**

- budget do judge soma o custo da rodada paga ainda em voo;
- cap próprio `max_output_tokens`, default 2.048, mínimo 256;
- effort próprio, default `medium`, sem herdar o `max` dos reviews;
- estimate e chamada usam o modelo real e o mesmo cap;
- custo pendente desconhecido/unpriced bloqueia o judge em vez de virar zero;
- asks criadas na rodada atual aguardam uma submissão posterior antes de
  disparar judge;
- manifesto registra `call_kind` e `call_label` para review, generation e
  evidence judge.

### DEF-21 — relatório não acionável

**Severidade:** média.

**Correção:**

- token deltas deixam a timeline padrão;
- truncamento e quantidade suprimida são anunciados;
- `caller_requests` e `follow_ups` aparecem por peer;
- Markdown não imprime campos `undefined`;
- `session_list` trata metadata sem outcome como open e expõe
  `not_resurfaced_evidence_items`.

### DEF-22 — zero chamadas exibido como custo desconhecido

**Severidade:** baixa.

**Correção:** sessões accounting-v2 com zero chamadas têm custo conhecido igual
a US$ 0. Sessões históricas/incompletas continuam sem inventar reconciliação.

### DEF-23 — configuração efetiva não reproduzível

**Severidade:** média.

**Correção:** toda sessão nova guarda snapshot redigido e SHA-256 de modelos,
fallbacks, seleção, enablement, effort, retry, budgets, limites de prompt,
output caps, preflights, streaming, judge, cache, controles Perplexity e rate
cards. Credenciais não entram no snapshot.

### DEF-24 — semântica de consenso shadow

**Severidade:** média.

**Correção:** todos os judges em falso produzem `consensus_unsatisfied`, não
`consensus_disagreement`; eventos shadow não atribuem arbitrariamente o
resultado a um peer, e a mensagem explica que a exclusão do autor ocorre por
item.

### DEF-25 — falso positivo lexical em Service Bindings

**Severidade:** média.

**Correção:** a expressão de produto `Service Binding(s)` não é mais tratada
como sujeito de health/status. Alegações reais sobre service/CI/deploy continuam
fail-closed.

### DEF-26 — artefato antecipado órfão do ledger de recovery

**Severidade:** alta.

A primeira correção de DEF-18 escrevia o JSON antes da barreira, mas
`accountInterruptedInFlight` ainda marcava todos os peers como desconhecidos.
O arquivo sobrevivia; usage/cost e o fato de o peer já ter concluído não.

**Correção:** settlement mínimo e redigido por chamada passa a integrar
`meta.in_flight`. A primeira resposta e cada recovery têm artefato próprio; a
recovery recebe uma reserva durável antes do dispatch, removida atomicamente
quando seu resultado ou falha é assentado. Recovery de processo preserva os
valores exatos em `interrupted_provider_settlements`; apenas peers iniciais não
assentados e reservas ainda abertas recebem tentativa conservadora desconhecida.
O relatório exibe esses settlements sem fingir que formam uma rodada/voto
completo.

### DEF-27 — cache de geração anterior ao ledger

**Severidade:** alta para reconciliação.

`generateWithFailureAccounting` registrava cache antes de `saveGeneration` e
recebia labels como `initial-draft-failure` para uma geração bem-sucedida. Um
crash na janela deixava cache/custo sem a geração autoritativa.

**Correção:** a ordem é provider result → `saveGeneration` → cache manifest. O
label de sucesso (`initial-draft`, `revision` ou `rotation`) é separado do label
de failure e compartilhado pelo artefato e pela telemetria.

### DEF-28 — judge compacto herdava effort máximo e aceitava custo desconhecido

**Severidade:** alta por risco de truncamento e gasto.

O cap de 2.048 tokens não impedia OpenAI/Anthropic de herdarem effort `max`.
Além disso, `total_cost ?? 0` permitia novas chamadas quando uma tentativa da
rodada ainda estava sem preço confiável.

**Correção:** judge tem effort independente configurável, default `medium`, e
o preflight falha fechado quando qualquer tentativa paga atual ou histórica tem
`unpriced_attempts`, billing desconhecido ou custo não finito. Quando a rodada
atual já está no ledger in-flight, seu total é subtraído da base antes de o
agregado pendente ser somado, eliminando dupla contagem.

### DEF-29 — demoção de veto sem pedido acionável

**Severidade:** alta para convergência.

O runtime convertia `NOT_READY` sem fonte em `NEEDS_EVIDENCE`, mas guardava a
remediação apenas dentro de `decision_transformations`; o Evidence Broker lê
`structured.caller_requests`.

**Correção:** a remediação de citação é deduplicada e persistida em
`caller_requests`. O parecer durável conserva os pedidos de correção originais
para auditoria, mas o Evidence Broker recebe somente a remediação de citação
sintetizada; prosa como “corrija o DELETE” não volta a nascer como item
histórico `not_resurfaced`. O prompt também informa que `NOT_READY` é veredito
factual definitivo e precisa citar seus bloqueios; sem fonte, o peer deve pedir
a prova.

### DEF-30 — snapshot efetivo ainda incompleto

**Severidade:** média.

O primeiro snapshot omitia limites de prompt e os controles Perplexity
`disable_search`, `search_context_size` e `probe_mode`.

**Correção:** ambos os blocos foram incluídos; o teste também confirma que
`api_keys` e valores secretos continuam ausentes.

### DEF-31 — tier OpenAI herdado do projeto

**Severidade:** alta para reconciliação financeira.

O adapter não enviava `service_tier`. Pela documentação oficial de Priority
Processing, a omissão permite que a configuração do projeto selecione outro
tier, enquanto o ledger local continuava pressupondo a tabela Standard.

**Correção:** review, generation, judge e retries compartilham payloads com
`service_tier: "default"`. O preço configurado passa a corresponder
deterministicamente ao tier Standard; o contrato wire é coberto por regressão.

### DEF-32 — publicação alternativa contornava o hardgate

**Severidade:** crítica para supply chain.

O auto-tag validava CI/CodeQL/alertas, mas `workflow_dispatch` e tag manual
podiam acionar `publish.yml` sem repetir esse vínculo. Workflows condicionais
também podiam ainda estar em execução.

**Correção:** o próprio publish revalida tag = `origin/main`, aguarda CI,
CodeQL, Socket e, quando aplicáveis, Scorecard, Pages e jobs Dependabot, exige
as duas análises CodeQL processadas para o SHA e zero alertas abertos. Depois de
publicar via OIDC/provenance, instala a versão exata sob as restrições npm 12 e
executa `npm audit signatures`, que verifica assinatura de registry e
attestation de provenance.

### DEF-33 — quote grounded, porém irrelevante, sustentava veto factual

**Severidade:** alta para anti-enganação e convergência.

O validador comprovava path, SHA-256 e literal da quote, mas não verificava se
ela sustentava o bloqueio concreto enunciado pelo peer. Assim, uma citação
autêntica de `src/index.ts:10` podia acompanhar a afirmação de defeito em
`db.ts:99` e ainda manter `NOT_READY` como veto limpo.

**Correção:** um `NOT_READY` factual precisa agora trazer referência
`path:line` no resumo que corresponda à mesma fonte já grounded. A fonte
autêntica, porém desconexa, é preservada no artefato para auditoria, mas o
veredito é transformado em `NEEDS_EVIDENCE`; nenhuma correção de produto é
reaberta pelo broker a partir dessa transformação interna.

### DEF-34 — crash após append podia conservar mérito sem artefato final

**Severidade:** alta para autonomia operacional.

Uma rodada unânime já persistida entre `appendRound` e `finalize` sobrevivia,
mas a recovery a tratava como sessão interrompida. O resultado material estava
no disco e não havia nova chamada a provider, mas faltava `final.md` e o selo
terminal.

**Correção:** a recovery reconhece convergência durável, reconstrói o artefato
final a partir da rodada já anexada e registra `session.finalized` sob o lock
da sessão. O caminho não reabre checklist, não cobra provider e não pede ao
operador para anexar ou finalizar nada.

### DEF-35 — reserva síncrona de evidence judge não sobrevivia corretamente

**Severidade:** crítica para custo e recuperação.

O judge síncrono não cria `in_flight`; uma queda deixava sua reserva global sem
sweep automático e uma recovery manual podia contabilizar como desconhecida uma
chamada ainda viva. Além disso, um cancelamento durante o judge podia ficar
parado em `cancel_requested`.

**Correção:** reservas passam a guardar `owner_pid`; a inicialização varre
reservas de dono morto, mas preserva sessões com chamada viva. A recovery
terminaliza cancelamento somente depois da liquidação conservadora e todos os
eventos de recovery usam o lock normal. Os modos single e consensus voltam a
avaliar cancelamento antes de promover evidência, e a transição compartilhada
`markEvidenceItemAddressedByJudge` revalida `cancel_requested` dentro do lock:
um cancelamento que vence entre a checagem otimista e a promoção deixa o item
aberto e termina a sessão como `aborted/session_cancelled`.

### DEF-36 — identidade de ref de release podia divergir do despacho

**Severidade:** crítica para supply chain.

O `workflow_dispatch` é necessário: por documentação do GitHub, tag criada com
`GITHUB_TOKEN` não aciona outro workflow. Contudo, o input livre `tag` podia
substituir o ref real do despacho e criar ambiguidade entre tag, checkout e
provenance.

**Correção:** `workflow_dispatch` permanece somente como ponte sobre o próprio
ref da tag, sem input. Auto-tag chama `gh workflow run publish.yml --ref
"$TAG"`; Publish exige `github.ref_type=tag`, `github.ref=refs/tags/<nome>` e
`github.ref_protected=true`, e revalida tag = checkout = `main` após os testes
locais e antes de cada escrita externa. A auditoria live confirmou a ruleset
organizacional ativa `tag ruleset` (ID 16728097) em `refs/tags/v*`, sem bypass,
com `deletion`, `non_fast_forward` e `required_signatures`; `v04.05.17` é tag
leve que aponta para `8e790116`, cujo commit tem assinatura válida.

Fontes oficiais deste controle: <https://docs.github.com/en/actions/concepts/security/github_token>,
<https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows>,
<https://docs.github.com/en/actions/reference/workflows-and-actions/contexts> e
<https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets>.

### 6.1 Achados da validação final da 4.5.18 (não inferidos do corpus)

Estes achados vieram da validação local red/green da remediação, não das cinco
sessões 4.5.16 auditadas. Eles são registrados separadamente para não alterar a
evidência histórica do corpus.

#### REG-37 — recovery selava cancelamento sem reconhecimento do dono morto

**Severidade:** alta para trilha de auditoria e custo.

Um processo morto com `cancel_requested`, sem ter reconhecido ou liquidado a
chamada em voo, era tratado como `cancelled` terminal. Isso escondia trabalho
interrompido e podia descartar a recuperação conservadora de custo.

**Correção:** a recovery distingue cancelamento terminal já reconhecido de uma
solicitação persistida cujo dono morreu. O segundo caso segue o caminho de
recovery auditável, preservando settlements e contabilizando somente o que
permanece desconhecido. O cenário vermelho e verde está em
`v4.5.4-durable-jobs-regression`.

#### REG-38 — extração de símbolo do Evidence Broker tinha backtracking quadrático

**Severidade:** alta para disponibilidade local.

O matcher de `snake_case` aceitava a flag case-insensitive e podia retroceder
quadraticamente diante de uma entrada adversarial composta por 100.000 letras
maiúsculas seguidas de `_`. A extração ocorre sobre texto da solicitação, logo
o limite precisava ser determinístico.

**Correção:** o matcher foi substituído por varredura ASCII linear, preservando
as formas camelCase, snake_case e UPPER_SNAKE. A regressão
`evidence-transport-regression` mantém o limite de dois segundos e verifica a
correlação funcional.

#### REG-39 — guardrails de validação fortalecidos

**Telemetria.** O runtime já removia a autoria escalar fabricada de consenso
shadow, mas o smoke estático ainda exigia `judge_peer` nesse evento. A asserção
foi substituída por contrato dinâmico: shadow transporta o painel
`judge_peers` e `per_peer_verdict`, sem `peer` nem `judge_peer`; uma promoção
ativa mantém o autor real. A regressão de telemetria passou de dois para três
casos.

**Registry npm.** O fixture pós-publicação tinha `NPM_CONFIG_REGISTRY`, mas as
três chamadas `npm init`, `npm install` e `npm audit signatures` não declaravam
o registry inline. Todas agora fixam `https://registry.npmjs.org`, preservando
a variável como defesa em profundidade. A política é coberta por
`npm-v12-release-security-regression` e pelo smoke de disciplina de registry.

#### REG-40 — sweep stale podia roubar uma chamada de judge ainda viva

**Severidade:** alta para durabilidade e contabilização.

`clearStaleInFlight` observava apenas o PID de geração/background e o lock
transitório. Depois de 30 minutos, podia reconciliar o `in_flight` de uma
rodada cujo evidence judge ainda tinha uma reserva com `owner_pid` vivo. Isso
removia o envelope antes do settlement real e podia criar tentativa unknown
duplicada.

**Correção:** o sweep identifica reserva pendente de dono vivo antes de tentar
o lock e repete a verificação já dentro do lock. A rodada e a reserva continuam
intactas até o resultado/falha durável. A nova regressão está em
`v4.5.4-durable-jobs-regression`.

#### REG-41 — `not_resurfaced` tornava uma pendência invisível ao judge

**Severidade:** crítica para convergência autônoma.

O autowire selecionava IDs abertos antes da inferência de resurfacing, mas
depois aceitava somente itens ainda `open`. Quando um peer retornava `READY`,
a ask histórica virava `not_resurfaced`, continuava bloqueando o hardgate e já
não chegava ao judge. Os executores single/consensus e a promoção atômica
também restringiam a transição a `open`.

**Correção:** itens preexistentes `open` e `not_resurfaced` são elegíveis; os
dois executores os preservam na fila e a promoção verificada permite
`open|not_resurfaced → addressed`, sem tocar estados terminais do operador.
Há regressões separadas para autowire single e consenso em
`v4.5.18-contract-gaps-regression`.

#### REG-42 — piso implícito do judge podia ultrapassar cap explícito

**Severidade:** média para orçamento e obediência à configuração.

`evidenceJudgeOutputTokens` aplicava `max(256, min(peerCap, judgeCap))`. Como
o schema central aceita caps positivos menores que 256, uma configuração de
64 tokens podia gerar chamada de 256 e uma estimativa de custo incompatível.

**Correção:** o cap efetivo é somente `min(peerCap, judgeCap)`; ambos já são
validados como positivos pelo schema. A regressão fixa um cap Codex de 64 e
confirma que o contexto wire recebe 64, não 256.

#### REG-43 — reserva durável ainda parecia custo reconciliado no relatório

**Severidade:** alta para transparência financeira.

Antes de settlement, `sessionCostBreakdown` ignorava
`pending_provider_call_reservations` e
`in_flight.provider_call_reservations`. Uma sessão accounting-v2 sem outro
artefato podia então exibir US$ 0 e `reconciled: true` apesar de uma chamada
paga em curso.

**Correção:** cada reserva pendente conta como tentativa sem preço, impede o
fallback de total zero e mantém `reconciled: false` até o settlement. A
regressão em `server-reports-regression` cobre reserva de judge e de recovery.

#### REG-44 — geração em voo ainda podia parecer custo zero reconciliado

**Severidade:** alta para transparência financeira.

O marcador `generation_in_flight` é escrito antes de `adapter.generate`, mas o
breakdown de custo só observava settlements e reservas. Em uma sessão v2 sem
outro artefato, a geração em curso ainda podia cair no fallback de US$ 0 e
`reconciled: true`.

**Correção:** geração em voo é uma tentativa não precificada até a liquidação
atômica por `saveGeneration` ou `recordPeerFailureAccounting`. O relatório
passa a exibir custo desconhecido e `reconciled: false` durante esse intervalo.

#### REG-45 — peers primários em voo ainda podiam parecer custo zero reconciliado

**Severidade:** alta para transparência financeira.

Os peers da rodada principal ficam em `in_flight.peers` antes de cada resultado
ou failure ser persistido. Sem settlement primário correspondente, o relatório
não os contava como trabalho pendente e podia anunciar uma reconciliação zero.

**Correção:** cada peer sem settlement primário é contado como dispatch
desconhecido no breakdown. Settlements de recovery permanecem separados pelo
`reservation_id`, sem duplicar os peers primários já liquidados.

#### REG-46 — preflight do judge e da geração divergia sobre custo desconhecido

**Severidade:** crítica para controle de orçamento.

O preflight do judge recebeu a regra fail-closed, mas inicialmente omitia
`generation_in_flight`. Separadamente, a geração do relator convertia
`total_cost` ausente em zero mesmo quando havia tentativas históricas sem preço.
Assim, qualquer um desses caminhos podia iniciar nova chamada paga acima de um
teto que já não era mensurável.

**Correção:** `sessionHasUnknownProviderSpend` inclui geração em voo e é usado
por ambos os preflights. Judge single/consensus e geração abortam antes do
dispatch, persistem `generation_budget_preflight` quando aplicável e não
inventam um custo corrente numérico.

#### REG-47 — round e format recovery podiam ser roubados pelo sweep após 30 min

**Severidade:** crítica para durabilidade.

`markInFlight` não persistia dono. Uma rodada síncrona longa, especialmente um
peer primário, fallback ou retry de moderação, ficava sem lock durante a espera
da API. Outro host podia então considerar a rodada velha e apagá-la. A reserva
de format recovery tinha o mesmo problema individualmente.

**Correção:** `InFlightRound` e `ProviderCallReservation` agora persistem
`owner_pid`. `clearStaleInFlight` e `recoverInterruptedSessions` verificam todos
os donos conhecidos antes e depois de obter o lock. Sessões legadas sem esse
campo continuam recuperáveis; donos mortos são contabilizados
conservadoramente, enquanto trabalho de processo vivo não é roubado.

#### REG-48 — autowire podia julgar uma ask que o peer acabara de reabrir

**Severidade:** alta para a integridade do Evidence Broker.

O snapshot de IDs históricos era correto, mas o filtro posterior aceitava o
mesmo ID se a ask fosse reassertada pelo peer na rodada corrente. Isso permitia
o judge promover `addressed` contra uma nova `NEEDS_EVIDENCE`, contrariando a
regra de que autowire só julga evidência que predatou a rodada.

**Correção:** além do ID histórico e do estado `open|not_resurfaced`, autowire
exige `last_round < roundNumber`. O caso válido silêncio → `not_resurfaced`
continua elegível; a ask reaberta agora permanece aberta para uma rodada futura
com evidência nova.

## 7. Auditoria das seis APIs oficiais

| Peer             | Pin                      | Contrato confirmado                                                                                              | Resultado                                                            |
| ---------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| OpenAI/Codex     | `gpt-5.6-sol`            | Responses API; 1.050.000 contexto; 128.000 output; structured output; effort `none/low/medium/high/xhigh/max`    | correto; `ultra` vira `max` no wire; tier fixado em `default`        |
| Anthropic/Claude | `claude-fable-5`         | Messages API; adaptive thinking; `output_config.effort`; structured output sanitizado pelo helper oficial do SDK | correto; `maxItems` não chega cru à API                              |
| Google/Gemini    | `gemini-3.1-pro-preview` | `generateContent` oficialmente suportado; thinking `low/medium/high`; `responseJsonSchema` no subset documentado | correto; Interactions é avaliação futura, não migração obrigatória   |
| DeepSeek         | `deepseek-v4-pro`        | Chat Completions compatível; effort `high/max`; structured response `json_object`                                | correto                                                              |
| xAI/Grok         | `grok-4.5`               | Responses API; effort `low/medium/high`; contexto 500K; structured outputs                                       | adapter correto; faltava apenas o tier de preço >200K na config/docs |
| Perplexity       | `sonar-reasoning-pro`    | Sonar Chat API; effort até `high`; JSON Schema; `<think>` pode preceder JSON                                     | correto; `disable_search` não elimina request fee                    |

Rate cards OpenAI, Anthropic, Gemini, DeepSeek e Perplexity coincidiram com as
tabelas oficiais para o modo standard/global usado pelo runtime. O único ajuste
financeiro necessário foi o tier longo do Grok 4.5. Caps locais estão abaixo
dos limites oficiais e não foram aumentados sem evidência de truncamento.

Fontes oficiais:

- OpenAI: <https://developers.openai.com/api/docs/models/gpt-5.6-sol>,
  <https://developers.openai.com/api/docs/pricing> e
  <https://developers.openai.com/api/docs/guides/priority-processing#configuring-priority-processing>
- Anthropic:
  <https://platform.claude.com/docs/en/about-claude/models/introducing-claude-fable-5-and-claude-mythos-5>
- Google:
  <https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview>
- DeepSeek: <https://api-docs.deepseek.com/quick_start/pricing>
- xAI: <https://docs.x.ai/developers/models/grok-4.5>
- Perplexity: <https://docs.perplexity.ai/docs/getting-started/pricing>

## 8. Evidência TDD preparada

Regressões novas ou ampliadas:

- `v4.5.18-grounding-contract-regression`: 5 casos;
- `v4.5.18-durability-regression`: 12 casos;
- `v4.5.18-budget-cache-regression`: 10 casos;
- `v4.5.18-contract-gaps-regression`: 9 casos;
- `v4.5.18-judge-wire-contract-regression`: 8 casos;
- `v4.5.18-session-telemetry-regression`: 3 casos;
- `server-reports-regression`: 8 casos;
- `v4.5.18-pricing-regression`: 6 casos.

Total: 60 verificações focadas. Cada defeito novo acima foi observado vermelho
antes da correção e verde depois. A regressão de segurança npm v12 também
protege a identidade do dispatch por tag, ausência de input divergente,
revalidação pós-teste e verificação de `main` antes das três escritas externas.
Além delas, `v4.5.4-durable-jobs-regression` agora possui 24 verificações,
incluindo dono vivo de round primário, reserva de format recovery e
compatibilidade de recovery de sessão legada. As regressões afetadas já existentes somam outras
verificações focadas de grounding, judge/custo, accounting/preflight e
extração de símbolos limitada.

A validação remota, o SHA publicado, os workflows e a versão confirmada no npm
devem ser acrescentados a este relatório somente depois da convergência da
release; não são antecipados como sucesso.

## 9. Validação local de encerramento

Todos os testes desta seção usam os adapters stub; nenhum deles abre uma
chamada paga a provedor.

- `npm run check`: verde (Prettier, ESLint sem warnings, Biome e `tsc --noEmit`);
- `npm run smoke`: verde em 140,9 segundos, incluindo disciplina de registry,
  evidência, custo, durabilidade e os seis peers simulados;
- as regressões focadas novas e ampliadas descritas na seção 8: verdes;
- `npm test` iniciou corretamente, compilou e executou sem falha todos os
  blocos que conseguiu reportar, mas o invocador local o encerrou pelo limite
  externo de 240,9 segundos. Isso não é uma falha de teste e não foi mascarado
  como sucesso;
- para fechar sem repetir a cadeia inteira, a cauda exata não alcançada por
  esse limite foi executada isoladamente e ficou verde: transporte de
  evidência (57 checks), custody, truthfulness preflight (4), source contract
  (10) e `runtime-smoke` (build + seis peers stub, `ok: true`, versão fonte
  4.5.18).

Assim, cada componente da cadeia de `npm test` foi observado verde nesta
validação, embora o processo monolítico não tenha recebido um exit code final
por limitação do executor. A CI do GitHub continua sendo o verificador
autoritativo da execução monolítica no SHA publicado.

Também foi validado o Dependabot antes da publicação. A configuração cobre
`npm`, GitHub Actions, `pip`/`pip-compile` e `pre-commit`, que são todos os
ecossistemas/manifests presentes. O pin do binário npm nos workflows é uma
dependência de toolchain com atualização explícita, fora do escopo do
Dependabot; o validador `scripts/validate-dependabot-config.py` passou.

## 10. Plano de ação e critério de encerramento

1. concluir revisão independente do diff;
2. commit e sync direto no `main`;
3. acompanhar CI, CodeQL, release/publish e alertas no SHA exato;
4. confirmar `@lcv-ideas-software/cross-review@4.5.18` no npm com provenance;
5. após upgrade global e reload da janela, exigir `server_info.version=4.5.18`,
   config SHA atual e `reload_required=false`;
6. só então reabilitar `shadow` deliberadamente, se seu custo/benefício for
   desejado.

O trabalho não está concluído apenas porque o source está corrigido. O critério
final é: workflows verdes, zero alerta novo relevante e pacote 4.5.18 publicado
com sucesso.
