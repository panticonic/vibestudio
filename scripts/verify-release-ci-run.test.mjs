import assert from "node:assert/strict";
import test from "node:test";
import {
  requiredResults,
  validateCandidateGate,
  validateQualityInputs,
} from "./release-ci-gate.mjs";
import {
  candidateNpmArtifactName,
  validateGateReceipt,
  validateReleaseCiRun,
} from "./verify-release-ci-run.mjs";
import { assertArtifactIdentity, assertCandidateAttempt } from "./download-release-artifact.mjs";

const sourceSha = "a".repeat(40);
const releaseTag = "v0.1.105";
const repository = "panticonic/vibestudio";

test("candidate gate requires every quality result and each enabled release acceptance", () => {
  const needs = Object.fromEntries(requiredResults.map((name) => [name, { result: "success" }]));
  needs["sign-linux-release-candidate"] = { result: "success" };
  needs["windows-installer-candidate"] = { result: "success" };
  needs["accept-macos-release-candidate"] = { result: "success" };
  const enabled = { linux: true, mac: true, windows: true };
  assert.doesNotThrow(() => validateCandidateGate(needs, enabled));
  needs["quality-followup"] = { result: "failure" };
  assert.throws(() => validateCandidateGate(needs, enabled), /quality-followup/u);
  needs["quality-followup"] = { result: "success" };
  needs["quality-desktop"] = { result: "skipped" };
  needs["accept-macos-release-candidate"] = { result: "failure" };
  assert.throws(
    () => validateCandidateGate(needs, enabled),
    /quality-desktop:[^\n]*\naccept-macos/u
  );
  needs["quality-desktop"] = { result: "success" };
  needs["accept-macos-release-candidate"] = { result: "skipped" };
  assert.doesNotThrow(() => validateCandidateGate(needs, { ...enabled, mac: false }));
  assert.throws(() => validateCandidateGate(needs, enabled), /accept-macos/u);
});

test("a run re-run in part keeps the npm candidate of the attempt that produced it", () => {
  const sha = "a".repeat(40);
  const artifact = (name, expired = false) => ({
    name,
    id: 1,
    digest: `sha256:${"d".repeat(64)}`,
    expired,
  });
  const attempt1 = `vibestudio-server-npm-${sha}-1`;
  const attempt2 = `vibestudio-server-npm-${sha}-2`;
  // Attempt 2 re-ran only other jobs: the candidate is still attempt 1's.
  assert.equal(candidateNpmArtifactName({ artifacts: [artifact(attempt1)] }, sha, 2), attempt1);
  // When the npm job ran again, the newest attempt's artifact is the candidate.
  assert.equal(
    candidateNpmArtifactName({ artifacts: [artifact(attempt1), artifact(attempt2)] }, sha, 2),
    attempt2
  );
  // An expired artifact is not a candidate; with none, the newest attempt's name is reported.
  assert.equal(
    candidateNpmArtifactName({ artifacts: [artifact(attempt1, true)] }, sha, 2),
    attempt2
  );
  // Another commit's artifact is never taken.
  assert.equal(
    candidateNpmArtifactName(
      { artifacts: [artifact(`vibestudio-server-npm-${"b".repeat(40)}-1`)] },
      sha,
      1
    ),
    attempt1
  );
});

test("release dispatch accepts only a completed protected-main candidate and its exact artifacts", () => {
  const workflow = { id: 31 };
  const run = {
    workflow_id: workflow.id,
    event: "push",
    head_branch: "main",
    head_repository: { full_name: repository },
    head_sha: sourceSha,
    status: "completed",
    conclusion: "success",
    id: 123,
    run_attempt: 1,
  };
  const enabled = { linux: true, mac: true, windows: true };
  const names = [
    `vibestudio-release-gate-${sourceSha}`,
    `vibestudio-server-npm-${sourceSha}-${run.run_attempt}`,
    `vibestudio-linux-release-${sourceSha}`,
    `vibestudio-macos-${sourceSha}`,
    `darwin-process-observers-release-${sourceSha}`,
    `vibestudio-windows-${sourceSha}`,
  ];
  const artifacts = {
    total_count: names.length,
    artifacts: names.map((name, index) => ({
      name,
      id: index + 1,
      digest: `sha256:${"d".repeat(64)}`,
      expired: false,
    })),
  };
  const args = { run, workflow, artifacts, repository, sourceSha, releaseTag, enabled };
  assert.deepEqual(validateReleaseCiRun(args)[names[0]], {
    id: "1",
    digest: `sha256:${"d".repeat(64)}`,
  });
  assert.doesNotThrow(() => assertArtifactIdentity(artifacts.artifacts[0]));
  assert.throws(() => assertArtifactIdentity({ id: 1, digest: "sha256:bad" }), /SHA-256/u);
  assert.doesNotThrow(() =>
    assertCandidateAttempt(run, { runId: "123", attempt: "1", sourceSha, repository })
  );
  assert.throws(
    () =>
      assertCandidateAttempt(
        { ...run, run_attempt: 2 },
        { runId: "123", attempt: "1", sourceSha, repository }
      ),
    /changed/u
  );
  assert.throws(
    () => validateReleaseCiRun({ ...args, run: { ...run, event: "pull_request" } }),
    /protected-main/u
  );
  assert.throws(
    () => validateReleaseCiRun({ ...args, run: { ...run, workflow_id: workflow.id + 1 } }),
    /not the CI workflow/u
  );
  assert.doesNotThrow(() =>
    validateReleaseCiRun({ ...args, run: { ...run, event: "workflow_dispatch" } })
  );
  assert.throws(
    () => validateReleaseCiRun({ ...args, run: { ...run, head_sha: "b".repeat(40) } }),
    /source SHA/u
  );
  assert.throws(
    () => validateReleaseCiRun({ ...args, run: { ...run, conclusion: "failure" } }),
    /successful/u
  );
  assert.throws(
    () =>
      validateReleaseCiRun({
        ...args,
        artifacts: { total_count: names.length, artifacts: artifacts.artifacts.slice(1) },
      }),
    /truncated/u
  );
  assert.throws(
    () =>
      validateReleaseCiRun({
        ...args,
        artifacts: {
          total_count: names.length - 1,
          artifacts: artifacts.artifacts.filter((item) => !item.name.includes("linux-release")),
        },
      }),
    /linux-release/u
  );
  assert.throws(
    () =>
      validateReleaseCiRun({
        ...args,
        artifacts: {
          total_count: names.length - 1,
          artifacts: artifacts.artifacts.filter((item) => !item.name.includes("server-npm")),
        },
      }),
    /server-npm/u
  );
  assert.throws(
    () =>
      validateReleaseCiRun({
        ...args,
        artifacts: {
          total_count: names.length + 1,
          artifacts: [...artifacts.artifacts, artifacts.artifacts[0]],
        },
      }),
    /gate/u
  );
  assert.doesNotThrow(() =>
    validateReleaseCiRun({ ...args, enabled: { linux: false, mac: false, windows: false } })
  );
  assert.deepEqual(
    Object.keys(validateReleaseCiRun({ ...args, includePlatformArtifacts: false })).sort(),
    [names[0], names[1]].sort()
  );
});

test("candidate gate receipt binds version, source, and platform configuration", () => {
  const enabled = { linux: true, mac: true, windows: false };
  const templateIds = ["base", "personal", "system"];
  const templates = Object.fromEntries(
    templateIds.map((id) => [id, { commit: "b".repeat(40), tree: "c".repeat(40) }])
  );
  const receipt = {
    sourceSha,
    releaseTag,
    attempt: 1,
    enabled,
    windowsRunner: "windows-2025",
    templates,
  };
  const expected = { ...receipt, templateIds };
  assert.deepEqual(
    validateQualityInputs(
      { format: "vibestudio-ci-quality-inputs/1", sourceSHA: sourceSha, templates },
      sourceSha
    ),
    templates
  );
  assert.throws(
    () =>
      validateQualityInputs(
        { format: "vibestudio-ci-quality-inputs/1", sourceSHA: "d".repeat(40), templates },
        sourceSha
      ),
    /source commit/u
  );
  assert.throws(
    () =>
      validateQualityInputs(
        {
          format: "vibestudio-ci-quality-inputs/1",
          sourceSHA: sourceSha,
          templates: { base: templates.base },
        },
        sourceSha
      ),
    /complete/u
  );
  assert.doesNotThrow(() => validateGateReceipt(receipt, expected));
  assert.doesNotThrow(() => validateGateReceipt(receipt, { ...expected, enabled: null }));
  assert.throws(
    () => validateGateReceipt({ ...receipt, sourceSha: "b".repeat(40) }, expected),
    /source/u
  );
  assert.throws(
    () => validateGateReceipt({ ...receipt, enabled: { ...enabled, mac: false } }, expected),
    /mac/u
  );
  assert.throws(() => validateGateReceipt({ ...receipt, attempt: 2 }, expected), /attempt/u);
  assert.throws(
    () => validateGateReceipt({ ...receipt, windowsRunner: "windows-11" }, expected),
    /Windows runner/u
  );
  assert.throws(
    () =>
      validateGateReceipt(
        { ...receipt, templates: { ...templates, extra: templates.base } },
        expected
      ),
    /official template set/u
  );
});
