# Auditoria forense e contratual do cross-review 4.5.5

Data: 2026-07-12
Escopo: runtime 4.5.5, seis APIs de IA, sessões e logs das 36 horas anteriores,
configuração central, custos, mecanismos anti-fabricação e preparação da
correção final 4.5.7 (contratos introduzidos no source 4.5.6).

## Resumo executivo

O runtime carregado foi confirmado como 4.5.5. A configuração central foi
aplicada integralmente, sem override de modelos, effort ou preços por variáveis
de ambiente. A investigação encontrou defeitos reais no cross-review; eles não
eram rejeições de mérito das aplicações submetidas.

As causas principais foram:

1. um único JSON Schema canônico era transmitido a APIs com subconjuntos
   documentados diferentes;
2. a correlação literal de citações não tratava uma camada de escape JSON nem a
   imagem lógica posterior de um diff;
3. referências a arquivos embutidos em evidência composta perdiam custódia
   entre rodadas;
4. nomes de modelos do produto revisado podiam ser confundidos com pins do
   runtime;
5. `response.incomplete` da OpenAI não tinha recuperação controlada;
6. terminais de filtragem podiam entrar indevidamente na recuperação de
   moderação de entrada;
7. o effort configurado para Gemini era emitido pela configuração de arquivo,
   mas nunca lido pelo runtime;
8. sessões terminalizadas pelo job podiam conservar `control=running`;
9. parte da configuração de preços misturava regimes ou modelos diferentes;
10. fallbacks eram contabilizados pelo pin primário, não pelo modelo efetivo;
11. parciais de streaming de uma tentativa falha podiam permanecer visíveis
    sem identificador de tentativa ou descarte transacional;
12. matching dito literal normalizava case/whitespace e um marcador `-` podia
    fazer código removido reaparecer como evidência;
13. uma garantia genérica repetida do draft podia fundamentar o próprio READY;
14. rate cards de fallback, prefixos sobrepostos e o call graph de retries não
    eram preflightados conservadoramente;
15. terminais rejeitados descartavam usage/custo, e os eventos/recusas oficiais
    da Responses API eram achatados em erro genérico ou format recovery;
16. `server_info` afirmava falsamente que não havia workflow CodeQL avançado.

A correção mantém o contrato completo localmente e transmite a cada API apenas
o subconjunto oficialmente documentado. Nenhuma chamada paga foi feita durante
esta auditoria ou seus testes.

## Método e regra de evidência

Para cada provedor, apenas documentação oficial e SDK oficial instalado foram
aceitos como contrato. Sessões reais foram usadas como evidência empírica de
falhas, nunca como substituto da documentação. Quando a documentação não
enumera uma keyword JSON Schema, o wire schema foi reduzido ao subconjunto
publicado e o contrato completo continuou imposto por prompt, normalização e
Zod local.

Foram usados:

- SDKs instalados: `openai@6.46.0`, `@anthropic-ai/sdk@0.111.0` e
  `@google/genai@2.11.0`;
- artefatos persistidos de sessões, attachments e eventos NDJSON;
- `server_info` em runtime;
- testes offline que interceptam o corpo final de cada adapter;
- documentação oficial listada na seção de referências.

## Estado de runtime e configuração

O `server_info` consultado em 2026-07-12 confirmou:

| Campo                       | Valor                                                              |
| --------------------------- | ------------------------------------------------------------------ |
| Versão carregada            | `4.5.5`                                                            |
| Config efetiva              | `C:\Users\leona\.cross-review\data\config.json`                    |
| SHA-256 carregado           | `87f809f2bd9cba20147c707d3a33be0745907889d0e9a3968c8a3090db1a9c0b` |
| Campos aplicados            | `70`                                                               |
| Campos sobrescritos por env | `0`                                                                |
| Reload necessário           | `false`                                                            |
| Output global               | `20000`                                                            |

Pins ativos:

| Peer       | Modelo                   |
| ---------- | ------------------------ |
| Codex      | `gpt-5.6-sol`            |
| Claude     | `claude-fable-5`         |
| Gemini     | `gemini-3.1-pro-preview` |
| DeepSeek   | `deepseek-v4-pro`        |
| Grok       | `grok-4.5`               |
| Perplexity | `sonar-reasoning-pro`    |

O mapa de effort do 4.5.5 omitia Gemini, apesar de o arquivo central já aceitar
`reasoning_effort.gemini`. Não era uma janela stale: o transporte
arquivo → env existia, mas `loadConfig()` não lia a variável e o adapter fixava
`ThinkingLevel.HIGH`.

## Auditoria das últimas 36 horas

Janela forense aproximada: desde `2026-07-11T02:48:41Z`.

### Inventário

- 51 diretórios de sessão tocados;
- 44 sessões criadas na janela;
- 7 sessões 4.4.8 antigas apenas alcançadas por sweep;
- versões novas: 4.5.0 = 28, 4.5.2 = 6, 4.5.3 = 5, 4.5.5 = 5;
- resultados das sessões novas: 10 abertas, 24 abortadas, 9 max-rounds e 1
  convergida;
- 11 arquivos de log, 4.266 registros NDJSON e zero erro de parse;
- 18 attachments, todos existentes e com SHA-256 correto;
- zero gaps ou duplicações de sequência de evento;
- zero sessão atualmente corrompida.

### Achados 4.5.5

- Anthropic rejeitou o wire schema nas sessões
  `30998abe-b4fa-46c7-8f36-6c97791e2af3` e
  `61ce42d5-0dc0-48e3-a6d0-48aabb4dc9ec` com `maxItems` não suportado. O identificador
  `4fe60040-d2b0-4950-ae6e-24751ca1b534` citado no campo era o job, não o
  session ID.
- Houve oito demissões de `raw READY`. Em 76 fontes, 35 casavam diretamente,
  24 adicionais casavam após exatamente uma camada de desescape JSON, 9 após
  reconstrução segura da imagem posterior do diff e 8 eram realmente não
  correlacionadas. Seis dos oito votos não continham fonte genuinamente falsa.
- A sessão `04691dd6-a3fc-4795-895e-8184425d6899` demonstrou falso positivo de namespace de modelo: um
  modelo Gemini da aplicação revisada foi comparado ao pin do peer do runtime.
- A sessão `0e311ee7-667b-4f6d-b205-ba308cf44f37` demonstrou perda de custódia de arquivos explicitamente
  delimitados por `BEGIN FILE`/`END FILE` dentro de uma evidência composta.
- Exatamente três sessões terminais 4.5.5 conservaram controle `running`:
  `04691dd6-a3fc-4795-895e-8184425d6899`,
  `0e311ee7-667b-4f6d-b205-ba308cf44f37` e
  `61ce42d5-0dc0-48e3-a6d0-48aabb4dc9ec`. A causa era determinística: o outcome era
  selado antes de limpar o controle; a limpeza posterior corretamente recusava
  mutação pós-terminal.
- A sessão preservada `741b69bc-cc03-40a8-9899-1199fb834e85` permanece caso de
  teste: 13 de 15 fontes do Grok eram byte a byte válidas, mas o voto era
  rebaixado por escape de aspas e política all-or-nothing.
- Um `response.incomplete` OpenAI ficou 351,5 segundos e foi persistido como
  tentativa não precificada, embora o Response oficial carregasse usage.

Não foram encontrados attachments adulterados, gaps de eventos ou corrupção
de sessão que explicassem esses resultados.

## Matriz oficial de Structured Outputs

| Provedor   | Contrato oficial aplicado                                                                          | Resultado da auditoria                                                      |
| ---------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| OpenAI     | Responses Structured Outputs estrito; `maxItems` e `maxLength` suportados no modelo não fine-tuned | schema canônico completo preservado                                         |
| Anthropic  | Structured Outputs com subconjunto próprio e lowering pelo helper oficial                          | helper oficial remove constraints incompatíveis; validação local preservada |
| Gemini     | lista fechada inclui `maxItems`, não `maxLength`                                                   | `maxLength` removido do wire                                                |
| DeepSeek   | JSON Object mode, sem schema de resposta completo                                                  | `json_object` + prompt + Zod local preservados                              |
| xAI        | JSON Schema; `maxItems` garantido até 256 e `maxLength` até 2.048                                  | evidência limitada a 2.048 no wire; limite local continua 2.500             |
| Perplexity | wrapper Sonar `json_schema`, sem matriz fechada de constraints dimensionais                        | wrapper estrutural mínimo; limites locais preservados                       |

Também foram removidos campos não cobertos pelo contrato mínimo oficial:
`text.verbosity` do wire xAI, `name` e `stream_options.include_usage` do wire
Sonar.

## Recuperação de output e safety

A recuperação automática só é permitida quando o terminal oficial identifica
inequivocamente limite de output:

- Anthropic `stop_reason=max_tokens`;
- OpenAI `response.incomplete` + `reason=max_output_tokens`;
- Gemini `finishReason=MAX_TOKENS`.

Cada caminho elegível faz no máximo uma nova chamada, no mesmo modelo, prompt e
teto, com effort/thinking médio. Em Claude Fable 5 a recuperação só ocorre se o
effort original era `high`, `xhigh` ou `max`; `low`/`medium` encerram sem retry,
pois medium não reduziria esforço. Usage e custo são calculados por tentativa e
depois somados; isso evita cruzar artificialmente tiers de 200K/272K. Uma
segunda truncagem encerra o fluxo.

Não foi inferido retry para:

- DeepSeek `length`, que pode representar output ou janela de contexto;
- xAI incomplete, cuja documentação não enumera o motivo;
- Perplexity, cuja documentação não enumera os finish reasons relevantes.

Terminais `content_filter`, `Candidate.finishReason=SAFETY` e equivalentes agora
são reconhecidos estruturalmente como saída filtrada e nunca entram em retry,
fallback ou na recuperação de contexto reduzido. Em contraste,
`promptFeedback.blockReason` é o sinal oficial de bloqueio do prompt de entrada
do Gemini e pode disparar exatamente uma nova tentativa com prompt compacto,
sujeita ao hardgate de orçamento.

Mesmo um terminal rejeitado pode ser cobrado. Usage e custo do modelo efetivo
agora são anexados antes do throw e acumulados entre tentativas. DeepSeek drena
o chunk final oficial `choices: []` com usage antes de rejeitar `length`;
Todo `response.error` non-stream não nulo é preservado antes da validação do
status (inclusive envelope xAI `incomplete`), SSE `type=error` lê os campos
top-level, e recusas `output[].content[].type=refusal` ou
`response.refusal.delta/done` nunca entram em format recovery.

O terminal DeepSeek documentado `insufficient_system_resource` é a exceção
transiente explícita: a inferência interrompida descarta texto parcial, preserva
billing e usa apenas o envelope de retry já limitado. `length` e
`content_filter` continuam terminais. A auditoria de corrida do ledger também
fechou três janelas: dupla soma após settle+cancel, perda da tentativa anterior
antes do próximo dispatch e falso `billing_status=reported` quando ainda há
tentativa não precificada.

O preflight diferencia atribuição, não mera presença de tokens. Formatos
canônicos `server_info`, `runtime_capabilities`, `runtime_version` e
`model_pin` são atuais por natureza; negações como “not 4.5.6; is 4.5.5” são
rejeitadas, mas uma versão npm ou de aplicação com sujeito próprio não é
comparada ao runtime do cross-review.

## Auditoria dos mecanismos anti-mentira e anti-preguiça

Os mecanismos fundamentais permanecem apropriados:

1. READY exige status canônico, evidência concreta e ausência de requests ou
   follow-ups.
2. Cada fonte que alega custódia de attachment exige path/label, SHA-256
   completo e literal correspondente no mesmo attachment. Uma citação direta
   do próprio artefato pode usar a via non-custody, mas precisa ser literal e
   concreta; uma garantia genérica copiada do draft não prova o próprio READY.
3. A política all-or-nothing do voto foi mantida. A correção não aceita maioria
   de fontes; apenas passou a comparar representações logicamente equivalentes.
4. O desescape é limitado a uma camada controlada (`\n`, `\r`, `\t`, `\"`,
   `\\`), nunca recursivo. Escapes desconhecidos são rejeitados; após essa
   desserialização controlada, case e whitespace permanecem literais.
5. Diffs são reconstruídos apenas dentro de hunks: adições e contexto formam a
   imagem posterior; remoções não podem provar o estado atual, inclusive se a
   citação repetir o marcador `-`. Metadados e logs fora de hunks continuam
   citáveis.
6. `BEGIN FILE`/`END FILE` só concede custódia de submissão quando o par de
   caminhos coincide e o corpo não é vazio; não promove evidência do caller a
   autoridade de operador.
7. Model pins só são comparados quando a frase atribui o valor ao runtime/server
   do cross-review, MCP, `server_info`, `runtime_capabilities` ou `model_pin`.
   Mera coocorrência em “cross-review submission/session” não transfere modelos,
   versões ou datas da aplicação ao namespace do servidor.
8. Filtros de saída não são reinterpretados como rejeição do prompt para obter
   uma segunda tentativa.
9. Sessões terminais continuam imutáveis e agora limpam atomicamente o controle
   normal antes de selar o outcome.
10. Deltas de streaming são provisórios e vinculados à tentativa; falha cancela
    o timer e emite descarte, e somente o terminal saudável confirma o texto.
11. Uma garantia narrativa genérica copiada do draft não é evidência
    independente de correção ou testes.

Essas mudanças reduzem falso positivo sem enfraquecer o bloqueio de citação
fabricada, auto-revisão, autoridade forjada ou READY preguiçoso.

## Auditoria financeira

Os preços base ativos conferiam com as páginas oficiais. Foram encontrados
três erros semânticos na forma dos cards:

1. Grok 4.5 continha um tier local >200K 4/12/1 não publicado oficialmente;
2. Gemini continha `cache_write=2/4`, mas o adapter usa cache implícito e o
   storage explícito é precificado por token-hora;
3. o card ativo de Sonar Reasoning Pro continha dimensões exclusivas de Sonar
   Deep Research.

O engine agora resolve o modelo efetivamente enviado por cada adapter/fallback;
um override sem card aplicável falha fechado em vez de herdar o preço do pin
primário. Citation/reasoning/search-query só se aplicam quando esse modelo é
`sonar-deep-research`. Gemini soma thinking ao output faturável, sem dobrar o
sub-bucket de telemetria. `mergeUsage` preserva as dimensões Sonar entre
tentativas; `mergeCost` preserva input/output e só mantém um `tier_used` quando
todas as tentativas compartilham o mesmo tier.

O loader e o resolver escolhem o prefixo de família mais específico. Sonar
regular exige a taxa de request do contexto ativo em primary e fallback. Deep
Research exige os três campos adicionais para contabilização, mas continua
fail-closed antes da chamada: a API não publica teto controlável para searches,
citation tokens ou reasoning tokens, logo nenhum estimate pode ser apresentado
honestamente como hardgate. O preflight dos demais modelos cobre todas as
tentativas do primary/fallback e o maior caminho de format/moderation recovery,
sem o antigo cap heurístico de quatro chamadas.

Recomendação de configuração 4.5.7:

- manter o fallback global em 20.000;
- Codex: 25.000;
- Claude: 64.000;
- Gemini, DeepSeek, Grok e Perplexity: 20.000;
- mover tarifas para `model_cost_rates`, de modo que um modelo desconhecido
  falhe fechado em vez de herdar o preço de outro modelo;
- manter `reasoning_effort.gemini=high` e
  `perplexity.probe_mode=auth_only` explícitos.
- manter `sonar-deep-research` fora de primary/fallback enquanto suas dimensões
  provider-controlled não tiverem teto oficial pre-dispatch.

## CI #307

O [CI #307](https://github.com/LCV-Ideas-Software/cross-review/actions/runs/29181944333)
no commit `f6ec468` falhou somente em Smoke tests. `SECURITY.md` havia trocado a
expressão contratual `Current supported source/release target` por `Current
supported release`, quebrando a asserção determinística `release_metadata`.
O commit seguinte `785f905` restaurou a forma neutra, e o
[CI #308](https://github.com/LCV-Ideas-Software/cross-review/actions/runs/29182158627)
passou integralmente. A falha já estava superada e não exigia nova correção.

A auditoria atual também alinhou `server_info.codeql_policy` e o baseline ao
workflow Advanced CodeQL realmente versionado (`actions` e
`javascript-typescript`, queries `security-extended`); o Default Setup remoto
está `not-configured`, evitando análise duplicada.

## Verificação offline

O novo contrato `v4.5.6-runtime-contract-regression` cobre 22 casos, incluindo:

- bodies finais dos seis adapters;
- schemas wire por provedor;
- config/reload de effort Gemini;
- budgets por peer e preflight;
- OpenAI e Gemini, streaming e não streaming;
- exatamente um retry e nenhum retry de safety;
- ledger após rede e cancelamento;
- custo Gemini com thinking;
- custos exclusivos de Deep Research;
- citações escapadas e post-image de diff;
- case/whitespace literal, marcador de remoção, envelope de status máximo e
  compatibilidade patch da configuração;
- arquivos embutidos, namespace de model pin, terminal control, prompt block
  Gemini e descarte transacional de streaming.

Também passaram os smokes históricos de provider terminal, provider refresh,
grounding, cancelamento, durable jobs, accounting, evidence custody,
truthfulness, smoke principal e runtime smoke. Nenhuma API paga foi chamada.

## Segurança de publicação npm 12 e GAT/2FA

O anúncio oficial de 8 de julho de 2026 foi incorporado como hardgate da
release. npm 12 tornou opt-in os scripts de instalação de dependências e a
resolução de dependências Git ou URLs remotas. GATs npm com bypass de 2FA
deixarão de contornar 2FA em operações sensíveis no início de agosto de 2026 e,
por volta de janeiro de 2027, deixarão de publicar diretamente.

O caminho npmjs do repositório já estava na arquitetura correta: GitHub-hosted
runner, environment `npm-production`, `id-token: write`, Trusted Publishing
OIDC e provenance. A versão 4.5.5 publicada foi consultada no registry e possui
`dist.attestations.provenance.predicateType = https://slsa.dev/provenance/v1`.
Não há `NPM_TOKEN`, GAT ou OTP no job npmjs; `GITHUB_TOKEN` serve somente ao
GitHub Packages e não pertence ao contrato npm GAT.

Foram corrigidas as lacunas residuais:

- o workflow de release fixa npm 12.0.1 antes de qualquer `npm ci`;
- todos os caches de package manager foram desativados;
- `STEPSECURITY_NPM_TOKEN` saiu do ambiente global e existe somente nos quatro
  passos de instalação;
- o tag solicitado precisa existir em `refs/tags/` e apontar para o `HEAD`
  efetivamente publicado;
- o arquivo npmrc temporário do GitHub Packages nasce com `umask 077` e modo
  `0600`;
- a verificação pós-publicação exige e consulta a atestação SLSA v1;
- `.npmrc` fixa `strict-allow-scripts=true`, `allow-git=none` e
  `allow-remote=none`;
- `package.json` permite somente os scripts revisados e pinados de
  `@google/genai@2.11.0`, `protobufjs@7.6.4`, `esbuild@0.28.1` e o opcional
  macOS `fsevents@2.3.3`. O comando oficial read-only passou de três pendências
  no Windows para zero; um upgrade desses artefatos volta a falhar até nova
  revisão.
- os comandos de upgrade fixam `@lcv-ideas-software:registry` explicitamente,
  pois `--registry` genérico não vence um registry persistido para o escopo;
  `npm upgrade` não recebe `@latest`, que o npm 12 rejeita com `EUPDATEARGS`;
- como `npm upgrade -g` avalia toda a árvore global e o lock local não governa
  a resolução transitiva do consumidor, aplicar uma allowlist estrita do
  projeto nesse comando falhou em `dry-run` por scripts pertencentes a outros
  pacotes globais. O fluxo portátil usa `--ignore-scripts`,
  `--allow-git=none` e `--allow-remote=none`: nenhum lifecycle de dependência é
  executado, e o pacote publicado não possui lifecycle de instalação próprio.

O relatório complementar recebido foi aproveitado onde confirmado. Duas
afirmações foram rejeitadas: esta máquina já executa npm 12.0.1, não npm 11; e
instalação global por tarball produzido do source local viola a diretiva do
operador. O único fluxo documentado é `npm upgrade -g` da versão publicada.

Foi detectada, sem revelar seu valor, uma credencial npmjs no `.npmrc` do
usuário. Ela não participa da publicação OIDC. Sua finalidade deve ser auditada
no npmjs.com e, se for um GAT de automação/bypass, rebaixada a somente leitura
ou revogada. Essa alteração de conta não foi inferida nem executada por código.

## Limitações deliberadas

- Não foi feita uma quarta rodada paga nas sessões preservadas. A diretiva era
  evitar gasto repetitivo; os adapters foram verificados por interceptação do
  wire e SDKs oficiais.
- DeepSeek/Grok/Perplexity continuam fail-closed em terminais ambíguos. A única
  exceção DeepSeek é `insufficient_system_resource`, que a API oficial define
  como interrupção por recurso insuficiente do sistema de inferência.
- A nova chave `max_output_tokens_by_peer` não deve ser inserida na config
  central enquanto um host 4.5.5 puder recarregá-la: o schema estrito antigo
  rejeitaria atomicamente o arquivo. A mudança operacional deve ocorrer após a
  publicação/upgrade para 4.5.7 e antes do reload dessa nova janela.

## Referências oficiais

- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI reasoning budgets](https://developers.openai.com/api/docs/guides/reasoning#allocating-space-for-reasoning)
- [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
- [OpenAI pricing](https://developers.openai.com/api/docs/pricing)
- [Anthropic Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Anthropic task budgets](https://platform.claude.com/docs/en/build-with-claude/task-budgets)
- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Gemini Structured Outputs](https://ai.google.dev/gemini-api/docs/structured-output?lang=rest)
- [Gemini GenerateContent API](https://ai.google.dev/api/generate-content)
- [Gemini 3.1 Pro Preview](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview)
- [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [DeepSeek JSON mode](https://api-docs.deepseek.com/guides/json_mode/)
- [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)
- [DeepSeek Chat Completion API](https://api-docs.deepseek.com/api/create-chat-completion)
- [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/)
- [xAI Structured Outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs)
- [xAI pricing](https://docs.x.ai/developers/pricing)
- [Perplexity Sonar API](https://docs.perplexity.ai/api-reference/sonar-post)
- [Perplexity Sonar Reasoning Pro](https://docs.perplexity.ai/docs/sonar/models/sonar-reasoning-pro)
- [Perplexity pricing](https://docs.perplexity.ai/docs/getting-started/pricing)
- [npm install-time security and GAT bypass2fa deprecation](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/)
- [npm 12 configuration](https://docs.npmjs.com/cli/v12/using-npm/config/)
- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm staged publishing](https://docs.npmjs.com/staged-publishing/)

## Evidência de release

### Validação local antes do commit

- instalação limpa: `npm ci --ignore-scripts --no-audit --no-fund`, 245
  pacotes, exit 0;
- contratos 4.5.6: 22/22;
- grounding 4.5.4: 20/20;
- provider refresh, provider terminal, citações, truthfulness, cancelamento,
  durable jobs, health/activity, accounting, evidence transport/custody e
  source contracts: todos verdes;
- smoke amplo fail-fast: 122 eventos e `ok: true` após atualizar os fixtures
  antigos para o call graph FinOps completo;
- runtime smoke stdio: `ok: true`, runtime 4.5.7, seis peers stub, preflights,
  identidade, cancelamento e convergência exercitados;
- `npm run check`, `git diff --check` e todos os workflows pelo `actionlint`:
  exit 0;
- `npm audit --omit=dev`: 0 vulnerabilidades em todos os níveis;
- `npm pack --dry-run --ignore-scripts`: pacote 4.5.7, 185 entradas, cerca de
  914 kB compactados e 4,21 MB desempacotados. O relatório integra o
  próprio pacote, portanto o integrity autorreferente não é congelado aqui; o
  valor autoritativo do registry será registrado após a publicação.

O comando agregado `npm test` é fail-fast. As primeiras execuções revelaram
drift de fixtures históricas (namespace português, cartões de stubs e tetos
sintéticos anteriores ao call graph completo). Em vez de reiniciar toda a
bateria após cada stop, cada componente restante foi executado até o fim; todos
ficaram verdes. A confirmação agregada limpa é responsabilidade do CI no commit
publicado e será registrada abaixo. Nenhuma API paga foi chamada nesta
validação.

### Publicação

O primeiro push criou `v04.05.06`, mas o CI usava o npm embarcado no Node 24 e
falhou na instalação com `EALLOWREMOTE` sob a política npm 12. O cancelamento do
publish run `29204032723` chegou depois dos comandos de publicação: o npmjs
registra 4.5.6 em `2026-07-12T18:33:54.523Z`, com provenance SLSA, integrity
`sha512-WklDb7JYeu5x3GFBt8E9pdDmhCdyRswcYtlLcD4dmZ2eU/ccWrnAeGM7Uew63IF3vOXfQd0lETCyA9vYY0B80A==`
e shasum `9147bdbd8fdc8cd2b81021993e730c2ab69e8973`. A etapa equivalente do GitHub
Packages também registrou o pacote antes do cancelamento, mas as verificações
posteriores e a criação do GitHub Release foram puladas. Trata-se, portanto, de
uma publicação parcial, não de uma publicação evitada.

A correção alinha o CI comum ao npm 12.0.1, confirma em runtime qual executável
`npm` ficou ativo, desativa cache, exige scripts estritamente aprovados e limita
o token StepSecurity ao install. O auto-tag deixou de competir com o CI em todo
push: agora recebe `workflow_run` apenas do CI concluído em `main`, exige
`conclusion == success` para evento `push`, faz checkout do `head_sha` validado e
só então cria a tag e despacha a publicação. Um contrato automatizado protege
essas propriedades. A 4.5.7 substitui a 4.5.6 como entrega completa.

A preencher após workflows verdes e publicação do pacote 4.5.7.
