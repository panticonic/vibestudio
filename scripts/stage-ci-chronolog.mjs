import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stageChronologBuildArchive } from "./lib/chronolog-build-input.mjs";

const repository = "werg/chronolog-db";
const {
  CHRONOLOG_RELEASE_RUN: runId,
  CHRONOLOG_RELEASE_SOURCE: source,
  CHRONOLOG_RELEASE_SHA256: sha256,
  GITHUB_ENV: githubEnv,
  RUNNER_TEMP: runnerTemp,
} = process.env;
if (!/^\d+$/u.test(runId ?? "") || !/^[a-f0-9]{40}$/u.test(source ?? "") ||
    !/^[a-f0-9]{64}$/u.test(sha256 ?? "") || !githubEnv) {
  throw new Error("Chronolog CI staging requires a release run, exact source, and archive SHA-256");
}
const run = JSON.parse(execFileSync("gh", ["api", `repos/${repository}/actions/runs/${runId}`], { encoding: "utf8" }));
if (run.head_sha !== source || run.status !== "completed" || run.conclusion !== "success" ||
    run.path !== ".github/workflows/release.yml") {
  throw new Error("Chronolog CI staging requires the successful release workflow at the pinned source");
}

const directory = mkdtempSync(path.join(runnerTemp ?? tmpdir(), "vibestudio-chronolog-ci-"));
try {
  const artifact = path.join(directory, "artifact");
  const extracted = path.join(directory, "extracted");
  mkdirSync(extracted);
  execFileSync("gh", ["run", "download", runId, "--repo", repository,
    "--name", `celld-peer-session-${source}`, "--dir", artifact], { stdio: "inherit" });
  const prefix = `chronolog-peer-session-${source.slice(0, 8)}`;
  const archives = readdirSync(artifact).filter(name =>
    name === `${prefix}-relay-celld.tgz` || name === `${prefix}-celld.tgz`
  );
  if (archives.length !== 1) throw new Error("Expected one Chronolog celld workspace archive");
  const { root, fingerprint } = stageChronologBuildArchive(
    path.join(artifact, archives[0]),
    extracted,
    { source, sha256 },
  );
  appendFileSync(githubEnv, `VIBESTUDIO_CHRONOLOG_PACKAGE_ROOT=${root}\nVIBESTUDIO_CHRONOLOG_PACKAGE_MANIFEST_SHA256=${fingerprint}\n`);
} catch (error) {
  rmSync(directory, { recursive: true, force: true });
  throw error;
}
