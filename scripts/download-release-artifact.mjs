#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function assertArtifactIdentity({ id, digest }) {
  if (!/^[1-9]\d*$/u.test(String(id))) throw new Error("Artifact ID must be numeric");
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest ?? "")) {
    throw new Error("Artifact requires a SHA-256 archive digest");
  }
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}

export function assertCandidateAttempt(run, { runId, attempt, sourceSha, repository }) {
  if (
    String(run.id) !== String(runId) ||
    run.run_attempt !== Number(attempt) ||
    run.head_sha !== sourceSha ||
    run.head_repository?.full_name !== repository ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  ) {
    throw new Error("Candidate CI run changed or is no longer complete and successful");
  }
}

export async function downloadReleaseArtifact({
  id,
  digest,
  output,
  runId,
  attempt,
  sourceSha,
  repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GH_TOKEN,
}) {
  assertArtifactIdentity({ id, digest });
  if (
    !/^[1-9]\d*$/u.test(String(runId)) ||
    !/^[1-9]\d*$/u.test(String(attempt)) ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sourceSha ?? "") ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "") ||
    !token
  ) {
    throw new Error("Missing exact candidate run identity or artifact-read token");
  }
  const run = JSON.parse(
    execFileSync("gh", ["api", `repos/${repository}/actions/runs/${runId}`], { encoding: "utf8" })
  );
  assertCandidateAttempt(run, { runId, attempt, sourceSha, repository });
  const scratch = fs.mkdtempSync(
    path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), "vibestudio-release-artifact-")
  );
  const archive = path.join(scratch, "artifact.zip");
  const headers = path.join(scratch, "headers");
  try {
    fs.writeFileSync(
      headers,
      `Authorization: Bearer ${token}\nAccept: application/vnd.github+json\n`,
      { mode: 0o600 }
    );
    runCommand("curl", [
      "--fail",
      "--location",
      "--proto-redir",
      "=https",
      "--silent",
      "--show-error",
      "--header",
      `@${headers}`,
      "--output",
      archive,
      `https://api.github.com/repos/${repository}/actions/artifacts/${id}/zip`,
    ]);
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
    if (`sha256:${hash.digest("hex")}` !== digest) {
      throw new Error(`Artifact ${id} archive digest differs from the validated candidate`);
    }
    fs.mkdirSync(output, { recursive: true });
    runCommand("unzip", ["-q", archive, "-d", output]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [id, digest, output, runId, attempt, sourceSha] = process.argv.slice(2);
  try {
    await downloadReleaseArtifact({ id, digest, output, runId, attempt, sourceSha });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
