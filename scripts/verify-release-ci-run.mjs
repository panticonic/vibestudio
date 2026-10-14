#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertArtifactIdentity, downloadReleaseArtifact } from "./download-release-artifact.mjs";

export function validateReleaseCiRun({
  run,
  workflow,
  artifacts,
  repository,
  sourceSha,
  releaseTag,
  enabled,
}) {
  const failures = [];
  if (run.workflow_id !== workflow.id) failures.push("run is not the CI workflow");
  if (!["push", "workflow_dispatch"].includes(run.event) || run.head_branch !== "main") {
    failures.push("run is not a protected-main CI candidate");
  }
  if (run.head_repository?.full_name !== repository) {
    failures.push("run source repository does not match this repository");
  }
  if (run.head_sha !== sourceSha) failures.push("run source SHA does not match the release source");
  if (run.status !== "completed" || run.conclusion !== "success") {
    failures.push(`run is not complete and successful (${run.status}/${run.conclusion})`);
  }
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(releaseTag)) {
    failures.push("release tag is not a stable version");
  }
  if (artifacts.total_count > artifacts.artifacts?.length) {
    failures.push("candidate artifact list was truncated");
  }
  const required = [
    `vibestudio-release-gate-${sourceSha}`,
    `vibestudio-server-npm-${sourceSha}-${run.run_attempt}`,
  ];
  if (enabled.linux) required.push(`vibestudio-linux-release-${sourceSha}`);
  if (enabled.mac) {
    required.push(`vibestudio-macos-${sourceSha}`);
    required.push(`darwin-process-observers-release-${sourceSha}`);
  }
  if (enabled.windows) required.push(`vibestudio-windows-${sourceSha}`);
  const selected = {};
  for (const name of required) {
    const matches =
      artifacts.artifacts?.filter((artifact) => artifact.name === name && !artifact.expired) ?? [];
    if (matches.length !== 1)
      failures.push(`expected one unexpired ${name} artifact, got ${matches.length}`);
    else {
      try {
        assertArtifactIdentity(matches[0]);
        selected[name] = { id: String(matches[0].id), digest: matches[0].digest };
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (failures.length) throw new Error(`Release CI run validation failed:\n${failures.join("\n")}`);
  return selected;
}

export function validateGateReceipt(
  receipt,
  { sourceSha, releaseTag, attempt, enabled, templateIds }
) {
  if (receipt.sourceSha !== sourceSha || receipt.releaseTag !== releaseTag) {
    throw new Error("Candidate gate receipt does not match the requested release source and tag");
  }
  if (receipt.attempt !== attempt) {
    throw new Error("Candidate gate receipt does not match the exact CI run attempt");
  }
  for (const platform of ["linux", "mac", "windows"]) {
    if (receipt.enabled?.[platform] !== enabled[platform]) {
      throw new Error(`Candidate gate receipt disagrees on ${platform} release configuration`);
    }
  }
  if (receipt.windowsRunner !== "windows-2025") {
    throw new Error("Candidate gate receipt does not use the canonical Windows runner");
  }
  if (
    JSON.stringify(Object.keys(receipt.templates ?? {}).sort()) !==
    JSON.stringify([...templateIds].sort())
  ) {
    throw new Error("Candidate gate receipt does not identify the complete official template set");
  }
  for (const [id, value] of Object.entries(receipt.templates)) {
    if (
      !/^[a-f0-9]{40}$/u.test(value?.commit ?? "") ||
      !/^[a-f0-9]{40}$/u.test(value?.tree ?? "")
    ) {
      throw new Error(`Candidate gate receipt has invalid ${id} template identity`);
    }
  }
}

function ghJson(...args) {
  return JSON.parse(execFileSync("gh", ["api", ...args], { encoding: "utf8" }));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    const {
      GITHUB_REPOSITORY: repository,
      CANDIDATE_RUN_ID: runId,
      SOURCE_SHA: sourceSha,
      RELEASE_TAG: releaseTag,
    } = process.env;
    if (!/^[1-9]\d*$/u.test(runId ?? "")) throw new Error("Candidate run ID must be numeric");
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sourceSha ?? "")) {
      throw new Error("Source SHA must be a full Git object ID");
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "")) {
      throw new Error("Invalid GitHub repository identity");
    }
    const enabled = {
      linux: process.env.RELEASE_LINUX === "true",
      mac: process.env.RELEASE_MAC === "true",
      windows: process.env.RELEASE_WINDOWS === "true",
    };
    const workflow = ghJson(`repos/${repository}/actions/workflows/ci.yml`);
    const latestRun = ghJson(`repos/${repository}/actions/runs/${runId}`);
    if (!Number.isSafeInteger(latestRun.run_attempt) || latestRun.run_attempt < 1) {
      throw new Error("Candidate CI run has no valid attempt number");
    }
    const run = ghJson(`repos/${repository}/actions/runs/${runId}/attempts/${latestRun.run_attempt}`);
    const artifacts = ghJson(`repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`);
    const selected = validateReleaseCiRun({
      run,
      workflow,
      artifacts,
      repository,
      sourceSha,
      releaseTag,
      enabled,
    });
    const scratch = fs.mkdtempSync(
      path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), "vibestudio-release-gate-")
    );
    try {
      const gate = selected[`vibestudio-release-gate-${sourceSha}`];
      await downloadReleaseArtifact({
        ...gate,
        output: scratch,
        runId,
        attempt: run.run_attempt,
        sourceSha,
        repository,
      });
      const receipt = JSON.parse(
        fs.readFileSync(path.join(scratch, "release-candidate-gate.json"), "utf8")
      );
      const registry = JSON.parse(fs.readFileSync("templates/registry.json", "utf8"));
      validateGateReceipt(receipt, {
        sourceSha,
        releaseTag,
        attempt: run.run_attempt,
        enabled,
        templateIds: registry.templates.map((template) => template.id),
      });
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
    const outputNames = {
      gate: `vibestudio-release-gate-${sourceSha}`,
      npm: `vibestudio-server-npm-${sourceSha}-${run.run_attempt}`,
      linux: `vibestudio-linux-release-${sourceSha}`,
      mac: `vibestudio-macos-${sourceSha}`,
      observers: `darwin-process-observers-release-${sourceSha}`,
      windows: `vibestudio-windows-${sourceSha}`,
    };
    const outputs = [`candidate-attempt=${run.run_attempt}`];
    for (const [key, name] of Object.entries(outputNames)) {
      if (!selected[name]) continue;
      outputs.push(`${key}-id=${selected[name].id}`, `${key}-digest=${selected[name].digest}`);
    }
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${outputs.join("\n")}\n`);
    console.log(
      `Validated successful protected-main CI run ${runId} for ${releaseTag} at ${sourceSha}`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
