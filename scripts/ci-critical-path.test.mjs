import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readCiJobs() {
  const source = await fs.readFile(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  const workflow = parse(source, { uniqueKeys: true });
  assert.ok(workflow && typeof workflow.jobs === "object", "CI workflow must declare jobs");
  return workflow.jobs;
}

function dependenciesOf(job) {
  const needs = job?.needs;
  if (needs === undefined) return [];
  return Array.isArray(needs) ? needs : [needs];
}

function transitiveDependencies(jobs, name, visiting = new Set()) {
  assert.ok(jobs[name], `CI job ${name} must exist`);
  assert.ok(!visiting.has(name), `CI job dependency cycle includes ${name}`);
  const nextVisiting = new Set(visiting).add(name);
  const result = new Set();
  for (const dependency of dependenciesOf(jobs[name])) {
    assert.ok(jobs[dependency], `CI job ${name} depends on missing job ${dependency}`);
    result.add(dependency);
    for (const ancestor of transitiveDependencies(jobs, dependency, nextVisiting)) {
      result.add(ancestor);
    }
  }
  return result;
}

test("native verification and release candidates share prepared inputs without serializing", async () => {
  const jobs = await readCiJobs();

  assert.deepEqual(dependenciesOf(jobs["native-inputs"]), []);
  assert.deepEqual(dependenciesOf(jobs["native-isolation"]), ["native-inputs"]);
  assert.deepEqual(dependenciesOf(jobs["application-candidates"]), ["native-inputs"]);
  assert.deepEqual(dependenciesOf(jobs["npm-server-preflight"]), ["native-inputs"]);
  assert.deepEqual(dependenciesOf(jobs["packaged-acceptance"]), ["application-candidates"]);

  for (const candidate of ["application-candidates", "npm-server-preflight"]) {
    const ancestors = transitiveDependencies(jobs, candidate);
    assert.ok(ancestors.has("native-inputs"), `${candidate} must consume prepared native inputs`);
    assert.ok(
      !ancestors.has("native-isolation"),
      `${candidate} must not wait for the independent native verification matrix`
    );
  }
  assert.ok(
    transitiveDependencies(jobs, "packaged-acceptance").has("native-inputs"),
    "installed application acceptance must remain downstream of the native-backed candidate"
  );
});

test("application packaging captures production outputs before desktop template bootstrap", async () => {
  const jobs = await readCiJobs();
  const steps = jobs["application-candidates"].steps;
  const indexOf = (name) => {
    const index = steps.findIndex((step) => step.name === name);
    assert.notEqual(index, -1, `application-candidates must include step: ${name}`);
    return index;
  };

  assert.ok(
    indexOf("Package the application") < indexOf("Checkout Base template for desktop integration"),
    "the packaged app must capture production dist before template acquisition can rebuild it"
  );
  assert.ok(
    indexOf("Archive installed application layout") <
      indexOf("Acquire complete template source set for desktop integration"),
    "the candidate archive must be complete before desktop template bootstrap changes shared outputs"
  );
  assert.ok(
    indexOf("Upload application for independent acceptance") < indexOf("Desktop pairing, approvals, panels, relaunch, and recovery"),
    "independent installed-app acceptance must receive the production candidate before desktop smoke"
  );
  assert.match(
    steps[indexOf("Package the application")].if,
    /steps\.native-check\.outcome == 'success'/
  );
  assert.doesNotMatch(
    steps[indexOf("Package the application")].if,
    /desktop-templates/,
    "packaging eligibility must not depend on source-template bootstrap"
  );
});
