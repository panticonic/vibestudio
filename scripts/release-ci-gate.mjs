#!/usr/bin/env node
import fs from "node:fs";

export const requiredResults = [
  "release-metadata",
  "quality",
  "quality-followup",
  "quality-desktop",
  "mac-portability",
  "native-isolation-linux-x64",
  "native-isolation-linux-arm64",
  "native-isolation-darwin-arm64",
  "desktop-source-integration-macos-14",
  "npm-server-preflight",
  "packaged-acceptance-macos-14",
  "packaged-acceptance-macos-26",
  "packaged-acceptance-windows",
];

export function validateCandidateGate(needs, enabled) {
  const expected = new Map(requiredResults.map((name) => [name, "success"]));
  expected.set("sign-linux-release-candidate", enabled.linux ? "success" : "skipped");
  expected.set("windows-installer-candidate", enabled.windows ? "success" : "skipped");
  expected.set("accept-macos-release-candidate", enabled.mac ? "success" : "skipped");
  const failures = [];
  for (const [name, result] of expected) {
    if (needs[name]?.result !== result) {
      failures.push(`${name}: expected ${result}, got ${needs[name]?.result ?? "missing"}`);
    }
  }
  if (failures.length) throw new Error(`Release candidate gate failed:\n${failures.join("\n")}`);
}

export function validateQualityInputs(qualityInputs, sourceSha) {
  if (
    qualityInputs?.format !== "vibestudio-ci-quality-inputs/1" ||
    qualityInputs.sourceSHA !== sourceSha
  ) {
    throw new Error("Candidate gate quality inputs do not match the exact source commit");
  }
  const templates = qualityInputs.templates;
  if (
    !templates ||
    typeof templates !== "object" ||
    Array.isArray(templates) ||
    Object.keys(templates).length < 3
  ) {
    throw new Error("Candidate gate requires the complete official template input set");
  }
  for (const [id, value] of Object.entries(templates)) {
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id) ||
      !/^[a-f0-9]{40}$/u.test(value?.commit ?? "") ||
      !/^[a-f0-9]{40}$/u.test(value?.tree ?? "")
    ) {
      throw new Error(`Candidate gate has invalid template source input: ${id}`);
    }
  }
  for (const id of ["base", "personal", "system"]) {
    if (!templates[id]) throw new Error(`Candidate gate is missing ${id} template input`);
  }
  return templates;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    const needs = JSON.parse(process.env.NEEDS_JSON ?? "null");
    const enabled = {
      linux: process.env.RELEASE_LINUX === "true",
      mac: process.env.RELEASE_MAC === "true",
      windows: process.env.RELEASE_WINDOWS === "true",
    };
    validateCandidateGate(needs, enabled);
    const { SOURCE_SHA: sourceSha, RELEASE_TAG: releaseTag } = process.env;
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sourceSha ?? "")) {
      throw new Error("Candidate gate requires the full source SHA");
    }
    if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(releaseTag ?? "")) {
      throw new Error("Candidate gate requires a stable release tag");
    }
    const windowsRunner = process.env.WINDOWS_RUNNER;
    if (windowsRunner !== "windows-2025") {
      throw new Error("Release candidate requires the canonical Windows runner");
    }
    const qualityInputs = JSON.parse(
      fs.readFileSync(".cache/release-gate/release-quality-inputs.json", "utf8")
    );
    const templates = validateQualityInputs(qualityInputs, sourceSha);
    const attempt = Number(process.env.CANDIDATE_ATTEMPT);
    if (!Number.isSafeInteger(attempt) || attempt < 1) {
      throw new Error("Candidate gate requires the exact workflow run attempt");
    }
    fs.writeFileSync(
      "release-candidate-gate.json",
      `${JSON.stringify({ sourceSha, releaseTag, attempt, enabled, windowsRunner, templates }, null, 2)}\n`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
