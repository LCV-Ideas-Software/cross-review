import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/add-to-project.yml", "utf8");

// Normalizacao anti-evasao: YAML aceita a MESMA chave em varias grafias (por
// exemplo, - "run": cmd equivale a - run: cmd). Sem parser de YAML disponivel,
// o banimento textual so e integro se (1) chaves com aspas forem normalizadas
// para a forma plana antes dos banimentos e (2) toda mecanica YAML capaz de
// disfarcar uma chave — escapes, ancoras, aliases, merge keys, tags, chaves
// complexas, diretivas — for banida em absoluto: o workflow legitimo nao usa
// nenhuma delas, logo qualquer ocorrencia e violacao.
const normalized = workflow.replace(/(["'])([\w-]+)\1(\s*:)/g, "$2$3");

test("the privileged projects workflow never executes PR-controlled code", () => {
  assert.match(workflow, /pull_request_target: # zizmor: ignore\[dangerous-triggers\]/);
  assert.doesNotMatch(normalized, /\brun\s*:/);
  assert.doesNotMatch(normalized, /actions\/checkout|actions\/cache/);
  assert.doesNotMatch(normalized, /download-artifact|upload-artifact/);
  assert.doesNotMatch(normalized, /continue-on-error/);
  assert.doesNotMatch(normalized, /uses\s*:\s*\.\//);
  assert.doesNotMatch(normalized, /\bcontainer\s*:/);
  assert.doesNotMatch(normalized, /\bservices\s*:/);
});

test("the projects workflow bans YAML mechanics that could disguise a key", () => {
  assert.doesNotMatch(workflow, /\\x|\\u|\\N\{/);
  assert.doesNotMatch(workflow, /&[A-Za-z]|\*[A-Za-z]/);
  assert.doesNotMatch(workflow, /^\s*\?/m);
  assert.doesNotMatch(workflow, /^\s*<</m);
  assert.doesNotMatch(workflow, /!![A-Za-z]/);
  assert.doesNotMatch(workflow, /^%/m);
});

test("the projects workflow keeps the empty token grant and the confined key", () => {
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.doesNotMatch(workflow, /permissions:\s*write-all/);
  assert.match(workflow, /^ {4}permissions: \{\}$/m);
  assert.match(
    workflow,
    /^ {4}environment:\n {6}name: projects-automation\n {6}deployment: false$/m,
  );
  assert.match(workflow, /^ {4}timeout-minutes: 10$/m);
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

// A assercao do invariante so bloqueia merge se: (1) o job dedicado nao tiver
// gate de origem; (2) o verificador vier do ref base protegido, nunca apenas da
// arvore do candidato — um PR que altere o workflow privilegiado E o proprio
// verificador nao pode se auto-aprovar; (3) o agregador exigido rodar para TODA
// origem com token somente-leitura (job exigido skipped conta como aprovado); e
// (4) cada passo do agregador exigir o resultado do job dedicado
// independentemente — uma unica ocorrencia nao prova os tres passos.
test("the boundary job feeds the required aggregator for every origin", () => {
  assert.match(carrier, /^ {2}projects_workflow_boundaries:$/m);
  const bloco = carrier.slice(carrier.indexOf("  projects_workflow_boundaries:"));
  assert.doesNotMatch(bloco, /^ {4}if:/m);
  assert.match(bloco, /ref: main/);
  assert.match(bloco, /path: \.trusted-boundary/);
  assert.match(bloco, /\.trusted-boundary\/\$\{verificador\}/);
  const agregador = carrier.slice(
    carrier.indexOf("  dependency_review:"),
    carrier.indexOf("  projects_workflow_boundaries:"),
  );
  assert.match(agregador, /^ {4}if: \$\{\{ always\(\) \}\}$/m);
  assert.match(agregador, /^ {4}permissions: read-all$/m);
  assert.doesNotMatch(agregador, /write-all/);
  assert.match(agregador, /needs:[\s\S]{0,200}- projects_workflow_boundaries/);
  const passos = agregador.split(/^ {6}- name: /m).slice(1);
  const reject = passos.find((p) => p.startsWith("Reject"));
  const preserve = passos.find((p) => p.startsWith("Preserve"));
  const enforce = passos.find((p) => p.startsWith("Enforce"));
  assert.ok(reject && preserve && enforce, "aggregator steps missing");
  assert.match(reject, /needs\.projects_workflow_boundaries\.result != 'success' \|\|/);
  assert.match(preserve, /needs\.projects_workflow_boundaries\.result == 'success' &&/);
  assert.match(enforce, /needs\.projects_workflow_boundaries\.result == 'success'/);
});
