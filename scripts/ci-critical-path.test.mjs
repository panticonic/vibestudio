import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readWorkflow(fileName) {
  const source = await fs.readFile(
    path.join(repositoryRoot, ".github/workflows", fileName),
    "utf8"
  );
  const workflow = parse(source, { uniqueKeys: true });
  assert.ok(workflow && typeof workflow.jobs === "object", `${fileName} must declare jobs`);
  return workflow;
}

async function readCiJobs() {
  const workflow = await readWorkflow("ci.yml");
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

test("native artifact consumers wait for their exact producers without unrelated gates", async () => {
  const jobs = await readCiJobs();
  const producerJobs = [
    "native-input-linux-x64",
    "native-input-linux-arm64",
    "native-input-darwin-arm64",
  ];

  for (const [producer, target, runner] of [
    ["native-input-linux-x64", "linux-x64", "ubuntu-22.04"],
    ["native-input-linux-arm64", "linux-arm64", "ubuntu-22.04-arm"],
    ["native-input-darwin-arm64", "darwin-arm64", "macos-14"],
  ]) {
    assert.deepEqual(dependenciesOf(jobs[producer]), []);
    assert.equal(jobs[producer].uses, "./.github/workflows/native-input.yml");
    assert.equal(jobs[producer].with.target, target);
    assert.equal(jobs[producer].with.runner, runner);
  }

  for (const [verifier, producer, target, runner] of [
    ["native-isolation-linux-x64", "native-input-linux-x64", "linux-x64", "ubuntu-22.04"],
    ["native-isolation-linux-arm64", "native-input-linux-arm64", "linux-arm64", "ubuntu-22.04-arm"],
    ["native-isolation-darwin-arm64", "native-input-darwin-arm64", "darwin-arm64", "macos-26"],
  ]) {
    assert.deepEqual(dependenciesOf(jobs[verifier]), [producer]);
    assert.equal(jobs[verifier].uses, "./.github/workflows/native-verification.yml");
    assert.equal(jobs[verifier].with.target, target);
    assert.equal(jobs[verifier].with.runner, runner);
  }

  assert.deepEqual(dependenciesOf(jobs["application-candidate-mac"]), [
    "native-input-darwin-arm64",
  ]);
  assert.equal(
    jobs["application-candidate-mac"].uses,
    "./.github/workflows/application-candidate.yml"
  );
  assert.equal(jobs["application-candidate-mac"].with.target, "darwin-arm64");
  assert.equal(jobs["application-candidate-mac"].with.package, "mac");
  assert.deepEqual(dependenciesOf(jobs["application-candidate-windows"]), []);
  assert.equal(
    jobs["application-candidate-windows"].uses,
    "./.github/workflows/application-candidate.yml"
  );
  assert.equal(jobs["application-candidate-windows"].with.target, "win32-x64");
  assert.equal(jobs["application-candidate-windows"].with.package, "windows");
  assert.deepEqual(dependenciesOf(jobs["npm-server-preflight"]), producerJobs);
  const npmDownloads = jobs["npm-server-preflight"].steps
    .filter((step) => step.uses?.startsWith("actions/download-artifact@"))
    .map((step) => step.with.name)
    .filter(
      (name) =>
        name?.startsWith("native-isolation-") || name?.startsWith("darwin-process-observers-")
    );
  assert.deepEqual(npmDownloads, [
    "native-isolation-linux-x64",
    "native-isolation-linux-arm64",
    "native-isolation-darwin-arm64",
    "darwin-process-observers-ci-${{ github.sha }}",
  ]);
  const acceptanceJobs = [
    [
      "packaged-acceptance-macos-14",
      "application-candidate-mac",
      "macos-14",
      "darwin-arm64",
      "Vibestudio.app",
    ],
    [
      "packaged-acceptance-macos-26",
      "application-candidate-mac",
      "macos-26",
      "darwin-arm64",
      "Vibestudio.app",
    ],
    [
      "packaged-acceptance-windows",
      "application-candidate-windows",
      "${{ inputs.windows-runner || 'windows-2025' }}",
      "win32-x64",
      "Vibestudio.exe",
    ],
  ];
  for (const [jobName, candidate, runner, target, app] of acceptanceJobs) {
    assert.deepEqual(dependenciesOf(jobs[jobName]), [candidate]);
    assert.equal(jobs[jobName].uses, "./.github/workflows/packaged-acceptance.yml");
    assert.equal(
      jobs[jobName].if,
      `\${{ needs.${candidate}.result == 'success' }}`,
      "acceptance may consume only an artifact produced by its own successful candidate job"
    );
    assert.deepEqual(jobs[jobName].with, { runner, target, app });
    const ancestors = transitiveDependencies(jobs, jobName);
    assert.ok(
      !ancestors.has("application-candidate-mac") || candidate === "application-candidate-mac"
    );
    assert.ok(
      !ancestors.has("application-candidate-windows") ||
        candidate === "application-candidate-windows"
    );
  }

  const acceptanceWorkflow = await readWorkflow("packaged-acceptance.yml");
  const acceptanceSteps = acceptanceWorkflow.jobs.acceptance.steps;
  const downloadStep = acceptanceSteps.find(
    (step) => step.name === "Download application built in another job"
  );
  assert.ok(downloadStep, "acceptance must download the installed candidate artifact");
  assert.equal(downloadStep.with.name, "packaged-app-${{ inputs.target }}");
  assert.equal(downloadStep.with["if-no-artifact-found"], "error");
  assert.equal(downloadStep["continue-on-error"], undefined);
  assert.equal(
    downloadStep.if,
    undefined,
    "after the producer succeeds, acceptance must fail if its artifact is unexpectedly absent"
  );
  assert.ok(
    acceptanceSteps.some(
      (step) => step.name === "Launch installed desktop and workspace containment smoke"
    ),
    "each platform candidate must run the installed-app acceptance smoke"
  );

  for (const candidate of [
    "native-isolation-linux-x64",
    "native-isolation-linux-arm64",
    "application-candidate-mac",
    "application-candidate-windows",
    "npm-server-preflight",
    ...acceptanceJobs.map(([name]) => name),
  ]) {
    const ancestors = transitiveDependencies(jobs, candidate);
    assert.ok(
      ![
        "native-isolation-linux-x64",
        "native-isolation-linux-arm64",
        "native-isolation-darwin-arm64",
      ].some((verification) => ancestors.has(verification)),
      `${candidate} must not wait for an independent native verification job`
    );
  }
  assert.ok(
    producerJobs.every((producer) =>
      transitiveDependencies(jobs, "npm-server-preflight").has(producer)
    ),
    "the universal npm candidate must consume all prepared platform inputs"
  );
  assert.ok(producerJobs.includes("native-input-darwin-arm64"));
  const releaseJobs = (await readWorkflow("release.yml")).jobs;
  assert.equal(releaseJobs["release-quality"].uses, "./.github/workflows/ci.yml");
  assert.deepEqual(dependenciesOf(releaseJobs["github-release"]), ["release-quality"]);

  assert.deepEqual(
    dependenciesOf(releaseJobs["linux-installers"]),
    ["release-quality"],
    "Linux packaging must wait until the reusable CI workflow has uploaded its native payloads"
  );
  assert.match(
    JSON.stringify(releaseJobs["linux-installers"]),
    /native-isolation-/,
    "Linux packaging consumes the native artifacts published by reusable CI"
  );
  assert.deepEqual(
    dependenciesOf(releaseJobs["windows-installer"]),
    [],
    "Windows packaging consumes no CI-produced native payload artifact"
  );
  assert.doesNotMatch(JSON.stringify(releaseJobs["windows-installer"]), /download-artifact/);

  for (const [producer, publisher] of [
    ["linux-installers", "publish-linux"],
    ["windows-installer", "publish-windows"],
  ]) {
    const job = releaseJobs[producer];
    const ancestors = transitiveDependencies(releaseJobs, producer);
    assert.ok(
      !ancestors.has("github-release"),
      `${producer} must prepare its private candidate before publication without depending on the draft job`
    );
    assert.deepEqual(job.permissions, { contents: "read" });
    const source = JSON.stringify(job);
    assert.doesNotMatch(
      source,
      /\$\{\{\s*secrets\./,
      `${producer} must not receive publication credentials`
    );
    assert.doesNotMatch(
      source,
      /softprops\/action-gh-release/,
      `${producer} must not publish to GitHub Releases`
    );
    assert.ok(
      dependenciesOf(releaseJobs[publisher]).includes(producer),
      `${publisher} must wait for its exact candidate producer`
    );
  }

  const macAncestors = transitiveDependencies(releaseJobs, "mac-dmg");
  assert.ok(
    macAncestors.has("github-release"),
    "the Apple-credentialed build must remain behind release validation"
  );

  for (const [publisher, producer, acceptance] of [
    ["publish-linux", "linux-installers", undefined],
    ["publish-windows", "windows-installer", "accept-windows-installer"],
    ["publish-macos", "mac-dmg", "accept-macos-installer"],
  ]) {
    const job = releaseJobs[publisher];
    const dependencies = dependenciesOf(job);
    assert.ok(
      dependencies.includes("github-release"),
      `${publisher} must wait for the validated draft`
    );
    assert.ok(
      dependencies.includes(producer),
      `${publisher} must wait for its exact immutable candidate`
    );
    if (acceptance) {
      assert.ok(
        dependencies.includes(acceptance),
        `${publisher} must wait for installed acceptance`
      );
    }
    assert.doesNotMatch(
      job.if ?? "",
      /always\(\)|!cancelled\(\)/,
      `${publisher} must skip when a required dependency fails or is cancelled`
    );
  }

  const releaseAncestors = transitiveDependencies(releaseJobs, "publish-release");
  assert.ok(
    releaseAncestors.has("release-quality"),
    "the public release must remain behind full quality validation"
  );
});

test("application packaging captures production outputs before desktop template bootstrap", async () => {
  const reusable = await readWorkflow("application-candidate.yml");
  const steps = reusable.jobs.candidate.steps;
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
    indexOf("Upload application for independent acceptance") <
      indexOf("Desktop pairing, approvals, panels, relaunch, and recovery"),
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
