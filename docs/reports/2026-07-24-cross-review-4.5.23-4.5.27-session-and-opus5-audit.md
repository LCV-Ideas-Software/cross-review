# Auditoria técnica do cross-review 4.5.23–4.5.27 e preparação para Claude Opus 5

Data da auditoria: 24 de julho de 2026  
Versão publicada carregada durante a análise: 4.5.27  
Versão corretiva final preparada: 4.5.29
Nota de release: a tag imutável 4.5.28 não foi publicada; o gate detectou a
GHSA-mh99-v99m-4gvg, divulgada durante a entrega, e exigiu 4.5.29 com
`brace-expansion` 5.0.8.

## 1. Resumo executivo

Foram auditadas todas as sessões duráveis identificadas como originadas pelas
versões 4.5.23 a 4.5.27, bem como seus eventos e os logs recentes disponíveis.
A análise confirmou cinco classes principais de defeito:

1. recuperação incompleta de sessões interrompidas, incluindo falsos estados
   `running`, PID reciclado e job durável órfão;
2. crescimento ilimitado do Evidence Broker, capaz de amplificar prompts,
   tokens e custo a cada rodada;
3. falso positivo do `truthfulness_preflight` sobre uma condição futura;
4. identificadores de checklist emitidos pelo próprio servidor classificados
   como possíveis evidências fabricadas;
5. diagnóstico agregado insuficiente quando o grounding de uma alegação falha
   contra um de dois corpora distintos.

Também foi identificada uma oportunidade operacional comprovada:
`session_events` devolvia eventos sem limite de página e incluía, por padrão,
telemetria granular de tokens que representou 59,1% dos registros nos logs
recentes analisados.

O worktree 4.5.28 contém correções direcionadas para essas classes:

- recuperação automática e coerente de sessão, controle, saúde, contabilização
  e job após reinício;
- validação da data de início do processo para detectar PID reciclado;
- circuit breaker fail-closed e admissão atômica para o Evidence Broker;
- tratamento correto de condições temporais futuras;
- incorporação dos IDs de checklist emitidos pelo servidor ao corpus de
  proveniência;
- diagnóstico por alegação e por corpus;
- paginação e filtragem de `session_events`;
- proteção reforçada do arquivo local de caller tokens.

O adaptador Anthropic também foi preparado para `claude-opus-5` como override
explícito do operador. O modelo ativo permanece `claude-fable-5`; Opus 5 não foi
introduzido como fallback automático. A alteração inclui request wire,
classificação de recusas, limites de cache, SDK e tabela de custos.

O achado de segurança mais importante é residual: a DACL protegida reduz a
exposição do arquivo `host-tokens.json` a grupos herdados, mas não isola dois
processos irrestritos executados sob o mesmo SID. Para esse threat model, a
solução definitiva exige verifiers persistidos pelo servidor e distribuição de
cada segredo bruto exclusivamente ao respectivo host, com o token de operador
mantido em vault ou identidade de sistema operacional separada.

## 2. Escopo e metodologia

### 2.1 Escopo temporal

O corpus foi selecionado pela versão de runtime persistida em cada sessão:

| Versão | Sessões |
| ------ | ------: |
| 4.5.23 |       5 |
| 4.5.24 |       0 |
| 4.5.25 |      26 |
| 4.5.26 |      15 |
| 4.5.27 |       0 |
| Total  |      46 |

A ausência de sessões 4.5.24 e 4.5.27 no armazenamento auditado não autoriza
inferir ausência de uso em outros hosts; significa apenas que não havia sessão
durável dessas versões no corpus local disponível.

### 2.2 Fontes examinadas

A auditoria considerou:

- `meta.json`, rounds, prompts, respostas e relatórios duráveis das 46 sessões;
- eventos sequenciais persistidos por sessão;
- 11 arquivos de log recentes disponíveis;
- estado de controle, saúde, contabilização, reservas de provedor e jobs
  duráveis;
- transformações de status raw, parsed e normalized;
- escopo de convergência, identidade declarada e identidade verificada;
- referências e textos de evidência persistidos;
- configuração, adaptadores e regressões presentes no worktree 4.5.28.

Foram inspecionados 1.403 arquivos de sessão e log. A análise forense foi
somente leitura: não abriu sessões novas e não chamou provedores pagos.

### 2.3 Critério de classificação

Um comportamento foi classificado como bug comprovado apenas quando havia
estado persistido reproduzível, incompatibilidade direta entre invariantes do
runtime ou replay determinístico da regra. Relatos externos sem a sessão exata
foram mantidos como hipóteses de investigação, não convertidos em conclusão.

As correções do worktree foram avaliadas pelo contrato observável que
implementam. A seção de validação distingue:

- teste direcionado já executado no momento da alteração;
- inspeção estática do worktree;
- validação integrada ainda pendente;
- CI, publicação e runtime pós-reload ainda pendentes.

## 3. Caracterização do corpus

### 3.1 Volume e custo

| Métrica                         |       Resultado |
| ------------------------------- | --------------: |
| Sessões                         |              46 |
| Rounds                          |              95 |
| Tokens contabilizados           |       6.080.046 |
| Custo contabilizado             | US$ 54,67147309 |
| Eventos duráveis de sessão      |           4.439 |
| Eventos nos 11 logs recentes    |           3.983 |
| JSON inválido                   |               0 |
| Lacunas de sequência detectadas |               0 |

### 3.2 Outcomes

| Outcome observado | Sessões |
| ----------------- | ------: |
| Convergidas       |       6 |
| Limite de rounds  |      20 |
| Abortadas         |      18 |
| Abertas           |       2 |

A baixa taxa de convergência no corpus não prova, isoladamente, defeito no gate.
Ela combina interrupções, limites de rounds, exigências legítimas de evidência e
defeitos específicos detalhados neste relatório.

### 3.3 Transformações de status

Foram examinadas 274 respostas de peers:

| Status raw e destino                             | Quantidade |
| ------------------------------------------------ | ---------: |
| `READY` preservado                               |        118 |
| `READY` rebaixado                                |         61 |
| `NEEDS_EVIDENCE` preservado                      |         77 |
| `NOT_READY` rebaixado por grounding insuficiente |         18 |

Dos 179 votos raw `READY`, 34,1% foram rebaixados. Esse número demonstra custo e
atrito relevantes, mas não autoriza presumir que todos os rebaixamentos eram
falsos positivos. A auditoria separou os casos comprovadamente incorretos das
aplicações conservadoras deliberadas do contrato.

## 4. Contrato oficial do Claude Opus 5

### 4.1 Fontes oficiais utilizadas

O contrato foi derivado exclusivamente da documentação oficial da Anthropic e
do release oficial do SDK:

- [What's new in Claude Opus 5](https://platform.claude.com/docs/en/about-claude/models/whats-new-opus-5)
- [Claude model migration guide](https://platform.claude.com/docs/en/about-claude/models/migration-guide)
- [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Effort](https://platform.claude.com/docs/en/build-with-claude/effort)
- [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Refusals and fallback](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback)
- [Anthropic TypeScript SDK 0.115.0](https://github.com/anthropics/anthropic-sdk-typescript/releases/tag/sdk-v0.115.0)

Comportamentos observados em sessão não foram usados como substitutos de
contrato de API.

### 4.2 Identidade e limites

- ID fixo e sem data: `claude-opus-5`;
- janela de contexto de entrada: 1 milhão de tokens;
- saída síncrona máxima: 128 mil tokens;
- thinking ativado por padrão;
- thinking adaptativo explícito continua válido;
- escala nativa de effort: `low`, `medium`, `high`, `xhigh` e `max`;
- effort padrão: `high`;
- a documentação exemplifica `max_tokens=64000` para `xhigh` ou `max`.

O orçamento de saída Claude já mantido pelo cross-review, 64.000 tokens, é
compatível com a recomendação oficial e fica abaixo do teto síncrono.

### 4.3 Request wire

Para Opus 5, o request preparado usa:

```json
{
  "model": "claude-opus-5",
  "max_tokens": 64000,
  "thinking": {
    "type": "adaptive",
    "display": "omitted"
  },
  "output_config": {
    "effort": "max"
  }
}
```

O adaptador não envia:

- `thinking={type:"enabled",budget_tokens:...}`;
- `temperature`;
- `top_p`;
- `top_k`.

Isso evita combinar Opus 5 com formas de thinking manual e amostragem
não-default que a família nova não aceita. `thinking=disabled` não é utilizado
com `xhigh` ou `max`, combinação que resulta em erro HTTP 400.

### 4.4 Recusas

Fable 5 e Opus 5 podem retornar uma recusa como resposta HTTP 200 com
`stop_reason="refusal"`. O runtime:

- descarta conteúdo parcial da recusa;
- registra `provider_refusal` como falha não ignorável;
- trata a recusa anterior a qualquer output como não faturada;
- preserva a contabilização de input e output quando a recusa ocorre no meio da
  geração.

As mensagens e a classificação deixaram de ser específicas a Fable para cobrir
ambos os modelos sem inferir downgrade automático.

### 4.5 Cache e custos

Valores oficiais por milhão de tokens:

| Item Opus 5                |   US$ |
| -------------------------- | ----: |
| Input                      |  5,00 |
| Output                     | 25,00 |
| Cache read                 |  0,50 |
| Cache write, TTL 5 minutos |  6,25 |
| Cache write, TTL 1 hora    | 10,00 |

O mínimo documentado do prefixo cacheável é 512 tokens. O adaptador agora usa
limite por modelo:

- Fable 5: 512 tokens;
- Opus 5: 512 tokens;
- Opus 4.8: 1.024 tokens;
- modelo Anthropic desconhecido: fallback conservador de 4.096 tokens.

A configuração central adicionada para o override Opus 5 usa o TTL de uma hora,
portanto `cache_write_per_million=10`. Fable 5 continua ativo com seus custos
próprios.

### 4.6 Restrições de produto

Segundo a documentação oficial considerada:

- Opus 5 não oferece Priority Tier;
- Opus 5 não oferece web fetch.

O cross-review não tenta habilitar essas capacidades para o modelo.

### 4.7 Decisão de integração

`claude-opus-5` foi adicionado à lista de overrides Anthropic suportados, sem
alterar a prioridade canônica:

- ativo por padrão: `claude-fable-5`;
- override futuro permitido: `claude-opus-5`;
- compatibilidade preservada: `claude-opus-4-8`;
- fallbacks automáticos: nenhum.

O SDK `@anthropic-ai/sdk` foi elevado de `^0.114.0` para `^0.115.0`, versão que
inclui suporte a Opus 5 e correção de limpeza de listener de abort.

## 5. Bugs comprovados e correções preparadas para 4.5.28

### 5.1 P1 — sessão interrompida permanecia falsamente `running`

#### Evidência

Na sessão `fef6f09e-8991-4950-93f2-f6d643e3ac0e`, criada pela 4.5.26, round 8:

- o sweep removeu corretamente `in_flight`;
- custos exatos de Gemini e Grok foram preservados;
- três chamadas interrompidas sem resultado permaneceram
  `unknown/unpriced`;
- `convergence_health`, `control` e o job `a836...` permaneceram `running`;
- o PID 328 já não representava o processo original.

A sessão `6f51a9d6-34b0-4b77-a636-cea82c4401fa`, 4.5.25, apresentava a mesma
classe com uma geração Grok órfã. Nesse caso, o PID persistido havia sido
reutilizado por outro processo, de modo que uma verificação baseada apenas em
existência do PID produzia falso positivo de liveness.

#### Causa

`clearStaleInFlight()` reconciliava `in_flight` e contabilização, mas não
transicionava de forma coerente:

- controle;
- saúde de convergência;
- job em background;
- evento de recuperação;
- relatório durável.

`recoverInterruptedSessions()` continha parte da transição correta, mas dependia
de uma ferramenta operator-only e não era executado automaticamente no startup.
A verificação de processo não comparava a data de início do processo com a data
persistida no marker.

#### Correção 4.5.28

- recuperação completa no startup antes do sweep de fallback;
- comparação do início do processo com o marker para detectar PID reciclado;
- transição de `control` para `recovered_after_restart`;
- job órfão para `failed` ou `cancelled`, conforme o estado anterior;
- saúde convergente atualizada para estado stale/recuperado;
- preservação da contabilização conhecida e do estado `unknown` para chamadas
  interrompidas sem resultado;
- evento e relatório regenerados.

### 5.2 P1 — job durável permanecia `running` após sessão terminal

#### Evidência

A sessão `1ce5e743-e3d6-4d0d-a2c1-276bc84aad85` terminou `aborted`, mas o job
`2dab...` continuou persistido como `running`.

#### Causa

`reconcileObservedJobs()` não encerrava um job órfão quando:

- `session.outcome` já era terminal;
- não havia execução durável local correspondente;
- não havia controle ativo que justificasse o estado.

#### Correção 4.5.28

O reconciliador agora encerra job órfão de sessão terminal ou sem execução
durável, preservando jobs locais realmente ativos e execuções pendentes válidas.

### 5.3 P1 operacional/P2 segurança — amplificação ilimitada do Evidence Broker

#### Evidência

Na sessão `1ce5e743-e3d6-4d0d-a2c1-276bc84aad85`:

- foram acumulados 142 itens de checklist;
- 116 terminaram `not_resurfaced`;
- `meta.json` atingiu aproximadamente 619,5 KiB;
- a sessão consumiu 889.187 tokens;
- o custo foi US$ 5,39668585;
- todos os itens não resolvidos voltavam a ser injetados nos prompts
  subsequentes.

O runtime não impunha limite:

- por peer e round;
- global por round;
- por sessão;
- por caracteres persistidos.

Um peer hostil, defeituoso ou apenas excessivamente prolixo podia causar
denial-of-wallet sem precisar comprometer um provedor ou o host.

#### Correção 4.5.28

Foram introduzidos limites configuráveis:

| Limite                   | Default |
| ------------------------ | ------: |
| Pedidos por peer/round   |       8 |
| Pedidos totais por round |      24 |
| Itens por sessão         |      64 |
| Caracteres por sessão    |  64.000 |

O contrato é fail-closed:

- duplicatas exatas do mesmo owner são deduplicadas;
- a admissão é atômica;
- excesso não causa truncamento silencioso;
- nenhum blocker é auto-satisfeito;
- nenhum lote parcial é anexado;
- a resposta completa dos peers permanece no round para auditoria;
- checklist legado já excessivo é interrompido antes de novo dispatch pago;
- excesso criado no round interrompe a sessão antes de juiz automático ou round
  adicional;
- evento `session.evidence_checklist_circuit_breaker_tripped` registra fase,
  limites, chamadas já iniciadas e ausência de mutação parcial;
- outcome formal: `evidence_checklist_contract_violation`.

### 5.4 P2 — condição futura interpretada como alegação de estado corrente

#### Evidência

A sessão `108bece7-74d6-47b5-b5b0-44efab05cd5a` foi abortada antes do primeiro
round por causa do texto:

> After merge and exact-head green CI, retry...

O texto descreve pré-requisitos futuros, não afirma que merge e CI verde já
ocorreram.

#### Causa

O detector de estado operacional encontrava termos como `CI` e `green` antes de
avaliar se pertenciam a uma condição temporal que antecedia uma instrução.

#### Correção 4.5.28

O detector remove apenas um preâmbulo temporal inicial para classificar a
oração principal:

- `After merge and exact-head green CI, retry...` permanece instrução futura;
- `After the merge completed, CI is green.` continua sendo alegação assertiva e
  falha sem evidência.

A correção reduz falso positivo sem relaxar a proteção sobre alegações reais de
runtime.

### 5.5 P2 — IDs de checklist do servidor classificados como fabricados

#### Evidência

No replay do round 6 da sessão
`fef6f09e-8991-4950-93f2-f6d643e3ac0e`, sete IDs hexadecimais referenciados
pelos peers eram IDs de `Checklist-Item` emitidos pelo próprio servidor. Mesmo
assim, a detecção encontrou sete novos tokens hexadecimais e marcou
`fabricated=true`.

#### Causa

O corpus de proveniência continha anexos e texto de evidência, mas não continha
os IDs de checklist que o servidor havia inserido no prompt.

#### Correção 4.5.28

Os IDs efetivamente emitidos na sessão passam a integrar o corpus de
proveniência. A regra continua conservadora:

- ID conhecido do servidor não é fabricação;
- ID semelhante, porém não emitido pelo servidor, continua sujeito à detecção e
  ao rebaixamento.

### 5.6 P2 — diagnóstico agregado de grounding escondia a alegação que falhou

#### Evidência

No round 1 da sessão `fef6f09e-8991-4950-93f2-f6d643e3ac0e`, Gemini foi
transformado de raw `READY` para `NEEDS_EVIDENCE`, embora:

- 5/5 fontes tivessem `supported=true`;
- custody e attachment estivessem correlacionados;
- `fabricated=false`;
- o único predicado agregado falho fosse
  `peer_submitted_evidence_corroborated`.

A regra verificava alegações de alto risco contra dois corpora distintos, mas o
resultado não indicava qual alegação falhara em qual corpus.

#### Correção 4.5.28

`failed_claim_diagnostics` agora persiste:

- corpus: `caller_evidence` ou `peer_sources`;
- tipo da alegação;
- índice;
- excerpt limitado.

Os detalhes de fabricação completos também são preservados na transformação de
status. A correção aumenta auditabilidade sem converter fonte inválida em
evidência válida.

### 5.7 P3 operacional — `session_events` sem página útil e com ruído de deltas

#### Evidência

Nos 11 logs recentes, 2.354 de 3.983 eventos, ou 59,1%, eram
`peer.token.delta`. Como os eventos eram devolvidos em conjunto, consultas de
acompanhamento podiam produzir payloads grandes e truncados.

#### Melhoria 4.5.28

`session_events` passa a oferecer:

- `limit` padrão 200;
- `limit` máximo 1.000;
- `include_token_deltas=false` por padrão;
- `next_seq`;
- `has_more`;
- `filtered_token_delta_count`.

O operador ainda pode optar pela telemetria granular para investigação de
streaming, mas o caminho normal fica limitado e incremental.

## 6. Segurança e mecanismos anti-enganação

### 6.1 Controles cuja operação foi confirmada

No corpus auditado:

- 45 escopos de convergência foram examinados sem violação de
  anti-self-review;
- nenhum relator `non-voting` apareceu entre os voters;
- 274 respostas de peers apresentaram zero `model_match=false`;
- 145 verificações de caller observadas nos logs foram token-verified;
- uma tentativa de Claude declarar-se `operator` foi bloqueada;
- duas chamadas operator-only feitas por Codex foram bloqueadas;
- não foi encontrado padrão de chave Anthropic, OpenAI, Google, xAI,
  DeepSeek, Perplexity ou GitHub, Bearer token ou PEM;
- streaming estava com `include_text=false`, persistindo contagem e não o
  conteúdo dos deltas.

A busca negativa por padrões de segredo reduz a probabilidade de vazamento no
corpus, mas não constitui prova matemática de ausência de qualquer segredo
possível.

### 6.2 Grounding conservador deve permanecer

O comportamento all-or-nothing de citações é deliberadamente conservador. No
round 7 de `fef6...`, Gemini apresentou 2/3 fontes válidas e Grok 9/10, mas os
votos completos foram rebaixados. Isso cria atrito, porém impedir que uma
alegação decisiva se apoie no único item inválido é parte da garantia
anti-enganação.

Uma futura correção delta pode preservar itens válidos e pedir reparo somente do
índice inválido, mas não deve:

- aceitar um voto definitivo com blocker decisivo sem grounding;
- transformar ausência de correlação em mera advertência;
- auto-satisfazer checklist;
- permitir que uma citação válida encubra outra alegação independente e
  inválida.

### 6.3 Caller tokens: mitigação aplicada

`host-tokens.json` contém sete capabilities em claro: seis peers e operador.
No worktree 4.5.28, o runtime falha fechado se não puder proteger o arquivo:

- POSIX: modo `0600` verificado;
- Windows: herança NTFS removida e DACL limitada ao usuário atual, SYSTEM e
  Administrators.
- arquivos existentes são abertos uma única vez, endurecidos e lidos pelo
  mesmo descritor; a migração de schema também escreve pelo descritor, após
  verificar que ele ainda corresponde ao path. Em POSIX, a abertura usa
  `O_NOFOLLOW`.

A ACL do arquivo local efetivamente usado durante a análise foi ajustada para
esse conjunto, removendo acesso herdado de grupos de sandbox.

### 6.4 Caller tokens: risco residual

A mitigação de ACL não separa processos irrestritos executados sob o mesmo SID.
Se o threat model inclui um host de modelo potencialmente enganoso com acesso
irrestrito ao filesystem do usuário, esse processo ainda pode ler o mapa de
tokens em claro.

Correção arquitetural recomendada:

1. persistir somente hash/verifier de cada capability no servidor;
2. fornecer a cada host apenas seu próprio token bruto por secret/env;
3. manter o token de operador em vault ou identidade de sistema operacional
   separada;
4. rotacionar todos os tokens atuais durante a migração;
5. nunca registrar token bruto, inclusive em erro ou telemetria.

## 7. Hipóteses descartadas ou reclassificadas

### 7.1 `not_resurfaced` em `fef6...`

Esse caso não prova falso fechamento nem reabertura indevida:

- os itens eram de Perplexity;
- as fontes declaravam custody de um attachment;
- as longas quotes de código não existiam nesse attachment;
- citações de Gemini ou Grok não podiam fechar automaticamente itens de outro
  owner.

O relato externo de “cinco peers READY com citações válidas e itens
not_resurfaced” continua merecendo replay, mas exige o ID exato da sessão
relatada. Não deve ser atribuído a `fef6...`.

### 7.2 Contabilização

Não foi encontrado bug contábil:

- `fef6...`: US$ 3,475978295 sem dupla contabilização;
- `1ce5...`: US$ 5,39668585;
- chamadas interrompidas sem confirmação permanecem `unknown/unpriced`, não
  custo zero inventado.

### 7.3 Finalizações de provider

`finish_reason=length` do DeepSeek e timeouts Perplexity são non-retryable pela
política atual documentada do projeto. Podem justificar evolução de produto,
mas o corpus não provou violação do contrato de provider.

### 7.4 Problemas anteriores de polling

As classes anteriormente relatadas sobre:

- `session_poll` excessivamente detalhado;
- Markdown solicitado mas resposta serializada como JSON;
- cancelamento perdendo corrida com job já concluído;

já estavam corrigidas na fonte atual. Não foram reclassificadas como regressões
4.5.23–4.5.27 nesta auditoria.

## 8. Configuração central e custos

### 8.1 Estado desejado

A configuração central deve manter:

```json
{
  "models": {
    "claude": "claude-fable-5"
  },
  "model_fallbacks": null,
  "model_cost_rates": {
    "claude": {
      "claude-opus-5": {
        "input_per_million": 5,
        "output_per_million": 25,
        "cache_read_per_million": 0.5,
        "cache_write_per_million": 10
      }
    }
  }
}
```

Assim, Fable 5 permanece ativo e Opus 5 fica pronto para seleção explícita
futura, sem fallback silencioso.

### 8.2 Chaves novas do Evidence Broker

O schema 4.5.28 aceita:

```json
{
  "evidence_broker": {
    "max_requests_per_peer_round": 8,
    "max_requests_per_round": 24,
    "max_items_per_session": 64,
    "max_chars_per_session": 64000
  }
}
```

Na ausência dessas chaves, os mesmos valores são defaults do runtime. As quatro
chaves foram incluídas explicitamente na configuração central e o arquivo foi
aceito pelo schema 4.5.28, tornando a política visível no snapshot.

### 8.3 Streaming

A configuração central foi alterada de 4.096 para 16.384 caracteres, mantendo
1.000 ms e `include_text=false`. A mudança foi aceita pelo schema 4.5.28. A
paginação de `session_events` reduz adicionalmente o impacto no caminho de
leitura.

### 8.4 Reload

O runtime carregado durante a auditoria é 4.5.27. O rate card Opus 5 já foi
adicionado à configuração central no disco, mas qualquer diferença de hash
entre arquivo e processo exige reload da janela para que `server_info` prove a
aplicação. A publicação 4.5.29 e o reload não fazem parte da evidência desta
etapa.

## 9. Matriz de validação

| Área                 | Validação                                                | Estado                                         |
| -------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| Opus 5               | seleção como override explícito                          | PASS                                           |
| Opus 5               | wire com adaptive thinking, effort e 64K                 | PASS                                           |
| Opus 5               | ausência de sampling não suportado                       | PASS                                           |
| Opus 5               | cache mínimo e recusa não faturada pré-output            | PASS                                           |
| SDK Anthropic        | lockfile resolve 0.115.0                                 | PASS                                           |
| Lifecycle            | regressão durável específica                             | PASS 28/28                                     |
| Lifecycle            | validação integrada após todas as mudanças concorrentes  | PASS                                           |
| Truthfulness         | condição futura versus alegação assertiva                | PASS                                           |
| Truthfulness         | validação integrada após mudanças concorrentes           | PASS                                           |
| Checklist IDs        | IDs conhecidos confiáveis e desconhecidos bloqueados     | PASS                                           |
| Grounding            | diagnóstico final nos dois corpora                       | PASS 7/7                                       |
| Evidence Broker      | regressão de amplificação, atomicidade e circuit breaker | PASS                                           |
| `session_events`     | paginação, filtro e opt-in forense                       | PASS                                           |
| Caller tokens        | geração temporária e hardening                           | PASS                                           |
| Caller tokens        | DACL exata e fluxo sem TOCTOU por pathname               | PASS                                           |
| Supply chain         | `brace-expansion` 5.0.8 e `npm audit`                    | PASS, zero vulnerabilidades                    |
| Qualidade            | formatter, lint, Biome e TypeScript                      | PASS                                           |
| Suite integrada      | cobertura completa dos targets do `npm test`             | PASS por execução única e continuação dirigida |
| Smoke final          | `npm run smoke` no worktree final                        | PASS                                           |
| Runtime empacotado   | `npm run runtime-smoke`                                  | PASS                                           |
| Consumidor externo   | `npm run test:consumer`                                  | PASS                                           |
| Revisão independente | auditoria de diff e raciocínio Ultrabrain                | Concluída; dois achados corrigidos             |
| GitHub Actions       | todos os workflows no SHA de release                     | Pendente nesta etapa                           |
| npm                  | pacote 4.5.29 publicado e íntegro                        | Pendente nesta etapa                           |
| Runtime instalado    | `server_info` 4.5.29, hashes iguais e reload false       | Depende de instalação/reload pelo operador     |

A primeira execução integrada foi interrompida por metadados anti-drift
desatualizados em documentação e no próprio smoke, não por novos defeitos de
produto. Em vez de reiniciar a suíte a cada ocorrência, a execução continuou
pelos targets ainda não cobertos. Depois das correções, o smoke completo, o
runtime empacotado e o consumidor externo foram executados no estado final e
fecharam com código zero.

A auditoria independente do diff encontrou dois problemas antes do fechamento:
`VERSION` ainda em 4.5.27 e uma DACL Windows que não removia ACEs explícitas
preexistentes. Ambos foram corrigidos e cobertos pela validação final.

Os gates externos acrescentaram dois achados posteriores: CodeQL detectou o
fluxo TOCTOU por pathname no carregamento de caller tokens, e o Scorecard
detectou a GHSA-mh99-v99m-4gvg, divulgada durante o release. O primeiro foi
convertido para leitura/migração por descritor; o segundo foi corrigido com
`brace-expansion` 5.0.8 e bump para 4.5.29. Nenhum alerta foi suprimido.

## 10. Plano de ação priorizado

### P0 — fechar a 4.5.29

1. formatar somente os arquivos alterados;
2. executar uma vez o gate de qualidade;
3. executar uma vez a suíte integral;
4. corrigir apenas falha concreta, com teste direcionado, sem reiniciar ciclos
   integrais;
5. submeter o SHA final ao hardgate independente;
6. commit e sync direto em `main`;
7. acompanhar todos os GitHub Actions até verde;
8. publicar `@lcv-ideas-software/cross-review@4.5.29`;
9. após instalação global pelo operador e reload, confirmar via `server_info`:
   versão, data de processo, hashes, `config_load.applied=true`,
   `parse_error=null` e `reload_required=false`.

### P1 — eliminar o risco de capabilities em claro

Projetar e migrar para verifiers persistidos, segredos por host e operador
separado. A migração deve incluir rotação e compatibilidade controlada, sem
registrar os tokens antigos.

### P2 — replay do relato externo `not_resurfaced`

Obter o ID exato da sessão, reproduzir:

- owner de cada item;
- quotes e attachment efetivamente citados;
- transições `open`, `resurfaced`, `addressed` e `not_resurfaced`;
- status raw e normalized dos cinco peers.

Só então decidir se há nova correção no broker.

### P2 — correção delta de citação

Avaliar um protocolo de reparo por índice que preserve itens válidos e solicite
correção apenas do item inválido, mantendo fail-closed para toda alegação
decisiva não fundamentada.

### P2 — política de retry de terminação incompleta

Reavaliar, contra a documentação oficial de cada provider:

- `response.incomplete`;
- `finish_reason=length`;
- timeouts;
- limite de tentativas e orçamento.

A política não deve repetir chamadas caras sem teto nem reclassificar output
truncado como decisão definitiva.

### P3 — acompanhar a redução de ruído de streaming

- manter o threshold central aplicado em 16.384 caracteres;
- manter `include_text=false`;
- persistir thresholds efetivos no snapshot;
- monitorar percentual de `peer.token.delta` após a 4.5.29.

### P3 — evento terminal canônico

Emitir uma disposição terminal única para cada `round.started`, ainda que
eventos especializados continuem existindo. Isso simplifica analytics e
detecção de rounds interrompidos.

## 11. Conclusão

A auditoria demonstrou defeitos reais no intervalo publicado 4.5.23–4.5.27,
com reproduções concretas em sessões 4.5.25 e 4.5.26; o corpus local não contém
sessões 4.5.24 ou 4.5.27. Os problemas mais graves não foram rejeições de código
pelos peers, mas falhas de lifecycle e amplificação de evidência capazes de
manter estado incorreto e consumir orçamento.

O conjunto preparado em 4.5.28 e finalizado em 4.5.29 aborda as causas
comprovadas sem relaxar as garantias
anti-enganação:

- não aceita blockers sem grounding;
- não transforma IDs desconhecidos em proveniência;
- não trunca checklist excedente silenciosamente;
- não inventa custo zero para chamada interrompida;
- não permite fallback de modelo implícito;
- não confunde uma instrução futura com estado operacional atual.

Claude Opus 5 está preparado como opção explícita, com wire, esforço, recusa,
cache, SDK e custos alinhados à documentação oficial. Fable 5 permanece o
modelo ativo.

A entrega só pode ser considerada concluída depois da validação integrada
única, hardgate independente, GitHub Actions verdes, publicação npm e prova do
runtime 4.5.29 após reload. O risco de mesmo SID sobre caller tokens permanece
explicitamente aberto como correção arquitetural prioritária, não mascarado
pela melhoria de ACL.
