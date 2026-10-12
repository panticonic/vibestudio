import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { tsImport } from "tsx/esm/api";
import { resolveDevelopmentTemplates } from "./cli/lib/smoke-remote-server.mjs";
import { prepareWorkspaceRelease } from "./prepare-workspace-release.mjs";
import { hasOwnershipFailure } from "./lib/owned-cleanup.mjs";
import {
  readCurrentHostBuildGeneration,
  releaseHostBuildGeneration,
} from "./host-build-generations.mjs";
import {
  computeHostBuildFingerprint,
  readHostBuildFingerprint,
  sameHostBuildFingerprint,
} from "./host-build-fingerprint.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { developmentTemplateSetEnv } = await tsImport(
  "../src/dev/developmentTemplateSet.ts",
  import.meta.url
);
const args = process.argv.slice(2);
function requiredOption(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--"))
    throw new Error(`${name} is required`);
  return path.resolve(args[index + 1]);
}
const output = requiredOption("--output");
const scratch = requiredOption("--scratch");
const explicitRoot = requiredOption("--template-checkouts");
const sourceEnv = { ...process.env, NODE_ENV: "development" };
for (const [parent, child] of [
  [scratch, output],
  [output, scratch],
]) {
  const relative = path.relative(parent, child);
  if (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  )
    throw new Error("Workspace release output and owned scratch must be separate directories");
}
// The canonical source-host build is a required input, produced by
// NODE_ENV=development node build.mjs --source-server-prereqs. Artifact
// preparation consumes it before timed acceptance begins.
const generation = readCurrentHostBuildGeneration(repoRoot, "source");
let preparation;
let ownsScratch = false;
const failures = [];
try {
  const expectedHost = computeHostBuildFingerprint({ cwd: repoRoot, mode: "development" });
  const actualHost = readHostBuildFingerprint(
    repoRoot,
    path.join(generation, "host-build-fingerprint.json")
  );
  if (
    !sameHostBuildFingerprint(actualHost, expectedHost) ||
    actualHost.inputCount !== expectedHost.inputCount
  )
    throw new Error(
      "Development workspace preparation requires a current development source-host generation"
    );
  await fs.mkdir(scratch);
  ownsScratch = true;
  const templates = await resolveDevelopmentTemplates({
    repoRoot,
    checkpointRoot: path.join(scratch, "template-checkpoints"),
    explicitRoot,
  });
  if (!templates)
    throw new Error("Development template preparation requires a complete source selection");
  const env = {
    ...sourceEnv,
    VIBESTUDIO_HOST_ARTIFACT_ROOT: generation,
    ...developmentTemplateSetEnv(templates),
  };
  preparation = prepareWorkspaceRelease({
    appRoot: repoRoot,
    output,
    scratch: path.join(scratch, "producer"),
    env,
    executable: process.execPath,
    entry: path.join(generation, "prepare-workspace-templates.mjs"),
  });
  await preparation.completed;
} catch (error) {
  failures.push(error);
} finally {
  try {
    await preparation?.stop();
  } catch (error) {
    if (!failures.includes(error)) failures.push(error);
  } finally {
    try {
      releaseHostBuildGeneration(generation);
    } catch (error) {
      if (!failures.includes(error)) failures.push(error);
    }
  }
  if (ownsScratch && !failures.some((error) => hasOwnershipFailure(error))) {
    try {
      await fs.rm(scratch, { recursive: true });
    } catch (error) {
      failures.push(error);
    }
  }
}
if (failures.length === 1) throw failures[0];
if (failures.length)
  throw new AggregateError(failures, "Development workspace release preparation failed", {
    cause: failures[0],
  });
