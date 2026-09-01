# Apresentação do cross-review

Data de referência desta apresentação: 20/08/2026.

Este documento apresenta o `cross-review` para dois públicos:

- pessoas que precisam entender o que ele é, por que existe e como funciona em
  linguagem acessível;
- profissionais de TI e desenvolvimento que precisam instalar, configurar,
  operar, auditar ou integrar o servidor MCP.

As informações abaixo acompanham o release target do repositório. Como o
registro público pode ficar alguns minutos atrás do source durante o workflow,
consulte `npm view @lcv-ideas-software/cross-review version` para o estado do
registro e `server_info` para a versão efetivamente carregada pela janela MCP.
Após um upgrade global por npm, o host MCP ainda precisa ser recarregado.

## Resumo executivo

`cross-review` é um servidor MCP, publicado como
`@lcv-ideas-software/cross-review`, que coordena revisões cruzadas entre modelos
de IA de provedores diferentes. Em vez de depender da opinião de um único modelo,
ele envia o mesmo artefato para um conjunto de pares independentes, registra as
respostas, exige uma decisão estruturada e só considera uma rodada convergida
quando as condições de unanimidade são satisfeitas.

Na prática, ele funciona como uma banca técnica automatizada:

1. um agente, operador ou host MCP apresenta uma tarefa e um rascunho;
2. o servidor chama pares como Codex/OpenAI, Claude/Anthropic, Gemini/Google,
   DeepSeek, Grok/xAI e Perplexity;
3. cada par devolve uma decisão em formato padronizado: `READY`, `NOT_READY` ou
   `NEEDS_EVIDENCE`;
4. o orquestrador verifica se há unanimidade, falhas, pedidos de evidência ou
   bloqueios;
5. os resultados ficam persistidos em sessões duráveis, logs, eventos e
   relatórios.

O produto é estável. O source/release target de referência reporta:

| Campo                         | Valor atual                        |
| ----------------------------- | ---------------------------------- |
| Nome                          | `cross-review`                     |
| Publicador                    | `LCV Ideas & Software`             |
| Versão preparada pelo source  | `v04.06.05`                        |
| Data do source/release target | `01/09/2026`                       |
| Pacote npm                    | `@lcv-ideas-software/cross-review` |
| Transporte MCP                | `stdio`                            |
| Execução CLI por peers        | desativada                         |
| Modo padrão                   | chamadas reais de API              |
| Diretório de dados runtime    | `<data_dir>`                       |

## Explicação para não especialistas

Imagine que uma decisão técnica importante precisa ser revisada antes de ser
aceita: um plano, um relatório, um patch, uma configuração de segurança ou uma
análise operacional. Uma revisão feita por uma única pessoa ou por um único
modelo pode errar por excesso de confiança, falta de contexto ou viés do próprio
modelo.

O `cross-review` reduz esse risco fazendo uma revisão colegiada. Ele pergunta a
vários modelos independentes se o material está pronto, se ainda precisa de
correções ou se faltam evidências. Cada modelo precisa responder de forma
estruturada, e o sistema registra quem respondeu, qual foi a decisão, quais
evidências foram citadas e quais pendências restaram.

Ele não é um chat comum. Também não é um agente que sai lendo o computador,
rodando comandos ou corrigindo arquivos sozinho. O `cross-review` é um
orquestrador API-only: ele chama APIs de provedores de IA, mantém sessões
duráveis e controla o processo de deliberação. A coleta de evidências continua
sendo responsabilidade do agente ou operador que submete o caso.

## O problema que ele resolve

Fluxos com IA costumam falhar em quatro pontos:

- uma resposta parece convincente, mas não tem evidência verificável;
- um modelo ignora um detalhe crítico que outro modelo perceberia;
- uma rodada longa se perde em histórico, sem saber qual pendência está aberta;
- um agente declara "pronto" sem que os demais tenham concordado.

O `cross-review` cria uma camada de governança sobre esse processo. Ele exige
estado estruturado, registra eventos e separa decisão de narrativa. Isso torna o
resultado mais auditável e mais adequado para gates de qualidade, segurança,
documentação, release ou mudanças operacionais.

## Conceitos principais

| Conceito               | Significado                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| MCP                    | Model Context Protocol. É o protocolo usado para expor ferramentas a hosts como Codex, Claude Code e outros clientes compatíveis. |
| Caller                 | Quem submete a tarefa ao `cross-review`. Pode ser `operator` ou um dos agentes reconhecidos.                                      |
| Peer                   | Modelo participante da revisão, por exemplo `codex`, `claude`, `gemini`, `deepseek`, `grok` ou `perplexity`.                      |
| Relator ou `lead_peer` | Par que sintetiza ou revisa o artefato em fluxos iterativos. Quando há relator, ele não deve ser confundido com voto comum.       |
| Sessão                 | Registro durável de uma deliberação, com metadados, rodadas, eventos, anexos, custos e status final.                              |
| Rodada                 | Uma chamada de revisão feita aos peers dentro de uma sessão.                                                                      |
| Convergência           | Estado em que o caller está `READY`, os peers esperados também estão `READY` e não há falhas bloqueantes.                         |
| Evidência              | Dif, log, saída de comando, referência de arquivo/linha, hash ou outro dado objetivo que sustenta uma afirmação.                  |
| Evidence Broker        | Mecanismo que registra e acompanha pedidos de evidência gerados pelos peers.                                                      |
| Stub                   | Adaptador sintético usado em testes. Não deve validar decisões reais.                                                             |

## Decisões de revisão

Cada peer deve terminar a avaliação com um status estruturado:

| Status           | Quando usar                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `READY`          | O peer não vê bloqueio restante e aceita o material como pronto dentro do escopo revisado. |
| `NOT_READY`      | O peer encontrou correções concretas que ainda precisam ser feitas.                        |
| `NEEDS_EVIDENCE` | O peer não consegue decidir sem evidência adicional.                                       |

Esses status são propositalmente simples. O objetivo é evitar respostas
ambíguas como "parece bom" ou "talvez". O texto explicativo existe, mas a
decisão operacional precisa ser uma dessas três.

## Como funciona uma rodada

O fluxo mais comum é:

1. O host MCP chama uma ferramenta como `ask_peers`, `session_start_round`,
   `run_until_unanimous` ou `session_start_unanimous`.
2. O servidor valida identidade do caller, limites de entrada, configuração
   financeira, conjunto de peers habilitados e, quando aplicável, preflight de
   evidências.
3. O orquestrador cria ou carrega uma sessão durável.
4. Os adaptadores de peers chamam as APIs dos provedores configurados.
5. Cada resposta é parseada para extrair o status estruturado.
6. O orquestrador calcula a convergência.
7. O runtime grava metadados de sessão, eventos NDJSON, custos, telemetria de
   cache, anexos e relatórios.
8. O host consulta o resultado diretamente ou acompanha o job de fundo por
   `session_poll`, `session_events`, `session_metrics` e `session_report`.

Quando o fluxo é iterativo, o relator pode gerar uma versão revisada do artefato
e a sessão continua até unanimidade, limite de rodadas, cancelamento, orçamento
ou intervenção do operador.

## Regra de unanimidade

Uma sessão converge quando:

- o caller declara `READY`;
- todos os peers esperados, exceto skips permitidos, retornam `READY`;
- não há peer rejeitado, ausente, com status não parseável ou em
  `NEEDS_EVIDENCE`;
- não há bloqueio de orçamento, moderação, política, schema ou recuperação de
  formato;
- se algum peer foi pulado por indisponibilidade real do modelo, ainda resta um
  quorum mínimo significativo.

O runtime atual reporta `model_fallback: false`. Isso significa que o modelo
canônico de cada peer não deve ser substituído silenciosamente por um modelo
inferior. Quando um modelo fixado está indisponível, a sessão deve expor isso de
forma auditável em vez de degradar a qualidade sem aviso.

## Arquitetura em alto nível

O `cross-review` é composto por camadas bem definidas:

| Camada               | Responsabilidade                                                                        |
| -------------------- | --------------------------------------------------------------------------------------- |
| Servidor MCP         | Expõe ferramentas via `stdio` para hosts MCP.                                           |
| Orquestrador         | Cria sessões, chama peers, calcula unanimidade, controla jobs e rodadas.                |
| Adaptadores de peers | Encapsulam chamadas para APIs de OpenAI, Anthropic, Google, DeepSeek, xAI e Perplexity. |
| Seleção de modelos   | Valida e registra o modelo canônico ou override explícito usado por cada peer.          |
| Session store        | Persiste `meta.json`, eventos, anexos, relatórios e artefatos de sessão.                |
| Observabilidade      | Gera logs NDJSON por processo, métricas e relatórios de sessão.                         |
| Dashboard            | Oferece UI HTTP local de leitura para sessões, eventos, probes, relatórios e métricas.  |
| Camada de custos     | Estima e bloqueia chamadas pagas sem orçamento e rate cards explícitos.                 |
| Cache de prompts     | Usa prompt caching dos provedores quando suportado e registra telemetria uniforme.      |

O desenho é API-only. O servidor não executa shell, não roda `git diff`, não lê
arquivos do repositório por conta própria e não coleta evidência automaticamente.
Esse limite é importante: ele evita que a ferramenta finja ter verificado algo
que não recebeu.

## Peers suportados

O runtime atual tem seis peers habilitados:

| Peer         | Provedor   | Cliente/runtime                  |
| ------------ | ---------- | -------------------------------- |
| `codex`      | OpenAI     | pacote `openai`, Responses API   |
| `claude`     | Anthropic  | pacote `@anthropic-ai/sdk`       |
| `gemini`     | Google     | pacote `@google/genai`           |
| `deepseek`   | DeepSeek   | API compatível com OpenAI        |
| `grok`       | xAI        | superfície compatível com OpenAI |
| `perplexity` | Perplexity | Agent API (Responses-compatível) |

Os nomes dos peers são estáveis dentro do protocolo. A configuração de modelos
usa variáveis específicas por provedor, mas as sessões e respostas se referem
aos peers por esses IDs.

## Modelos canônicos atuais

O projeto usa pinos canônicos para evitar downgrade silencioso. Os valores
documentados no repositório atual são:

| Peer         | Modelo padrão            | Override                        |
| ------------ | ------------------------ | ------------------------------- |
| `codex`      | `gpt-5.6-sol`            | `CROSS_REVIEW_OPENAI_MODEL`     |
| `claude`     | `claude-fable-5`         | `CROSS_REVIEW_ANTHROPIC_MODEL`  |
| `gemini`     | `gemini-3.1-pro-preview` | `CROSS_REVIEW_GEMINI_MODEL`     |
| `deepseek`   | `deepseek-v4-pro`        | `CROSS_REVIEW_DEEPSEEK_MODEL`   |
| `grok`       | `grok-4.6`               | `CROSS_REVIEW_GROK_MODEL`       |
| `perplexity` | `perplexity/kimi-k3`     | `CROSS_REVIEW_PERPLEXITY_MODEL` |

Overrides devem ser decisão explícita do operador. A proposta do sistema é
priorizar correção, rastreabilidade e profundidade de raciocínio, não custo ou
latência mínimos.

`claude-fable-5` é o pin Anthropic canônico. O request omite o campo explícito
`thinking` porque o pensamento adaptativo é automático e usa
`output_config.effort` para controlar profundidade. A retenção documentada é
de 30 dias, sem ZDR; recusas `stop_reason="refusal"` bloqueiam como
`provider_refusal` e seu texto parcial não é aceito como parecer.

`claude-opus-5` é um override explícito suportado, não um fallback. Ele usa
pensamento adaptativo com exibição omitida e o mesmo controle de effort, além
de rate card próprio; trocar apenas o nome do modelo sem a tarifa correspondente
continua falhando fechado no preflight financeiro.

Nesta versão, o Evidence Broker também passa a admitir pedidos de forma
atômica, com tetos configuráveis por peer, rodada e sessão. Exceder um teto
preserva a resposta completa para auditoria e encerra a sessão antes de novo
gasto; nenhum blocker é truncado ou declarado satisfeito por conveniência.

Para `gpt-5.6-sol`, `ultra` designa um modo de execução do produto Codex, não
um `reasoning.effort` literal da Responses API. O cross-review o aceita como
alias de compatibilidade na configuração e o adaptador envia o valor oficial
`max`. O `grok-4.6` aceita `low`, `medium`, `high` e `xhigh`, portanto o alias
é normalizado para `xhigh` antes do envio; o Perplexity (`perplexity/kimi-k3`,
Agent API) recebe `max`. Nenhuma API recebe a string `ultra`.
Overrides explícitos de GPT-5.5/5.4/5.2 são limitados a `xhigh`; GPT-5.1 e o
GPT-5 original são limitados a `high`, com tradução dos valores inferiores que
não existam no enum da família escolhida.

## Ferramentas MCP

A superfície MCP da release expõe as seguintes ferramentas:

| Ferramenta                              | Uso principal                                                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `server_info`                           | Inspeciona versão, configuração carregada/hash/reload, budget, peers e segurança ativa.                     |
| `runtime_capabilities`                  | Retorna contrato de capacidades e lista de ferramentas.                                                     |
| `probe_peers`                           | Consulta provedores para verificar reachability e modelos disponíveis.                                      |
| `session_init`                          | Cria uma sessão durável sem chamar reviewers.                                                               |
| `session_list`                          | Lista sessões de forma paginada e resumida.                                                                 |
| `session_read`                          | Lê o `meta.json` completo de uma sessão.                                                                    |
| `ask_peers`                             | Executa uma rodada real de revisão.                                                                         |
| `session_start_round`                   | Inicia rodada em background e devolve `session_id`/`job_id`.                                                |
| `run_until_unanimous`                   | Gera/revisa até unanimidade, limite de rodadas ou bloqueio.                                                 |
| `session_start_unanimous`               | Versão background do fluxo até unanimidade.                                                                 |
| `session_cancel_job`                    | Cancela job ativo ou devolve de modo idempotente o estado terminal/final já persistido.                     |
| `session_recover_interrupted`           | Recupera sessões interrompidas.                                                                             |
| `session_poll`                          | Consulta resumo limitado por padrão; `detail="full"` habilita a visão forense completa.                     |
| `session_events`                        | Lê eventos duráveis da sessão.                                                                              |
| `session_metrics`                       | Retorna métricas agregadas ou de uma sessão.                                                                |
| `session_doctor`                        | Audita sessões abertas, travadas ou inconsistentes; histórico terminal fica em totals por padrão.           |
| `session_report`                        | Gera relatório Markdown de uma sessão.                                                                      |
| `session_peer_reliability_report`       | Agrega sinais de confiabilidade por peer sem alterar seleção ou estado de sessão.                           |
| `session_check_convergence`             | Retorna estado de convergência durável sem chamar provedores.                                               |
| `session_preflight_check`               | Executa os mesmos gates de evidência e veracidade da rodada real sem chamar provedores.                     |
| `session_truthfulness_preflight_check`  | Alias legado do preflight combinado.                                                                        |
| `session_attach_evidence`               | Promoção opcional de autoridade exclusiva do operador; agentes usam `evidence`, persistido automaticamente. |
| `session_evidence_checklist_update`     | Atualiza status de itens de evidência.                                                                      |
| `session_evidence_judge_pass`           | Usa um peer como juiz de evidência em modo controlado.                                                      |
| `session_evidence_judge_consensus_pass` | Juízo de evidência por consenso entre peers.                                                                |
| `session_judgment_precision_report`     | Mede precisão/recall/F1 dos julgamentos shadow.                                                             |
| `contest_verdict`                       | Contesta verdict final e abre novo ciclo com cadeia de custódia.                                            |
| `escalate_to_operator`                  | Registra necessidade de julgamento humano.                                                                  |
| `regenerate_caller_tokens`              | Rotaciona tokens locais de identidade por host.                                                             |
| `session_sweep`                         | Finaliza sessões inativas e limpa históricos conforme política.                                             |
| `session_finalize`                      | Marca sessão como `converged`, `aborted` ou `max-rounds`.                                                   |

## Modos de trabalho

### Revisão simples

Use `ask_peers` quando já existe um artefato e a intenção é obter o parecer dos
peers em uma rodada.

Exemplo de uso conceitual:

```json
{
  "caller": "codex",
  "caller_status": "READY",
  "task": "Revisar o documento de apresentação do cross-review.",
  "review_focus": "Verifique clareza, precisão técnica, completude e riscos de afirmações sem evidência.",
  "draft": "<conteúdo do documento>"
}
```

### Revisão em background

Use `session_start_round` quando a chamada pode demorar mais que o timeout do
host MCP. O servidor retorna um job e a sessão pode ser acompanhada com
`session_poll` e `session_events`.

No poll, `active_round_number` é a rodada ainda em execução e
`latest_completed_round_number` é a rodada mais recente já persistida. O
padrão `detail="summary"` conserva status, verdicts, resumos limitados e
convergência sem repetir `text`, `raw` e `structured` integrais dos peers;
`detail="full"` ou `session_read` são usados somente quando a investigação
forense exige os corpos completos. `response_format="markdown"` produz
Markdown real em toda a superfície compatível, com HTML externo neutralizado.

### Refinamento até unanimidade

Use `run_until_unanimous` quando o objetivo é gerar ou revisar iterativamente um
artefato até que todos concordem. Esse fluxo pode usar um relator e modos como:

- `ship`: o relator produz uma versão revisada pronta para entrega;
- `review`: o artefato é o objeto da análise, com foco em parecer;
- `circular`: custódia deliberativa serial, útil para textos e especificações.

### Operação com evidências

Quando o material faz uma afirmação do tipo "teste passou", "build validado" ou
"diff aplicado", ele deve trazer evidência objetiva: saída de comando, hunks de
diff, referências `arquivo:linha`, hashes ou anexos. O preflight de evidência
existe para impedir que uma sessão paga avance com afirmações sem base.

## Instalação

### Pré-requisitos

- Node.js `>=22`. O CI do projeto usa Node.js 24.
- npm.
- Um host MCP capaz de iniciar servidores via `stdio`.
- Chaves de API dos provedores que serão usados.
- Orçamento e rate cards configurados antes de chamadas pagas.

### Instalação global via npm

```bash
npm upgrade -g @lcv-ideas-software/cross-review --ignore-scripts --allow-git=none --allow-remote=none
```

Esse comando usa somente o pacote publicado. Não instale o runtime globalmente
a partir dos fontes e não aponte o host MCP para este checkout. Confirme o
registro com `npm view @lcv-ideas-software/cross-review version` e a versão
efetiva com `server_info` depois de recarregar a janela MCP.

### Instalação via GitHub Packages

```bash
npm upgrade -g @lcv-ideas-software/cross-review --@lcv-ideas-software:registry=https://npm.pkg.github.com --ignore-scripts --allow-git=none --allow-remote=none
```

Dependendo do ambiente, GitHub Packages pode exigir autenticação npm
configurada para o escopo `@lcv-ideas-software`.

### Política de runtime para desenvolvimento

Testes e builds de validação podem rodar no checkout, mas isso não instala o
produto. O host MCP deve continuar apontando apenas para o pacote global
publicado pelo registro.

### Smoke tests locais sem custo

```powershell
$env:CROSS_REVIEW_STUB = "1"
$env:CROSS_REVIEW_STUB_CONFIRMED = "1"
npm test
```

Stubs só devem ser usados em desenvolvimento, CI e smoke tests. O contrato atual
falha rápido quando `CROSS_REVIEW_STUB=1` está ativo sem confirmação explícita,
porque tanto o stub silencioso quanto a queda silenciosa para chamadas pagas
seriam perigosos.

## Configuração mínima

As credenciais de runtime devem vir de variáveis de ambiente do Windows. O
projeto não usa `.env` com segredos reais.

```powershell
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "<OPENAI_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "<ANTHROPIC_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("GEMINI_API_KEY", "<GEMINI_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", "<DEEPSEEK_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("GROK_API_KEY", "<GROK_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("PERPLEXITY_API_KEY", "<PERPLEXITY_API_KEY>", "User")
```

Depois de alterar variáveis de ambiente, reinicie terminal, editor ou host MCP.

## Configuração de custos

Chamadas reais podem gerar custo nos provedores. O `cross-review` bloqueia
chamadas pagas quando faltam tetos de orçamento ou rate cards por peer.

Variáveis de orçamento:

```powershell
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_MAX_SESSION_COST_USD", "20", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PREFLIGHT_MAX_ROUND_COST_USD", "20", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_UNTIL_STOPPED_MAX_COST_USD", "30", "User")
```

Rate cards devem ser informados em USD por milhão de tokens para cada provedor,
usando a precificação oficial vigente no momento da configuração:

```powershell
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_INPUT_USD_PER_MILLION", "<rate>", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_OUTPUT_USD_PER_MILLION", "<rate>", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_INPUT_USD_PER_MILLION", "<rate>", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_OUTPUT_USD_PER_MILLION", "<rate>", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GEMINI_INPUT_USD_PER_MILLION", "<rate>", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GEMINI_OUTPUT_USD_PER_MILLION", "<rate>", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_DEEPSEEK_INPUT_USD_PER_MILLION", "<rate>", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_DEEPSEEK_OUTPUT_USD_PER_MILLION", "<rate>", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GROK_INPUT_USD_PER_MILLION", "<rate>", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GROK_OUTPUT_USD_PER_MILLION", "<rate>", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PERPLEXITY_INPUT_USD_PER_MILLION", "<rate>", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_PERPLEXITY_OUTPUT_USD_PER_MILLION", "<rate>", "User")
```

O Perplexity (Agent API) cobra a ferramenta `web_search` por invocação; com a
busca ativa, configure também
`CROSS_REVIEW_PERPLEXITY_SEARCH_QUERIES_USD_PER_1000_REQUESTS` (o preflight
usa a estimativa `CROSS_REVIEW_PERPLEXITY_WEB_SEARCH_INVOCATIONS_ESTIMATE`,
padrão `3`, e a contabilidade pós-chamada usa a contagem reportada pela API).

O runtime consultado nesta sessão indicou `paid_calls_ready: true`, sem variáveis
financeiras faltantes, para a configuração local carregada.

## Configuração em host MCP

Um host MCP precisa iniciar o servidor via `stdio`. Em instalação global, a forma
mais simples é chamar o binário `cross-review`. Em ambientes que preferem caminho
absoluto, a entrada pode apontar para `dist/src/mcp/server.js` do pacote
instalado.

Exemplo conceitual:

```json
{
  "mcpServers": {
    "cross-review": {
      "command": "cross-review",
      "env": {
        "CROSS_REVIEW_CALLER_TOKEN": "<token-do-host>",
        "CROSS_REVIEW_REQUIRE_TOKEN": "true",
        "CROSS_REVIEW_MAX_SESSION_COST_USD": "20",
        "CROSS_REVIEW_PREFLIGHT_MAX_ROUND_COST_USD": "20",
        "CROSS_REVIEW_UNTIL_STOPPED_MAX_COST_USD": "30"
      }
    }
  }
}
```

Nunca copie tokens reais para documentação, issues, chats ou screenshots. O
campo acima é apenas um placeholder.

## Arquivo central de configuração

Além de variáveis de ambiente, o projeto suporta um arquivo central
`config.json`. Por padrão ele fica em:

```text
<data_dir>/config.json
```

O caminho pode ser alterado por `CROSS_REVIEW_CONFIG_FILE`. A precedência é:

1. variáveis do processo ou host MCP;
2. variáveis do registro do Windows;
3. arquivo central `config.json`;
4. defaults internos do `loadConfig()`.

O arquivo central não contém chaves de API e não substitui o token de identidade
do host. Esses itens continuam separados por desenho.

## Variáveis operacionais importantes

| Variável                                   | Finalidade                                                  |
| ------------------------------------------ | ----------------------------------------------------------- |
| `CROSS_REVIEW_DATA_DIR`                    | Define o diretório de dados.                                |
| `CROSS_REVIEW_CONFIG_FILE`                 | Define caminho alternativo para o `config.json`.            |
| `CROSS_REVIEW_LOG_LEVEL`                   | Controla verbosidade dos logs.                              |
| `CROSS_REVIEW_DASHBOARD_PORT`              | Porta do dashboard local, padrão `4588`.                    |
| `CROSS_REVIEW_TIMEOUT_MS`                  | Timeout HTTP por chamada de provedor, padrão 30 minutos.    |
| `CROSS_REVIEW_MAX_OUTPUT_TOKENS`           | Limite de saída solicitado aos provedores, padrão `20000`.  |
| `CROSS_REVIEW_MAX_TASK_CHARS`              | Limite de caracteres do campo `task`, padrão `8000`.        |
| `CROSS_REVIEW_MAX_DRAFT_CHARS`             | Limite do rascunho, padrão `40000`.                         |
| `CROSS_REVIEW_MAX_ATTACHED_EVIDENCE_CHARS` | Orçamento para evidências anexadas, padrão `200000`.        |
| `CROSS_REVIEW_STREAM_EVENTS`               | Habilita eventos de workflow.                               |
| `CROSS_REVIEW_STREAM_TOKENS`               | Habilita eventos de progresso de tokens.                    |
| `CROSS_REVIEW_STREAM_TEXT`                 | Inclui texto redigido nos eventos, opt-in.                  |
| `CROSS_REVIEW_EVIDENCE_PREFLIGHT`          | Liga/desliga preflight textual de evidência, padrão ligado. |
| `CROSS_REVIEW_TRUTHFULNESS_PREFLIGHT`      | Liga/desliga preflight anti-fabricação, padrão ligado.      |
| `CROSS_REVIEW_PEER_<NAME>`                 | Habilita ou desabilita peer específico com `on`/`off`.      |
| `CROSS_REVIEW_STUB`                        | Ativa stubs quando combinado com confirmação explícita.     |
| `CROSS_REVIEW_STUB_CONFIRMED`              | Confirma uso deliberado de stubs.                           |
| `CROSS_REVIEW_CALLER_TOKEN`                | Token de identidade do host caller.                         |
| `CROSS_REVIEW_REQUIRE_TOKEN`               | Exige token de caller quando ativo.                         |

## Dependências

### Runtime

Dependências diretas de runtime declaradas no `package.json` atual:

| Pacote              | Uso                               |
| ------------------- | --------------------------------- |
| `@anthropic-ai/sdk` | Cliente Anthropic/Claude.         |
| `@google/genai`     | Cliente Google Gemini.            |
| `openai`            | OpenAI e APIs compatíveis.        |
| `pino`              | Logging estruturado.              |
| `proper-lockfile`   | Locking de sessão multi-processo. |
| `protobufjs`        | Serialização protobuf.            |
| `zod`               | Validação de schemas.             |

O `package.json` é a fonte de verdade para os intervalos declarados, e o
`package-lock.json` registra a resolução exata deste checkout do repositório;
consumidores resolvem os intervalos em seus próprios lockfiles.

### Bundle e desenvolvimento

O SDK MCP é uma dependência direta de desenvolvimento incorporada pelo build ao
artefato stdio publicado. Por isso seu escopo auditável é `bundled/dev`: ele não
fica como dependência de produção não declarada no ambiente consumidor.

Dependências diretas de bundle e desenvolvimento:

| Pacote                      | Versão declarada | Uso                                      |
| --------------------------- | ---------------- | ---------------------------------------- |
| `@modelcontextprotocol/sdk` | `^1.29.0`        | Implementação MCP incorporada ao bundle. |
| `@biomejs/biome`            | `^2.4.15`        | Lint/format complementar.                |
| `@eslint/js`                | `^10.0.1`        | ESLint base.                             |
| `@types/node`               | `^26.0.0`        | Tipos Node.js.                           |
| `@types/proper-lockfile`    | `^4.1.4`         | Tipos do `proper-lockfile`.              |
| `esbuild`                   | `^0.28.1`        | Bundle auditável do servidor stdio.      |
| `eslint`                    | `^10.4.0`        | Lint.                                    |
| `eslint-config-prettier`    | `^10.1.8`        | Integração ESLint/Prettier.              |
| `prettier`                  | `^3.8.3`         | Formatação.                              |
| `tsx`                       | `^4.22.3`        | Execução TypeScript em scripts/dev.      |
| `typescript`                | `^6.0.3`         | Build e typecheck.                       |
| `typescript-eslint`         | `^8.66.0`        | Regras TypeScript para ESLint.           |

## Scripts do projeto

Os scripts principais são `build`, `dev`, `dashboard`, `smoke`,
`evidence-preflight-smoke`, `evidence-transport-regression`,
`truthfulness-preflight-smoke`, `runtime-smoke`, `api-streaming-smoke`, `test`,
`lint`, `format:check`, `typecheck`, `biome` e `check`. O script `check` reúne
formatação, lint, Biome e typecheck; `test` executa build, smokes focados, smoke
geral e runtime smoke.

## Persistência e observabilidade

O runtime grava estado fora do repositório, no `data_dir` configurado. Em uma
instalação real, `server_info` reporta o caminho efetivo:

```text
<data_dir>
```

Esse diretório contém sessões, eventos, logs, tokens locais de host e relatórios.
O `server_info` também informa o arquivo de log NDJSON ativo e
`config_load`: caminho, resultado do parse, campos aplicados/sobrepostos,
mtime/SHA-256 carregado e atual, e `reload_required`. A configuração é
capturada no início do processo e `live_reload_supported=false`; depois de
editar o arquivo central ou variáveis, reinicie/recarregue a janela ou host MCP.

Arquivos típicos por sessão:

- `meta.json`: estado durável da sessão;
- `events.ndjson`: eventos incrementais;
- evidências do caller persistidas automaticamente e anexos opcionais do
  operador;
- `session-report.md`, quando gerado por `session_report`;
- manifestos de cache, quando aplicável.

## Segurança

O desenho de segurança atual combina controles de identidade, segredo, orçamento
e cadeia de custódia:

- o servidor é API-only e não executa comandos arbitrários;
- chaves de API devem vir de variáveis de ambiente do Windows;
- `.env` com segredos reais é explicitamente desaconselhado;
- `server_info` expõe readiness, peers habilitados e estado de tokens sem expor
  segredos;
- sete capability tokens vinculam hosts às seis identidades de agente e a uma
  identidade `operator` separada;
- `operator` exige seu próprio token mesmo quando enforcement de peer é
  permissivo; esse segredo só pode existir num console humano dedicado;
- evidência inline/estruturada de caller autenticado é persistida e transportada
  automaticamente como `caller_submitted_unverified`; somente a promoção de
  autoridade e as mutações de checklist, estado terminal e segurança são
  exclusivas do operador humano;
- cada artefato registra caller, origem, horário, bytes e SHA-256, emite evento
  durável e tem sua integridade recalculada a cada leitura;
- artefatos adulterados falham fechados; material de peer entra no corpus com
  rótulo não autoritativo e exige painel independente estrito para claims
  operacionais;
- raw chain-of-thought não é persistido;
- eventos de token registram contagens por padrão, não texto bruto;
- texto de streaming só aparece com opt-in explícito;
- respostas e logs passam por redaction;
- chamadas pagas são bloqueadas sem orçamento e rate cards;
- GitHub Actions usam ações pinadas por SHA;
- CI cobre formatação, lint, Biome, typecheck e smoke tests;
- CodeQL e workflows de supply chain fazem parte do baseline do repositório.

## Cache de prompts

O `cross-review` usa prompt caching quando o provedor oferece suporte:

| Provider   | Modo       |
| ---------- | ---------- |
| OpenAI     | automático |
| Anthropic  | explícito  |
| Gemini     | implícito  |
| DeepSeek   | automático |
| Grok       | automático |
| Perplexity | automático |

A telemetria é normalizada em eventos `provider.cache.usage` e manifestos por
sessão. Operadores podem desligar globalmente os controles de cache que o
cliente consegue influenciar:

```powershell
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_DISABLE_CACHE", "true", "User")
```

Esse controle remove os campos de cache enviados a OpenAI, Anthropic e Grok,
mas não pode obrigar Gemini ou DeepSeek a desativar o cache implícito/automático
administrado pelo próprio serviço.

Também há controles de TTL e versionamento de schema de cache, incluindo
`CROSS_REVIEW_CACHE_SCHEMA_VERSION`,
`CROSS_REVIEW_CACHE_TTL_ANTHROPIC` e `CROSS_REVIEW_CACHE_TTL_OPENAI`.

No pin atual, GPT-5.6 Sol usa `prompt_cache_options` implícito com TTL de 30
minutos e reporta tokens de leitura/escrita. Grok 4.6 usa
`prompt_cache_key`, tem retenção administrada pela xAI e não fornece contador
separado de escrita; o runtime não inventa esse consumo.

## Limites e cuidados

O `cross-review` aumenta rigor, mas não substitui julgamento técnico humano.
Pontos importantes:

- ele não coleta evidência sozinho;
- ele não garante que provedores externos estejam disponíveis;
- ele pode gerar custo financeiro em chamadas reais;
- revisões profundas podem demorar;
- modelos podem divergir, pedir evidência ou bloquear por política;
- uma sessão convergida ainda deve ser lida por um operador quando o impacto for
  alto;
- documentação histórica pode conter nomes antigos como `cross-review-v2`,
  preservados por rastreabilidade.

## Quando usar

Use `cross-review` quando a decisão precisa de mais rigor que uma resposta
isolada:

- revisão de patch relevante;
- parecer de segurança;
- validação de release;
- análise de incidente;
- decisão operacional com custo ou risco;
- documentação técnica que será usada como referência;
- gates de qualidade antes de merge, publicação ou deploy.

Evite usar para consultas simples, tarefas triviais ou verificações locais que
podem ser respondidas por um comando direto. Nesses casos, o custo operacional
de uma revisão multi-peer costuma ser desproporcional.

## Seção técnica para TI e desenvolvedores

### Contrato de entrada

Os campos essenciais de uma revisão são:

- `task`: descreve a tarefa ou objetivo;
- `review_focus`: restringe escopo e evita achados fora do pedido;
- `draft` ou `initial_draft`: artefato a ser revisado;
- `caller`: identidade que submete a revisão;
- `caller_status`: estado do caller para convergência;
- `evidence`: evidência estruturada opcional em `ask_peers`,
  `session_start_round` e nos fluxos até unanimidade;
- `reasoning_effort_overrides`: ajuste pontual por peer quando necessário.

O campo `review_focus` é importante para reduzir ruído. Ele deve dizer
explicitamente o que revisar, o que não revisar e qual tipo de achado é
bloqueante.

### Identidade e anti-self-review

O runtime protege contra autoavaliação indevida. Um agente não deve atuar ao
mesmo tempo como caller, relator e peer votante na mesma sessão. O conjunto de
peers é controlado pelo servidor e pode ser travado por configuração para evitar
que o caller escolha uma banca conveniente.

Tokens de caller reforçam essa separação. Cada peer recebe apenas seu token. O
sétimo token, `operator`, é sempre obrigatório nas ferramentas privilegiadas,
independentemente de `CROSS_REVIEW_REQUIRE_TOKEN`, e nunca deve ser colocado em
host de modelo. A rotação é feita por `regenerate_caller_tokens`; a
redistribuição é uma operação sensível.

### Evidência e preflight

O preflight textual procura um caso específico: texto que afirma trabalho
concluído sem apresentar qualquer marcador de evidência. Ele não decide mérito,
apenas evita gastar API em uma submissão evidentemente subevidenciada.

Evidências aceitáveis incluem:

- trechos de `git diff`;
- saída de `npm test`, `npm run check`, `git diff --check` ou comando
  equivalente;
- referências `arquivo:linha`;
- hashes;
- evidência inline ou no campo `evidence`, persistida automaticamente com
  caller, bytes e SHA-256;
- anexos opcionais promovidos pelo operador via `session_attach_evidence`; essa
  superfície privilegiada não participa do fluxo normal de agentes, que usam o
  campo `evidence` com persistência automática;
- logs relevantes.

Um anexo genérico não prova uma alegação não relacionada. Claims de runtime,
modelo, workflow/deploy, autorização, hashes e resultados de testes precisam
corresponder aos valores da evidência. Todo `READY` precisa de fonte rastreável
ao artefato ou à evidência transportada. Se a alegação operacional depender
apenas de bytes enviados por um peer, ao menos dois revisores independentes
devem usar `confidence=verified` e citar path, SHA-256 e linhas brutas
correlacionadas; confiança `inferred` não basta. Metadados de runtime só
corroboram uma alegação runtime correspondente
e não provam revisão do artefato; caso contrário, o voto é rebaixado para
`NEEDS_EVIDENCE`. Status estruturado incompleto, autorrevisão, model mismatch,
READY truncado/contraditório, evidência aberta/não ressurgida e fabricação do
relator não convergem. Um peer pode retirar somente a própria ask depois de uma
revalidação estrita, sem fechar pedido alheio ou estado terminal. Só o operador
autenticado pode promover evidência para autoridade de operador ou dar disposição
autoritativa terminal.

Para revisões sérias, empacote evidência antes de chamar peers. O servidor não
deve ser tratado como coletor de repo, shell ou CI.

### Jobs assíncronos e timeouts

Chamadas reais podem superar timeouts comuns de hosts MCP. Para isso, prefira
ferramentas background:

- `session_start_round`;
- `session_start_unanimous`.

Depois consulte:

- `session_poll` para progresso limitado por padrão ou `detail="full"` para
  inspeção forense;
- `session_events` para stream durável;
- `session_metrics` para custo e contadores;
- `session_report` para relatório final.

O timeout HTTP padrão por provedor é 30 minutos. O host MCP deve ter timeout
suficiente ou usar jobs assíncronos.

O status compacto de cada job é persistido na sessão e reconciliado entre
processos. Assim, uma janela irmã ou um runtime reiniciado distingue trabalho
terminal de um ID desconhecido. Se o cancelamento chegar após a conclusão, a
resposta é um no-op explícito: `job_already_terminal` ou
`session_already_terminal`, com `terminal_job` quando aplicável e
`final_state` em ambos os casos.

### Estados finais

Uma sessão pode terminar como:

- `converged`: convergiu;
- `aborted`: abortada por erro, cancelamento, evidência insuficiente ou ação
  operacional;
- `max-rounds`: atingiu limite de rodadas ou orçamento.

O campo `convergence_health` complementa o outcome. Ele não deve ser confundido
com a decisão final; sessões antigas ou inconsistentes podem exigir
`session_doctor`.

### Dashboard

O pacote também expõe `cross-review-dashboard`, uma UI HTTP local de leitura.
Ela é útil para navegar sessões, eventos, relatórios, probes e métricas sem
abrir manualmente arquivos NDJSON.

Comandos típicos:

```bash
cross-review-dashboard
```

ou, em desenvolvimento:

```bash
npm run dashboard
```

### CI e publicação

O repositório usa workflows para:

- CI em push e pull request para `main`;
- CodeQL em push, PR, agendamento e workflow manual;
- auto-tag somente após CI verde de um push em `main` e publicação pela tag
  verificada;
- publicação manual somente por dispatch explícito de uma tag existente;
- Pages, Scorecard, dependency review e admissão humana pela merge queue nativa.

O gate de CI executa:

- Prettier;
- ESLint;
- Biome;
- TypeScript typecheck;
- política npm 12 e encadeamento CI → tag;
- bootstrap do npm pinado por SHA-512 antes da execução;
- smoke tests com stub confirmado.

O gate de publicação executa `npm run check`, `npm test`, valida metadata e
publica com provenance quando aplicável.

## Changelog breve

| Versão           | Data          | Destaque                                                                                                                                                                                                                                                                                                              |
| ---------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v04.06.05`      | 01/09/2026    | Preserva READY para 20 fontes path+digest+literal cujas URLs GitHub diferem só pelo escape JSON do provider e mantém a custódia de arquivos de patch unificado nos rounds do relator, sem liberar URL inventada, quote cruzada ou arquivo ausente.                                                                    |
| `v04.06.04`      | 28/08/2026    | Torna a correlação de conflitos linear e exata por `argv`, e interpreta estado futuro/atual por frames finitos em inglês/português e spans por ocorrência, com `replace … with`, `update … to`, qualificadores presentes e isolamento por ponto e vírgula.                                                            |
| `v04.06.03`      | 25/08/2026    | Restaura o fail-closed contra execuções conflitantes do mesmo comando, construções aditivas `not only`/`não só` e alegações atuais próximas de linguagem de planejamento, preservando RED/GREEN independentes e alvos futuros explícitos.                                                                             |
| `v04.06.02`      | 24/08/2026    | Republish da v04.06.01 com a action do validador autocontida (parser embutido, prova de runner limpo), manifests locais resolvidos por referência e allowance restrita por localização.                                                                                                                               |
| `v04.06.01`      | 24/08/2026    | Republish da v04.06.00 com o fix do gate de supply-chain: permissions mínimas por job, `TokenPermissionsID` vigiado de novo e revalidação real de pinning no gate do Publish (referências `$/` same-repo).                                                                                                            |
| `v04.06.00`      | 23/08/2026    | Peer Perplexity migra para a Agent API com o pin `perplexity/kimi-k3` antes do sunset da Sonar (27/09/2026); Grok passa a `grok-4.6` com effort `xhigh`; preços atualizados pelas docs oficiais; smoke da loteria do relator determinístico com limiar qui-quadrado explícito (CROSREV-18, #231).                     |
| `v04.05.45`      | 21/08/2026    | O contrato de sessão e a instrução dos peers reconhecem o canal de evidência persistido (200K, custódia SHA-256) como o artefato único não-filtrado: pedido de re-colagem no corpo do draft passa a ser defeito da revisão, destravando a convergência de PRs médios (issue #216).                                    |
| `v04.05.44`      | 21/08/2026    | O scrubber ganha padrão dedicado para o formato stateless (JWT) dos tokens de instalação de GitHub Apps (`ghs_` com segmentos base64url): o token inteiro é redigido numa única correspondência, sem depender do comprimento do primeiro segmento no padrão genérico de JWT (issue #215).                             |
| `v04.05.43`      | 21/08/2026    | O evidence preflight corrobora contagens de teste por registro: a prova RED de um TDD (`N failed` com o próprio run) passa como material do caller e um registro RED deliberado não veta contagens verdes de outros registros; o veto de sinal de falha segue valendo dentro do registro correspondente (issue #217). |
| `v04.05.42`      | 20/08/2026    | Registros legados de gasto mesclados preservam o estado fail-closed em re-merges (tentativas não-precificadas sem marcador contam como indeterminadas) e o sentinel de interrupção tolera registro legado sem message.                                                                                                |
| `v04.05.41`      | 20/08/2026    | Falha terminal de provedor sem usage liquida como custo zero (destrava o preflight de orçamento que matava sessões com peer sem quota); receita manual dedicada para falha de hardening; receitas verificam o descritor por handle exclusivo e comparam FullControl por igualdade exata.                              |
| `v04.05.40`      | 20/08/2026    | Resolve whoami/powershell por caminho absoluto de System32 (o whoami GNU do Git Bash quebrava o boot; PATH gravável não substitui mais o motor da DACL), eleva os tetos dos spawns de boot (10s→60s; 5s→15s) e classifica a etapa/causa da falha no erro.                                                             |
| `v04.05.39`      | 20/08/2026    | Impede retry de recuperação de caller token no mesmo boot, recria somente após desaparecimento confirmado e faz a receita manual substituir apenas uma DACL protegida e vazia antes de validar o resultado exato.                                                                                                     |
| `v04.05.38`      | 20/08/2026    | Trava a dívida T2#10 de regexes amplas de source no baseline atual `smoke=129`, `source-contract=29`, total `158`, impedindo que novos pins consumam a folga deixada pelos tetos anteriores.                                                                                                                          |
| `v04.05.37`      | 20/08/2026    | Torna a ACL dos caller tokens no Windows tolerante a interrupção, recupera uma única negação de acesso sem rotação ou loop e passa caminho/SID fora do parser de comandos, preservando os gates fail-closed de identidade e caminho.                                                                                  |
| `v04.05.36`      | 05/08/2026    | Corrige citações JSON byte-exatas, preserva evidência ativa no retry de decisão e aceita o conteúdo terminal agregado documentado do Perplexity sem enfraquecer os gates anti-fabricação.                                                                                                                             |
| `v04.05.35`      | 05/08/2026    | Protege o conteúdo do pacote público, isola o token administrativo em ambiente sem Deployment, atualiza TypeScript ESLint para 8.66.0 e torna determinístico o teste forense de processo pai no Windows.                                                                                                              |
| `v04.05.34`      | 03/08/2026    | Remove duas expressões redundantes apontadas pelo GitHub Code Quality, preservando o comportamento do preflight de orçamento e o fallback tardio de anexos quando o preflight de veracidade está desativado.                                                                                                          |
| `v04.05.33`      | 03/08/2026    | Substitui a tag 4.5.32 não publicada, reconhece o `404` documentado do npm apenas no probe OIDC negativo, preserva o gate positivo em `201`, usa escaping idêntico ao npm e atualiza a resolução do OpenAI para 7.3.0.                                                                                                |
| `v04.05.32`      | 03/08/2026    | Atualiza o npm verificado para 12.0.2, prova os contextos negado e autorizado do Trusted Publisher antes de executar código do projeto, separa escrita e verificação pós-publicação e corrige brace-expansion, fast-uri e ip-address.                                                                                 |
| `v04.05.31`      | 28/07/2026    | Substitui a tag 4.5.30 não publicada e torna a validação de licenças sensível à versão exata do SDK MCP empacotado.                                                                                                                                                                                                   |
| `v04.05.30`      | 28/07/2026    | Atualiza OpenAI para 7.0.0 e o SDK MCP empacotado para 1.30.0; remove Socket/Step; impede redispatch imutável; exige status GitHub exato; e executa Zizmor direto via uv com checksum.                                                                                                                                |
| `v04.05.29`      | 24/07/2026    | Substitui a tag 4.5.28 não publicada, fixa `brace-expansion` 5.0.8 após o advisory de DoS divulgado durante o release e preserva a correção TOCTOU dos caller tokens validada pelo CodeQL.                                                                                                                            |
| `v04.05.28`      | 24/07/2026    | Prepara Claude Opus 5 como override, limita a amplificação do Evidence Broker, repara lifecycle/provenance/truthfulness, protege caller tokens e pagina eventos; a tag foi preservada, mas não publicada.                                                                                                             |
| `v04.05.27`      | 24/07/2026    | Atualiza os SDKs Anthropic e OpenAI, centraliza as versões nos manifests e reforça as automações de dependências e recuperação de release.                                                                                                                                                                            |
| `v04.05.26`      | 22/07/2026    | Empacota o runtime MCP e reforça automação no SHA exato, releases imutáveis e dependências atuais.                                                                                                                                                                                                                    |
| `v04.05.25`      | 21/07/2026    | Corrige as três vulnerabilidades do lock: `body-parser` 2.3.0, `protobufjs` aninhado 7.6.5 e `brace-expansion` 5.0.7; aprova estritamente apenas o `postinstall` revisado de `protobufjs@7.6.5`. Scorecard e Auto-tag permanecem fail-closed, sem supressão de alerta.                                                |
| `v04.05.23`      | 17/07/2026    | Aceita a resposta unitária de `npm view --json` no npm 12 apenas com um objeto de metadata; respostas vazias, múltiplas ou inválidas falham fechadas antes do lock íntegro e da auditoria obrigatória.                                                                                                                |
| `v04.05.22`      | 17/07/2026    | Decodifica o envelope DSSE Sigstore publicado pelo npm antes de vincular a provenance SLSA ao workflow, à tag protegida e ao commit imutável; a auditoria criptográfica posterior permanece obrigatória.                                                                                                              |
| `v04.05.21`      | 17/07/2026    | Alinha a fixture de telemetria de config durável à semântica JSON: propriedade opcional não configurada é omitida do snapshot persistido e de seu SHA-256 canônico.                                                                                                                                                   |
| `v04.05.20`      | 17/07/2026    | Restaura fixture CI determinística do contrato budget/cache: Gemini recebe rate explícito e settlement conhecido não retém marcador de gasto desconhecido; o gate financeiro continua fail-closed.                                                                                                                    |
| `v04.05.19`      | 17/07/2026    | Corrige o Auto-tag/Scorecard com lock temporário íntegro, `npm ci`, contrato do tarball e `npm audit signatures`; visibilidade sem pipe remoto.                                                                                                                                                                       |
| `v04.05.18`      | 17/07/2026    | Fecha a auditoria de sessões 4.5.16–4.5.17 com grounding simétrico, persistência imediata por peer, preflights terminais auditáveis, judges limitados, telemetria completa e relatórios compactos acionáveis.                                                                                                         |
| `v04.05.17`      | 17/07/2026    | Publica a manutenção acumulada dos SDKs e mantém scripts de dependências bloqueados por padrão, com autorização exata do lifecycle no-op do Google Gen AI 2.12.0.                                                                                                                                                     |
| `v04.05.16`      | 13/07/2026    | Compacta o poll padrão, separa rodada ativa/concluída, entrega Markdown real seguro e persiste estado terminal de jobs para cancelamento tardio explícito entre hosts.                                                                                                                                                |
| `v04.05.15`      | 12/07/2026    | Publica a continuidade do Evidence Broker com updater npm suportado, npm 12 verificado nos workflows e lock pip-compile íntegro.                                                                                                                                                                                      |
| `v04.05.14`      | 12/07/2026    | Restaura continuidade segura do Evidence Broker por replay local grounded, aliases estritos, `git -C ... diff --check` e persistência reconciliada.                                                                                                                                                                   |
| `v04.05.13`      | 12/07/2026    | Elimina recorrência ReDoS no matcher de símbolos e bloqueia publicação até CodeQL do SHA exato concluir com zero alertas efetivamente abertos.                                                                                                                                                                        |
| `v04.05.12`      | 12/07/2026    | Corrige a convergência do Evidence Broker, roteia IDs pendentes automaticamente e mantém evidência irrelevante ou parcial bloqueada.                                                                                                                                                                                  |
| `v04.05.11`      | 12/07/2026    | Expõe no contrato MCP que evidência de agentes é persistida automaticamente, sem intervenção humana, e separa a promoção opcional de autoridade.                                                                                                                                                                      |
| `v04.05.10`      | 12/07/2026    | Tolera a propagação independente da atestação npm com retry delimitado e URL presa ao registry, mantendo SLSA provenance v1 obrigatório.                                                                                                                                                                              |
| `v04.05.09`      | 12/07/2026    | Elimina o deadlock DEF-10 mantendo remediação interna fora de `caller_requests`, sem afrouxar asks reais, grounding, custódia ou convergência.                                                                                                                                                                        |
| `v04.05.08`      | 12/07/2026    | Fecha sete alertas de code scanning com bootstrap npm 12.0.1 pinado por SHA-512 e checkout da branch padrão condicionado ao SHA que passou no CI.                                                                                                                                                                     |
| `v04.05.07`      | 12/07/2026    | Embarca a remediação dos seis providers com CI antes da tag, npm 12.0.1, scripts estritos e cache desativado.                                                                                                                                                                                                         |
| `v04.05.06`      | 12/07/2026    | Corrige contratos wire dos seis providers, budgets por peer, recovery OpenAI/Gemini, grounding de diffs/escapes, namespaces, terminais e contabilidade por modelo.                                                                                                                                                    |
| `v04.05.05`      | 12/07/2026    | Follow-up de publicação: fixtures de cancelamento, health e contabilidade herméticas em runner limpo, com prova contra falso verde; produção continua fail-closed sem rates.                                                                                                                                          |
| `v04.05.04`      | 12/07/2026    | Remedia grounding e preflights do hardgate, consenso independente, cancelamento multi-janela, ledger financeiro fail-closed, tetos efetivos, health/report terminal e alias `ultra`.                                                                                                                                  |
| `v04.05.03`      | 11/07/2026    | Elimina ReDoS e falsos bloqueios do hardgate em citações autenticadas, literais com aspas simples e bumps de versão do artefato.                                                                                                                                                                                      |
| `v04.05.02`      | 11/07/2026    | Publica o transporte autenticado de evidência com regressões herméticas que não dependem da configuração central do operador.                                                                                                                                                                                         |
| `v04.05.01`      | 11/07/2026    | Restaura transporte autenticado de evidência sem anexo manual, fecha confusão de autoridade, exige painel independente estrito e preserva terminais imutáveis.                                                                                                                                                        |
| `v04.05.00`      | 10/07/2026    | Atualiza os seis contratos de provider e endurece terminais, fingerprint de config, custody, grounding de READY e detecção anti-fabricação.                                                                                                                                                                           |
| `v04.04.08`      | 16/06/2026    | Eleva o piso transitivo de `hono` e fecha os advisories correntes.                                                                                                                                                                                                                                                    |
| `v04.04.07`      | 16/06/2026    | Promove o piso corrigido de `protobufjs` para consumidores downstream.                                                                                                                                                                                                                                                |
| `v04.04.06`      | 12/06/2026    | Fecha a cauda restante da revalidação Claude: leituras de evidência no orquestrador falham fechado, `session_doctor` separa histórico terminal de achados e T2#10 cai para 160 pins.                                                                                                                                  |
| `v04.04.05`      | 12/06/2026    | Fecha os 7 resíduos verificados da auditoria: realpath fail-closed em evidências, tipagem de `shadow_decision`, data derivada do CHANGELOG, comentário JWT e budget T2#10 bloqueado.                                                                                                                                  |
| `v04.04.04`      | 12/06/2026    | Adiciona rate cards por modelo no `config.json`, permitindo guardar preços de Claude Opus 4.8 e Claude Fable 5 e selecionar automaticamente pelo modelo configurado.                                                                                                                                                  |
| `v04.04.03`      | 12/06/2026    | Reduz o débito T2#10 movendo o contrato lazy provider SDK imports para `source-contract-smoke`, preservando cobertura e criando folga no budget do smoke geral.                                                                                                                                                       |
| `v04.04.02`      | 12/06/2026    | Suporta Claude Fable 5 como opção Anthropic explícita: seleção verificada, classificação `provider_refusal`, evento `provider.refusal`, docs de custo e postura de retenção.                                                                                                                                          |
| `v04.04.01`      | 12/06/2026    | Fecha a varredura residual: identity gate completo, cache/attachments, EventLog async, probe Perplexity auth-only, correções de custo/cache e smoke dedicado para contratos de source.                                                                                                                                |
| `v04.04.00`      | 12/06/2026    | Consolida o close-out da auditoria: `log_level`, containment realpath, guard inicial anti-fabricação, identity audit, probe Perplexity e docs.                                                                                                                                                                        |
| `v04.03.09`      | 11/06/2026    | Move `truthfulness_preflight` para smoke dedicado e endurece o match de artefatos externos de evidência.                                                                                                                                                                                                              |
| `v04.03.08`      | 11/06/2026    | Move a matriz comportamental de `evidence_preflight` para smoke dedicado, reduzindo acoplamento no smoke geral.                                                                                                                                                                                                       |
| `v04.03.07`      | 11/06/2026    | Bloqueia antes de chamadas pagas quando o texto referencia artefato externo de evidência/log que não foi anexado à sessão.                                                                                                                                                                                            |
| `v04.03.06`      | 11/06/2026    | Isola `runtime-smoke` em data dir temporário para não gravar sessões de harness no corpus real do operador.                                                                                                                                                                                                           |
| `v04.03.05`      | 11/06/2026    | Filtra `<think>` em eventos streaming da Perplexity, expande `~` no config central e reforça dashboard/smokes.                                                                                                                                                                                                        |
| `v04.03.04`      | 11/06/2026    | Endurece sequência de eventos cross-process, detector anti-fabricação, fallback Gemini sem texto e retry de erro streaming.                                                                                                                                                                                           |
| `v04.03.03`      | 11/06/2026    | Adiciona diagnósticos forenses para append/identity, flush em sinais, retry de 5xx estruturado e refresh de SDKs oficiais.                                                                                                                                                                                            |
| `v04.03.02`      | 11/06/2026    | Endurece redaction de persistência, guards de sessão finalizada, identity gates e rotação de tokens sem plaintext no payload.                                                                                                                                                                                         |
| `v04.03.01`      | 05/06/2026    | Restringe skip por `provider_error` a falhas retryable e melhora diagnóstico de overload do Anthropic.                                                                                                                                                                                                                |
| `v04.03.00`      | 05/06/2026    | Adiciona disposition de evidência pendente, eval offline por fixtures e relatório agregado de confiabilidade por peer.                                                                                                                                                                                                |
| `v04.02.05`      | 05/06/2026    | Endurece auditoria de sessões com eventos terminais, split de custo, visibilidade de `not_resurfaced` e proveniência do relator.                                                                                                                                                                                      |
| `v04.02.04`      | 05/06/2026    | Torna o truthfulness preflight mais auditável, adiciona reteste local e reduz falsos warnings de evidência anexada/logs.                                                                                                                                                                                              |
| `v04.02.03`      | 03/06/2026    | Promove Gemini 3.1 Pro Preview como pin canônico e atualiza o rate card Gemini local.                                                                                                                                                                                                                                 |
| `v04.02.02`      | 02/06/2026    | Atualiza pins Claude/Grok, corrige probe Perplexity e refresca rate cards conforme documentação oficial dos providers.                                                                                                                                                                                                |
| `v04.02.01`      | 21/05/2026    | Publica cleanup de hard-gate como pacote `4.2.1`, com ajustes de strict TypeScript, dependências e `tsconfig.base.json` local.                                                                                                                                                                                        |
| `v04.02.00`      | 17/05/2026    | Lista de sessões paginada, cancelamento sem abortar sessão indevidamente e resposta Markdown de `session_init`.                                                                                                                                                                                                       |
| `v04.01.00`      | 17/05/2026    | Hardening de concorrência do session-store, redaction de chaves privadas truncadas e remoção de busy-wait.                                                                                                                                                                                                            |
| `v04.00.00`      | 15/05/2026    | Renomeia o projeto para `cross-review`; o antigo `cross-review-v2` vira histórico.                                                                                                                                                                                                                                    |
| `v03.07.x`       | 14–15/05/2026 | Série de auditorias operacionais, logs/sessions study, política sem fallback silencioso e correções de runtime.                                                                                                                                                                                                       |
| `v03.03.00`      | 12/05/2026    | Trava seleção de peers pelo caller; todos os peers configurados participam conforme diretiva do operador.                                                                                                                                                                                                             |
| `v03.01.00`      | 12/05/2026    | Introduz `config.json` central para reduzir centenas de variáveis duplicadas em hosts MCP.                                                                                                                                                                                                                            |
| `v03.00.00`      | 12/05/2026    | Perplexity entra como sexto peer.                                                                                                                                                                                                                                                                                     |
| `v02.28.00`      | 12/05/2026    | Cache de lookup de variáveis do registro do Windows para reduzir cold start.                                                                                                                                                                                                                                          |
| `v02.25.00`      | 10/05/2026    | Adiciona modo deliberativo `circular`.                                                                                                                                                                                                                                                                                |
| `v02.21.00`      | 09/05/2026    | Prompt caching cross-provider.                                                                                                                                                                                                                                                                                        |
| `v02.18.00`      | 05/05/2026    | Caller capability tokens.                                                                                                                                                                                                                                                                                             |
| `v02.17.00`      | 05/05/2026    | Rejeição de identity forgery como hard gate.                                                                                                                                                                                                                                                                          |
| `v02.11.00`      | 04/05/2026    | Relator lottery e auto-wire shadow.                                                                                                                                                                                                                                                                                   |
| `v02.08.00`      | 03/05/2026    | Health por peer e ciclo do Evidence Broker.                                                                                                                                                                                                                                                                           |
| `v02.03.00`      | 01/05/2026    | `review_focus` provider-neutral.                                                                                                                                                                                                                                                                                      |
| `v02.02.00`      | 30/04/2026    | Streaming de tokens dos provedores.                                                                                                                                                                                                                                                                                   |
| `v02.01.00`      | 30/04/2026    | Primeira release estável.                                                                                                                                                                                                                                                                                             |
| `v2.0.0-alpha.0` | 2026-04       | Implementação inicial API/SDK-only do servidor MCP.                                                                                                                                                                                                                                                                   |

## Checklist operacional recomendado

Antes de usar uma revisão como gate:

- confirmar `server_info` no runtime carregado;
- confirmar `paid_calls_ready`;
- confirmar peers habilitados;
- fornecer evidência objetiva inline ou no campo `evidence`;
- definir `review_focus` com escopo claro;
- usar `session_start_*` para trabalhos longos;
- ler `session_check_convergence` ou `session_report` antes de declarar pronto;
- preservar `session_id` no registro de decisão.

## Fontes verificadas para esta apresentação

- Contrato runtime do source target: regressões preparadas em 22/07/2026. O
  runtime 4.5.8 foi confirmado após o reload daquela auditoria; o source/release
  target atual é 4.5.27. `server_info` continua sendo a autoridade para cada
  janela depois do upgrade e reload.
- `package.json` do repositório local.
- `README.md`.
- `CHANGELOG.md`.
- `docs/architecture.md`.
- `docs/api-keys.md`.
- `docs/costs.md`.
- `docs/evidence-preflight.md`.
- `docs/model-selection.md`.
- `docs/caching.md`.
- `src/core/config.ts`.
- `src/core/file-config.ts`.
- `src/core/convergence.ts`.
- `src/mcp/server.ts`.
- `src/peers/registry.ts`.
- `src/core/status.ts`.
- `npm view @lcv-ideas-software/cross-review` no registry público npm,
  verificado em 10/07/2026.
- Documentação oficial dos seis provedores, com links diretos em
  `docs/model-selection.md`, `docs/costs.md` e `docs/caching.md`, verificada em
  10/07/2026.
