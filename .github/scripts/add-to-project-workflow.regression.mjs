import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/add-to-project.yml", "utf8");

// O gatilho privilegiado pull_request_target so e aceitavel enquanto o workflow
// permanecer metadata-only: nenhum checkout, nenhuma action local, nenhum cache ou
// artifact, nenhum passo run. Qualquer edicao futura que quebre uma destas
// assercoes invalida a excecao dangerous-triggers documentada na linha do gatilho.
test("the privileged projects workflow never executes PR-controlled code", () => {
  assert.match(workflow, /pull_request_target: # zizmor: ignore\[dangerous-triggers\]/);
  assert.doesNotMatch(
    workflow,
    /actions\/checkout|actions\/cache|download-artifact|upload-artifact|uses:\s*\.\/|continue-on-error:|^\s*(?:-\s*)?run:/m,
  );
});

test("the projects workflow keeps the empty token grant and the confined key", () => {
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.doesNotMatch(workflow, /permissions:\s*write-all/);
  assert.match(workflow, /^ {4}permissions: \{\}$/m);
  assert.match(workflow, /^ {4}environment: projects-automation$/m);
  assert.match(workflow, /^ {4}timeout-minutes: 10$/m);
});

test("the projects workflow uses exactly the two pinned metadata actions", () => {
  const uses = [...workflow.matchAll(/^\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
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

// A assercao do invariante so bloqueia merge se o job dedicado alimentar o contexto
// exigido: precisa estar no needs do agregador e em toda condicao de resultado.
test("the boundary job feeds the required aggregator", () => {
  assert.match(carrier, /^ {2}projects_workflow_boundaries:$/m);
  const bloco = carrier.slice(carrier.indexOf("  projects_workflow_boundaries:"));
  assert.doesNotMatch(bloco, /^ {4}if:/m);
  assert.match(carrier, /needs:[\s\S]{0,200}- projects_workflow_boundaries/);
  assert.match(carrier, /needs\.projects_workflow_boundaries\.result != 'success'/);
  assert.match(carrier, /needs\.projects_workflow_boundaries\.result == 'success'/);
});
