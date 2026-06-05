# Apresentação do cross-review

Data de referência desta apresentação: 2026-06-05.

Este documento apresenta o `cross-review` para dois públicos:

- pessoas que precisam entender o que ele é, por que existe e como funciona em
  linguagem acessível;
- profissionais de TI e desenvolvimento que precisam instalar, configurar,
  operar, auditar ou integrar o servidor MCP.

As informações abaixo acompanham a release do repositório. Em uma sessão MCP já
carregada, consulte `server_info` para confirmar a versão runtime efetivamente
ativa; após atualização global por npm, o host MCP ainda precisa ser
recarregado para refletir a nova versão.

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

O produto atual é estável. A release de referência reporta:

| Campo                      | Valor atual                         |
| -------------------------- | ----------------------------------- |
| Nome                       | `cross-review`                      |
| Publicador                 | `LCV Ideas & Software`              |
| Versão runtime             | `4.3.0`                             |
| Release date runtime       | `2026-06-05`                        |
| Pacote npm                 | `@lcv-ideas-software/cross-review`  |
| Versão npm publicada       | `4.3.0`                             |
| Transporte MCP             | `stdio`                             |
| Execução CLI por peers     | desativada                          |
| Modo padrão                | chamadas reais de API               |
| Diretório de dados runtime | `C:\Users\leona\.cross-review\data` |

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
| `perplexity` | Perplexity | Sonar API                        |

Os nomes dos peers são estáveis dentro do protocolo. A configuração de modelos
usa variáveis específicas por provedor, mas as sessões e respostas se referem
aos peers por esses IDs.

## Modelos canônicos atuais

O projeto usa pinos canônicos para evitar downgrade silencioso. Os valores
documentados no repositório atual são:

| Peer         | Modelo padrão            | Override                        |
| ------------ | ------------------------ | ------------------------------- |
| `codex`      | `gpt-5.5`                | `CROSS_REVIEW_OPENAI_MODEL`     |
| `claude`     | `claude-opus-4-8`        | `CROSS_REVIEW_ANTHROPIC_MODEL`  |
| `gemini`     | `gemini-3.1-pro-preview` | `CROSS_REVIEW_GEMINI_MODEL`     |
| `deepseek`   | `deepseek-v4-pro`        | `CROSS_REVIEW_DEEPSEEK_MODEL`   |
| `grok`       | `grok-4.3`               | `CROSS_REVIEW_GROK_MODEL`       |
| `perplexity` | `sonar-reasoning-pro`    | `CROSS_REVIEW_PERPLEXITY_MODEL` |

Overrides devem ser decisão explícita do operador. A proposta do sistema é
priorizar correção, rastreabilidade e profundidade de raciocínio, não custo ou
latência mínimos.

## Ferramentas MCP

A superfície MCP da release expõe as seguintes ferramentas:

| Ferramenta                              | Uso principal                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| `server_info`                           | Inspeciona versão, diretório de dados, capacidades, budget, peers e segurança ativa. |
| `runtime_capabilities`                  | Retorna contrato de capacidades e lista de ferramentas.                              |
| `probe_peers`                           | Consulta provedores para verificar reachability e modelos disponíveis.               |
| `session_init`                          | Cria uma sessão durável sem chamar reviewers.                                        |
| `session_list`                          | Lista sessões de forma paginada e resumida.                                          |
| `session_read`                          | Lê o `meta.json` completo de uma sessão.                                             |
| `ask_peers`                             | Executa uma rodada real de revisão.                                                  |
| `session_start_round`                   | Inicia rodada em background e devolve `session_id`/`job_id`.                         |
| `run_until_unanimous`                   | Gera/revisa até unanimidade, limite de rodadas ou bloqueio.                          |
| `session_start_unanimous`               | Versão background do fluxo até unanimidade.                                          |
| `session_cancel_job`                    | Solicita cancelamento cooperativo de job em execução.                                |
| `session_recover_interrupted`           | Recupera sessões interrompidas.                                                      |
| `session_poll`                          | Consulta progresso de job em background.                                             |
| `session_events`                        | Lê eventos duráveis da sessão.                                                       |
| `session_metrics`                       | Retorna métricas agregadas ou de uma sessão.                                         |
| `session_doctor`                        | Audita sessões abertas, travadas ou historicamente inconsistentes.                   |
| `session_report`                        | Gera relatório Markdown de uma sessão.                                               |
| `session_peer_reliability_report`       | Agrega sinais de confiabilidade por peer sem alterar seleção ou estado de sessão.    |
| `session_check_convergence`             | Retorna estado de convergência durável sem chamar provedores.                        |
| `session_truthfulness_preflight_check`  | Reexecuta localmente o truthfulness preflight de uma sessão sem chamar provedores.   |
| `session_attach_evidence`               | Anexa evidência textual à sessão.                                                    |
| `session_evidence_checklist_update`     | Atualiza status de itens de evidência.                                               |
| `session_evidence_judge_pass`           | Usa um peer como juiz de evidência em modo controlado.                               |
| `session_evidence_judge_consensus_pass` | Juízo de evidência por consenso entre peers.                                         |
| `session_judgment_precision_report`     | Mede precisão/recall/F1 dos julgamentos shadow.                                      |
| `contest_verdict`                       | Contesta verdict final e abre novo ciclo com cadeia de custódia.                     |
| `escalate_to_operator`                  | Registra necessidade de julgamento humano.                                           |
| `regenerate_caller_tokens`              | Rotaciona tokens locais de identidade por host.                                      |
| `session_sweep`                         | Finaliza sessões inativas e limpa históricos conforme política.                      |
| `session_finalize`                      | Marca sessão como `converged`, `aborted` ou `max-rounds`.                            |

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
npm install -g @lcv-ideas-software/cross-review
```

### Instalação via GitHub Packages

```bash
npm install -g @lcv-ideas-software/cross-review --registry=https://npm.pkg.github.com
```

Dependendo do ambiente, GitHub Packages pode exigir autenticação npm
configurada para o escopo `@lcv-ideas-software`.

### Instalação local para desenvolvimento

```bash
npm install
npm --registry=https://registry.npmjs.org run build
node dist/src/mcp/server.js
```

### Smoke tests locais sem custo

```powershell
$env:CROSS_REVIEW_STUB = "1"
$env:CROSS_REVIEW_STUB_CONFIRMED = "1"
npm --registry=https://registry.npmjs.org test
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

Perplexity também pode exigir taxas por requisição conforme tamanho de contexto
de busca; nesses casos, configure os campos
`CROSS_REVIEW_PERPLEXITY_REQUEST_FEE_*_USD_PER_1000_REQUESTS`.

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
| `CROSS_REVIEW_PEER_<NAME>`                 | Habilita ou desabilita peer específico com `on`/`off`.      |
| `CROSS_REVIEW_STUB`                        | Ativa stubs quando combinado com confirmação explícita.     |
| `CROSS_REVIEW_STUB_CONFIRMED`              | Confirma uso deliberado de stubs.                           |
| `CROSS_REVIEW_CALLER_TOKEN`                | Token de identidade do host caller.                         |
| `CROSS_REVIEW_REQUIRE_TOKEN`               | Exige token de caller quando ativo.                         |

## Dependências

### Runtime

Dependências diretas de runtime declaradas no `package.json` atual:

| Pacote                      | Versão declarada | Uso                               |
| --------------------------- | ---------------- | --------------------------------- |
| `@anthropic-ai/sdk`         | `^0.97.1`        | Cliente Anthropic/Claude.         |
| `@google/genai`             | `^2.5.0`         | Cliente Google Gemini.            |
| `@modelcontextprotocol/sdk` | `^1.29.0`        | Implementação MCP.                |
| `openai`                    | `^6.38.0`        | OpenAI e APIs compatíveis.        |
| `pino`                      | `^10.3.1`        | Logging estruturado.              |
| `proper-lockfile`           | `^4.1.2`         | Locking de sessão multi-processo. |
| `zod`                       | `^4.4.3`         | Validação de schemas.             |

### Desenvolvimento

Dependências diretas de desenvolvimento:

| Pacote                   | Versão declarada | Uso                                 |
| ------------------------ | ---------------- | ----------------------------------- |
| `@biomejs/biome`         | `^2.4.15`        | Lint/format complementar.           |
| `@eslint/js`             | `^10.0.1`        | ESLint base.                        |
| `@types/node`            | `^25.9.1`        | Tipos Node.js.                      |
| `@types/proper-lockfile` | `^4.1.4`         | Tipos do `proper-lockfile`.         |
| `eslint`                 | `^10.4.0`        | Lint.                               |
| `eslint-config-prettier` | `^10.1.8`        | Integração ESLint/Prettier.         |
| `prettier`               | `^3.8.3`         | Formatação.                         |
| `tsx`                    | `^4.22.3`        | Execução TypeScript em scripts/dev. |
| `typescript`             | `^6.0.3`         | Build e typecheck.                  |
| `typescript-eslint`      | `^8.59.4`        | Regras TypeScript para ESLint.      |

## Scripts do projeto

Os scripts principais são `build`, `dev`, `dashboard`, `smoke`,
`runtime-smoke`, `api-streaming-smoke`, `test`, `lint`, `format:check`,
`typecheck`, `biome` e `check`. O script `check` reúne formatação, lint, Biome e
typecheck; `test` executa build, smoke e runtime smoke.

## Persistência e observabilidade

O runtime grava estado fora do repositório, no `data_dir` configurado. Nesta
máquina, o runtime carregado reportou:

```text
C:\Users\leona\.cross-review\data
```

Esse diretório contém sessões, eventos, logs, tokens locais de host e relatórios.
O `server_info` também informa o arquivo de log NDJSON ativo por processo.

Arquivos típicos por sessão:

- `meta.json`: estado durável da sessão;
- `events.ndjson`: eventos incrementais;
- evidências anexadas via `session_attach_evidence`;
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
- capability tokens por caller podem vincular um host a uma identidade de agente;
- `operator` não deve ser forjado por um host que carrega token de agente;
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

| Provider  | Modo       |
| --------- | ---------- |
| OpenAI    | automático |
| Anthropic | explícito  |
| Gemini    | implícito  |
| DeepSeek  | automático |
| Grok      | automático |

A telemetria é normalizada em eventos `provider.cache.usage` e manifestos por
sessão. Operadores podem desligar o cache globalmente:

```powershell
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_DISABLE_CACHE", "true", "User")
```

Também há controles de TTL e versionamento de schema de cache, incluindo
`CROSS_REVIEW_CACHE_SCHEMA_VERSION`,
`CROSS_REVIEW_CACHE_TTL_ANTHROPIC` e `CROSS_REVIEW_CACHE_TTL_OPENAI`.

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
- `evidence`: evidência estruturada opcional em fluxos até unanimidade;
- `reasoning_effort_overrides`: ajuste pontual por peer quando necessário.

O campo `review_focus` é importante para reduzir ruído. Ele deve dizer
explicitamente o que revisar, o que não revisar e qual tipo de achado é
bloqueante.

### Identidade e anti-self-review

O runtime protege contra autoavaliação indevida. Um agente não deve atuar ao
mesmo tempo como caller, relator e peer votante na mesma sessão. O conjunto de
peers é controlado pelo servidor e pode ser travado por configuração para evitar
que o caller escolha uma banca conveniente.

Tokens de caller reforçam essa separação. Quando `CROSS_REVIEW_REQUIRE_TOKEN`
está ativo, hosts precisam apresentar `CROSS_REVIEW_CALLER_TOKEN` válido. A
rotação é feita por `regenerate_caller_tokens`, mas a redistribuição dos tokens
é uma operação sensível e deve ser tratada como segredo operacional.

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
- anexos persistidos por `session_attach_evidence`;
- logs relevantes.

Para revisões sérias, empacote evidência antes de chamar peers. O servidor não
deve ser tratado como coletor de repo, shell ou CI.

### Jobs assíncronos e timeouts

Chamadas reais podem superar timeouts comuns de hosts MCP. Para isso, prefira
ferramentas background:

- `session_start_round`;
- `session_start_unanimous`.

Depois consulte:

- `session_poll` para progresso;
- `session_events` para stream durável;
- `session_metrics` para custo e contadores;
- `session_report` para relatório final.

O timeout HTTP padrão por provedor é 30 minutos. O host MCP deve ter timeout
suficiente ou usar jobs assíncronos.

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
- publicação em tag `v*` ou dispatch manual;
- Pages, Scorecard, Socket, dependency review e automerge de Dependabot.

O gate de CI executa:

- Prettier;
- ESLint;
- Biome;
- TypeScript typecheck;
- smoke tests com stub confirmado.

O gate de publicação executa `npm run check`, `npm test`, valida metadata e
publica com provenance quando aplicável.

## Changelog breve

| Versão           | Data          | Destaque                                                                                                                         |
| ---------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `v04.03.00`      | 2026-06-05    | Adiciona disposition de evidência pendente, eval offline por fixtures e relatório agregado de confiabilidade por peer.           |
| `v04.02.05`      | 2026-06-05    | Endurece auditoria de sessões com eventos terminais, split de custo, visibilidade de `not_resurfaced` e proveniência do relator. |
| `v04.02.04`      | 2026-06-05    | Torna o truthfulness preflight mais auditável, adiciona reteste local e reduz falsos warnings de evidência anexada/logs.         |
| `v04.02.03`      | 2026-06-03    | Promove Gemini 3.1 Pro Preview como pin canônico e atualiza o rate card Gemini local.                                            |
| `v04.02.02`      | 2026-06-02    | Atualiza pins Claude/Grok, corrige probe Perplexity e refresca rate cards conforme documentação oficial dos providers.           |
| `v04.02.01`      | 2026-05-21    | Publica cleanup de hard-gate como pacote `4.2.1`, com ajustes de strict TypeScript, dependências e `tsconfig.base.json` local.   |
| `v04.02.00`      | 2026-05-17    | Lista de sessões paginada, cancelamento sem abortar sessão indevidamente e resposta Markdown de `session_init`.                  |
| `v04.01.00`      | 2026-05-17    | Hardening de concorrência do session-store, redaction de chaves privadas truncadas e remoção de busy-wait.                       |
| `v04.00.00`      | 2026-05-15    | Renomeia o projeto para `cross-review`; o antigo `cross-review-v2` vira histórico.                                               |
| `v03.07.x`       | 2026-05-14/15 | Série de auditorias operacionais, logs/sessions study, política sem fallback silencioso e correções de runtime.                  |
| `v03.03.00`      | 2026-05-12    | Trava seleção de peers pelo caller; todos os peers configurados participam conforme diretiva do operador.                        |
| `v03.01.00`      | 2026-05-12    | Introduz `config.json` central para reduzir centenas de variáveis duplicadas em hosts MCP.                                       |
| `v03.00.00`      | 2026-05-12    | Perplexity entra como sexto peer.                                                                                                |
| `v02.28.00`      | 2026-05-12    | Cache de lookup de variáveis do registro do Windows para reduzir cold start.                                                     |
| `v02.25.00`      | 2026-05-10    | Adiciona modo deliberativo `circular`.                                                                                           |
| `v02.21.00`      | 2026-05-09    | Prompt caching cross-provider.                                                                                                   |
| `v02.18.00`      | 2026-05-05    | Caller capability tokens.                                                                                                        |
| `v02.17.00`      | 2026-05-05    | Rejeição de identity forgery como hard gate.                                                                                     |
| `v02.11.00`      | 2026-05-04    | Relator lottery e auto-wire shadow.                                                                                              |
| `v02.08.00`      | 2026-05-03    | Health por peer e ciclo do Evidence Broker.                                                                                      |
| `v02.03.00`      | 2026-05-01    | `review_focus` provider-neutral.                                                                                                 |
| `v02.02.00`      | 2026-04-30    | Streaming de tokens dos provedores.                                                                                              |
| `v02.01.00`      | 2026-04-30    | Primeira release estável.                                                                                                        |
| `v2.0.0-alpha.0` | 2026-04       | Implementação inicial API/SDK-only do servidor MCP.                                                                              |

## Checklist operacional recomendado

Antes de usar uma revisão como gate:

- confirmar `server_info` no runtime carregado;
- confirmar `paid_calls_ready`;
- confirmar peers habilitados;
- anexar evidência objetiva;
- definir `review_focus` com escopo claro;
- usar `session_start_*` para trabalhos longos;
- ler `session_check_convergence` ou `session_report` antes de declarar pronto;
- preservar `session_id` no registro de decisão.

## Fontes verificadas para esta apresentação

- Runtime MCP `server_info` e `runtime_capabilities` carregados em 2026-05-22.
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
- `npm view @lcv-ideas-software/cross-review` no registry público npm.
