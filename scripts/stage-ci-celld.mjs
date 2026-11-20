import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  nativeCelldTarget,
  readNativeCelldManifest,
  stageNativeCelldCiArtifact,
} from "./native-celld-artifacts.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const [coordinate] = process.argv.slice(2);
if (!/^(linux-(x64|arm64)|darwin-arm64|win32-x64)$/u.test(coordinate ?? "")) {
  throw new Error("Expected one supported celld platform and architecture");
}
const [platform, arch] = coordinate.split("-");
const manifest = readNativeCelldManifest(appRoot);
const target = nativeCelldTarget(platform, arch, manifest);
const { repository, branch, commit } = manifest.fork;
if (!/^[a-z\d_.-]+\/[a-z\d_.-]+$/iu.test(repository) ||
    !/^[0-9a-f]{40}$/u.test(commit) || !/^[0-9a-f]{64}$/u.test(target.sha256 ?? "")) {
  throw new Error(`No immutable celld CI build is pinned for ${coordinate}`);
}
const params = new URLSearchParams({ branch, head_sha: commit, status: "success", per_page: "1" });
const runId = execFileSync("gh", [
  "api",
  `repos/${repository}/actions/workflows/fork-runtime-artifacts.yml/runs?${params}`,
  "--jq",
  ".workflow_runs[0].id // empty",
], { encoding: "utf8" }).trim();
if (!/^\d+$/u.test(runId)) throw new Error(`No successful artifact run for celld ${commit}`);

const directory = mkdtempSync(path.join(tmpdir(), "vibestudio-celld-ci-"));
try {
  execFileSync("gh", [
    "run", "download", runId, "--repo", repository, "--name", `celld-${coordinate}`, "--dir", directory,
  ], { stdio: "inherit" });
  console.log(stageNativeCelldCiArtifact(directory, appRoot, manifest, target));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
