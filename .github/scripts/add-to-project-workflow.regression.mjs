import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/add-to-project.yml", "utf8");

// Normalizacao anti-evasao: YAML aceita a MESMA chave em varias grafias.
// Chaves com aspas sao normalizadas para a forma plana antes de todo exame.
const normaliza = (s) => s.replace(/(["'])([\w-]+)\1(\s*:)/g, "$2$3");
const normalized = normaliza(workflow);

// O martelo: o workflow privilegiado precisa casar EXATAMENTE com o template
// aprovado — linha a linha, do inicio ao fim. So o numero do quadro do
// repositorio varia. Qualquer passo, input (ex.: github-api-url), env, comentario
// ou grafia YAML fora do template reprova, o que fecha por construcao toda a
// classe de contrabando textual (chaves explicitas, escapes, continuacoes,
// inputs novos em actions pinadas).
const ESPERADO = [
  "name: Add to project",
  "",
  "# Coloca toda issue e todo pull request nos quadros do repositorio e do portfolio.",
  "# Inerte enquanto a variavel LCV_PROJECTS_APP_CLIENT_ID nao estiver definida na organizacao.",
  "#",
  "# Pre-requisito (acao do operador): GitHub App da organizacao instalado neste repositorio.",
  "# O passo de mint abaixo solicita tres permissoes e o token NAO e emitido se a instalacao",
  "# nao conceder cada uma delas:",
  "#   - projects de organizacao: leitura e escrita (permissao de projects de repositorio nao basta)",
  "#   - issues: leitura",
  "#   - pull requests: leitura",
  "# Alem do App, precisam existir:",
  "#   - variavel de organizacao LCV_PROJECTS_APP_CLIENT_ID",
  "#   - secret LCV_PROJECTS_APP_PRIVATE_KEY no environment 'projects-automation' deste repo",
  "# GITHUB_TOKEN nao acessa Projects v2, por isso o App e obrigatorio.",
  "#",
  "# Backfill na ativacao (uma unica vez): definir a variavel NAO reprocessa eventos",
  "# passados — issues/PRs abertos enquanto o workflow esteve inerte nao entram nos quadros",
  "# por este gatilho. Ao ativar, adicionar aos dois quadros os itens abertos que ainda nao",
  "# estejam neles (addProjectV2ItemById), conforme checklist da issue de rastreamento desta",
  "# implantacao.",
  "#",
  "# Por que pull_request_target: o evento pull_request nao entrega secrets a PR de fork nem",
  "# do Dependabot, e o mint da chave do App falharia exatamente nos PRs externos. Este",
  "# workflow roda no contexto da base, usa somente metadados do evento e NAO faz checkout",
  "# nem executa codigo do PR. Essa invariante e o que mantem o gatilho privilegiado seguro",
  "# e justifica a excecao estreita do zizmor na linha do gatilho. Se algum passo futuro",
  "# precisar de checkout, a excecao deixa de valer e o gatilho deve voltar a pull_request.",
  "",
  "on:",
  "  issues:",
  "    # transferred cobre a issue transferida PARA este repositorio: o README da action",
  "    # pinada lista o evento como o caminho suportado para \"Issues... transferred into",
  "    # your repository\", e a adicao e idempotente (re-adicionar devolve o mesmo item).",
  "    types: [opened, reopened, transferred]",
  "  pull_request_target: # zizmor: ignore[dangerous-triggers] -- sem checkout e sem execucao de codigo do PR; somente metadados; secrets necessarios para PR de fork/Dependabot",
  "    types: [opened, reopened, ready_for_review]",
  "",
  "# Scorecard TokenPermissions exige um bloco permissions em escopo de workflow; a politica",
  "# enterprise revogou write-all (Discussion .github#150, 11/08/2026). Nenhum passo deste",
  "# workflow usa o GITHUB_TOKEN — o token do App e emitido e repassado explicitamente —,",
  "# entao o conjunto vazio e o privilegio minimo real.",
  "permissions: {}",
  "",
  "env:",
  "  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: \"true\"",
  "",
  "concurrency:",
  "  group: add-to-project-${{ github.event.issue.number || github.event.pull_request.number }}",
  "  cancel-in-progress: false",
  "",
  "jobs:",
  "  add:",
  "    name: Add item to projects",
  "    if: ${{ vars.LCV_PROJECTS_APP_CLIENT_ID != '' }}",
  "    runs-on: ubuntu-latest",
  "    timeout-minutes: 10",
  "    permissions: {}",
  "    # Confina a chave privada do App a este job (zizmor secrets-outside-env).",
  "    # Mesmo padrao ja usado pela organizacao para credenciais de automacao.",
  "    # deployment: false — usa os secrets do environment sem criar um deployment",
  "    # object por evento de issue/PR (senao cada evento polui o historico de",
  "    # deployments e aciona integracoes de deployment).",
  "    environment:",
  "      name: projects-automation",
  "      deployment: false",
  "    steps:",
  "      - name: Mint installation token",
  "        id: token",
  "        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0",
  "        env:",
  "          # zizmor secrets-outside-env: segredo so pode ser referenciado via env",
  "          APP_PRIVATE_KEY: ${{ secrets.LCV_PROJECTS_APP_PRIVATE_KEY }}",
  "        with:",
  "          client-id: ${{ vars.LCV_PROJECTS_APP_CLIENT_ID }}",
  "          private-key: ${{ env.APP_PRIVATE_KEY }}",
  "          owner: ${{ github.repository_owner }}",
  "          # zizmor github-app: token restrito a este repositorio e as permissoes minimas",
  "          repositories: ${{ github.event.repository.name }}",
  "          permission-organization-projects: write",
  "          permission-issues: read",
  "          permission-pull-requests: read",
  "",
  "      - name: Add to repository project",
  "        uses: actions/add-to-project@5afcf98fcd03f1c2f92c3c83f58ae24323cc57fd # v2.0.0",
  "        with:",
  "          project-url: https://github.com/orgs/LCV-Ideas-Software/projects/__QUADRO__",
  "          github-token: ${{ steps.token.outputs.token }}",
  "",
  "      - name: Add to portfolio project",
  "        uses: actions/add-to-project@5afcf98fcd03f1c2f92c3c83f58ae24323cc57fd # v2.0.0",
  "        with:",
  "          project-url: https://github.com/orgs/LCV-Ideas-Software/projects/17",
  "          github-token: ${{ steps.token.outputs.token }}",
].join("\n");
const template = new RegExp(
  "^" +
    ESPERADO.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(
      "__QUADRO__",
      "\\d+",
    ) +
    "\\n$",
);

test("the privileged projects workflow matches its approved template exactly", () => {
  assert.match(workflow, template);
});

// Cinturao (documenta a intencao e sobrevive a evolucao do template):
test("the privileged projects workflow never executes PR-controlled code", () => {
  assert.match(workflow, /pull_request_target: # zizmor: ignore\[dangerous-triggers\]/);
  assert.doesNotMatch(normalized, /\brun\s*:/);
  assert.doesNotMatch(normalized, /actions\/checkout|actions\/cache/);
  assert.doesNotMatch(normalized, /download-artifact|upload-artifact/);
  assert.doesNotMatch(normalized, /continue-on-error/);
  assert.doesNotMatch(normalized, /uses\s*:\s*\.\//);
  assert.doesNotMatch(normalized, /\bcontainer\s*:/);
  assert.doesNotMatch(normalized, /\bservices\s*:/);
  assert.doesNotMatch(normalized, /NODE_OPTIONS/i);
  const envKeys = [...normalized.matchAll(/^\s*([A-Z][A-Z0-9_]+)\s*:/gm)].map(
    (m) => m[1],
  );
  assert.deepEqual(envKeys, [
    "FORCE_JAVASCRIPT_ACTIONS_TO_NODE24",
    "APP_PRIVATE_KEY",
  ]);
});

test("the projects workflow bans YAML mechanics that could disguise a key", () => {
  assert.doesNotMatch(workflow, /\\/);
  assert.doesNotMatch(workflow, /&/);
  assert.doesNotMatch(workflow, /\*/);
  assert.doesNotMatch(workflow, /\?/);
  assert.doesNotMatch(workflow, /^\s*<</m);
  assert.doesNotMatch(workflow, /!![A-Za-z]/);
  assert.doesNotMatch(workflow, /^%/m);
});

test("the projects workflow uses exactly the two pinned metadata actions", () => {
  const uses = [...normalized.matchAll(/uses\s*:\s*["']?([^\s,"'}\]]+)/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(uses, [
    "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
    "actions/add-to-project@5afcf98fcd03f1c2f92c3c83f58ae24323cc57fd",
    "actions/add-to-project@5afcf98fcd03f1c2f92c3c83f58ae24323cc57fd",
  ]);
});

test("inbound transfers stay covered, per the pinned action contract", () => {
  assert.match(workflow, /types: \[opened, reopened, transferred\]/);
});

const carrier = readFileSync(".github/workflows/dependency-review.yml", "utf8");
const carrierNorm = normaliza(carrier);

// Predicados canonicos do agregador — unica forma aceita por passo, em bloco
// contiguo (comentario nao satisfaz: o passo nao pode conter '#', e o passo
// tem exatamente UM if, que precisa ser o bloco canonico inteiro).
const REJECT_Q = [
 "        if: >-",
 "          ${{",
 "            needs.projects_workflow_boundaries.result != 'success' ||",
 "            (",
 "              (",
 "                github.event_name == 'merge_group' ||",
 "                github.event.pull_request.head.repo.full_name == github.repository",
 "              ) &&",
 "              (",
 "                needs.workflow_boundaries.result != 'success' ||",
 "                needs.candidate_review.result != 'success'",
 "              )",
 "            )",
 "          }}",
].join("\n");
const REJECT_O = [
 "        if: >-",
 "          ${{",
 "            needs.projects_workflow_boundaries.result != 'success' ||",
 "            (",
 "              (",
 "                github.event_name == 'merge_group' ||",
 "                github.event.pull_request.head.repo.full_name == github.repository",
 "              ) &&",
 "              needs.candidate_review.result != 'success'",
 "            )",
 "          }}",
].join("\n");
const PRESERVE_Q = [
 "        if: >-",
 "          ${{",
 "            github.event_name != 'merge_group' &&",
 "            needs.projects_workflow_boundaries.result == 'success' &&",
 "            (",
 "              github.event.pull_request.head.repo.full_name != github.repository ||",
 "              (",
 "                needs.workflow_boundaries.result == 'success' &&",
 "                needs.candidate_review.result == 'success'",
 "              )",
 "            )",
 "          }}",
].join("\n");
const PRESERVE_O = [
 "        if: >-",
 "          ${{",
 "            github.event_name != 'merge_group' &&",
 "            needs.projects_workflow_boundaries.result == 'success' &&",
 "            (",
 "              github.event.pull_request.head.repo.full_name != github.repository ||",
 "              needs.candidate_review.result == 'success'",
 "            )",
 "          }}",
].join("\n");
const ENFORCE_Q = [
 "        if: >-",
 "          ${{",
 "            github.event_name == 'merge_group' &&",
 "            needs.workflow_boundaries.result == 'success' &&",
 "            needs.candidate_review.result == 'success' &&",
 "            needs.projects_workflow_boundaries.result == 'success'",
 "          }}",
].join("\n");
const ENFORCE_O = [
 "        if: ${{ github.event_name == 'merge_group' && needs.candidate_review.result == 'success' && needs.projects_workflow_boundaries.result == 'success' }}",
].join("\n");

const TRUSTED_CHECKOUT = [
  '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
  '        with:',
  '          persist-credentials: false',
  '          ref: main',
  '          path: .trusted-boundary',
].join("\n");

test("the boundary job feeds the required aggregator for every origin", () => {
  assert.match(carrierNorm, /^ {2}projects_workflow_boundaries:$/m);
  const bloco = carrierNorm.slice(
    carrierNorm.indexOf("  projects_workflow_boundaries:"),
  );
  assert.doesNotMatch(bloco, /^\s*if\s*:/m);
  assert.doesNotMatch(bloco, /continue-on-error/);
  assert.ok(bloco.includes(TRUSTED_CHECKOUT), "trusted checkout block missing");
  assert.match(bloco, /\.trusted-boundary\/\$\{verificador\}/);
  const agregador = carrierNorm.slice(
    carrierNorm.indexOf("  dependency_review:"),
    carrierNorm.indexOf("  projects_workflow_boundaries:"),
  );
  assert.match(agregador, /^ {4}if: \$\{\{ always\(\) \}\}$/m);
  assert.match(agregador, /^ {4}permissions: read-all$/m);
  assert.doesNotMatch(agregador, /write-all/);
  assert.match(agregador, /needs:[\s\S]{0,200}- projects_workflow_boundaries/);
  const passos = agregador.split(/^ {6}- name: /m).slice(1);
  const casos = [
    ["Reject", [REJECT_Q, REJECT_O]],
    ["Preserve", [PRESERVE_Q, PRESERVE_O]],
    ["Enforce", [ENFORCE_Q, ENFORCE_O]],
  ];
  for (const [prefixo, formas] of casos) {
    const passo = passos.find((p) => p.startsWith(prefixo));
    assert.ok(passo, prefixo + " step missing");
    const ifs = passo.match(/\bif\s*:/g) || [];
    assert.equal(ifs.length, 1, prefixo + " step must have exactly one if");
    assert.ok(
      formas.some((f) => passo.includes(f.replace(/^\n/, ""))),
      prefixo + " predicate is not canonical",
    );
  }
});
