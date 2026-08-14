import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/add-to-project.yml", "utf8");

// O gatilho privilegiado pull_request_target so e aceitavel enquanto o workflow
// permanecer metadata-only. Banimento absoluto de token, imune a estilo flow
// ("- { run: x }", "run :"): o workflow legitimo nao contem NENHUMA destas
// formas, logo qualquer ocorrencia — em qualquer sintaxe YAML — e violacao.
test("the privileged projects workflow never executes PR-controlled code", () => {
  assert.match(workflow, /pull_request_target: # zizmor: ignore\[dangerous-triggers\]/);
  assert.doesNotMatch(workflow, /\brun\s*:/);
  assert.doesNotMatch(workflow, /actions\/checkout|actions\/cache/);
  assert.doesNotMatch(workflow, /download-artifact|upload-artifact/);
  assert.doesNotMatch(workflow, /continue-on-error/);
  assert.doesNotMatch(workflow, /uses\s*:\s*["']?\.\//);
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
  const uses = [...workflow.matchAll(/uses\s*:\s*["']?([^\s,"'}\]]+)/g)].map((m) => m[1]);
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
// gate de origem, (2) o agregador exigido rodar para TODA origem — job exigido
// que fica skipped conta como aprovado para o ruleset — e (3) o resultado do
// job dedicado for exigido incondicionalmente em rejeicao e preservacao.
test("the boundary job feeds the required aggregator for every origin", () => {
  assert.match(carrier, /^ {2}projects_workflow_boundaries:$/m);
  const bloco = carrier.slice(carrier.indexOf("  projects_workflow_boundaries:"));
  assert.doesNotMatch(bloco, /^ {4}if:/m);
  const agregador = carrier.slice(
    carrier.indexOf("  dependency_review:"),
    carrier.indexOf("  projects_workflow_boundaries:"),
  );
  assert.match(agregador, /^ {4}if: \$\{\{ always\(\) \}\}$/m);
  assert.match(agregador, /needs:[\s\S]{0,200}- projects_workflow_boundaries/);
  assert.match(agregador, /needs\.projects_workflow_boundaries\.result != 'success' \|\|/);
  assert.match(agregador, /needs\.projects_workflow_boundaries\.result == 'success' &&/);
});
