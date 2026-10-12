import assert from "node:assert/strict";
import test from "node:test";
import {
  requiredResults,
  validateCandidateGate,
  validateQualityInputs,
} from "./release-ci-gate.mjs";
import { validateGateReceipt, validateReleaseCiRun } from "./verify-release-ci-run.mjs";
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
        artifacts: { total_count: 5, artifacts: artifacts.artifacts.slice(1) },
      }),
    /truncated/u
  );
  assert.throws(
    () =>
      validateReleaseCiRun({
        ...args,
        artifacts: {
          total_count: 4,
          artifacts: artifacts.artifacts.filter((item) => item.name !== names[1]),
        },
      }),
    /linux-release/u
  );
  assert.throws(
    () =>
      validateReleaseCiRun({
        ...args,
        artifacts: { total_count: 6, artifacts: [...artifacts.artifacts, artifacts.artifacts[0]] },
      }),
    /gate/u
  );
  assert.doesNotThrow(() =>
    validateReleaseCiRun({ ...args, enabled: { linux: false, mac: false, windows: false } })
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
