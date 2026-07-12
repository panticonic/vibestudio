#!/usr/bin/env -S node --import tsx

import * as fs from "node:fs";
import * as path from "node:path";
import { getCentralDataPath, getWorkspacesDir } from "@vibestudio/env-paths";
import {
  dedupeBuildArtifacts,
  getCentralBuildArtifactPoolDir,
} from "../src/server/buildV2/buildStore.js";
import { dedupeBlobNamespaceSync } from "../src/server/storage/blobCas.js";

function formatBytes(bytes) {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = units[0];
  for (const candidate of units) {
    unit = candidate;
    if (value < 1024 || candidate === units.at(-1)) break;
    value /= 1024;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function addBuildResult(total, next) {
  total.scanned += next.scanned;
  total.linked += next.linked;
  total.alreadyShared += next.alreadyShared;
  total.skipped += next.skipped;
  total.estimatedBytesFreed += next.estimatedBytesFreed;
  total.errors.push(...next.errors);
}

function addBlobResult(total, next) {
  total.scanned += next.scanned;
  total.linked += next.linked;
  total.alreadyShared += next.alreadyShared;
  total.estimatedBytesFreed += next.estimatedBytesFreed;
  total.errors.push(...next.errors);
}

const centralDir = getCentralDataPath();
const workspacesDir = getWorkspacesDir();
const globalCasDir = getCentralBuildArtifactPoolDir();
const buildTotal = {
  scanned: 0,
  linked: 0,
  alreadyShared: 0,
  skipped: 0,
  estimatedBytesFreed: 0,
  errors: [],
};
const blobTotal = {
  scanned: 0,
  linked: 0,
  alreadyShared: 0,
  estimatedBytesFreed: 0,
  errors: [],
};

if (!fs.existsSync(workspacesDir)) {
  console.log(`No managed workspaces found under ${workspacesDir}`);
  process.exit(0);
}

for (const workspace of fs.readdirSync(workspacesDir, { withFileTypes: true })) {
  if (!workspace.isDirectory()) continue;
  const stateDir = path.join(workspacesDir, workspace.name, "state");
  const builds = dedupeBuildArtifacts(path.join(stateDir, "builds"), globalCasDir);
  const blobs = dedupeBlobNamespaceSync(path.join(stateDir, "blobs"), globalCasDir);
  addBuildResult(buildTotal, builds);
  addBlobResult(blobTotal, blobs);
  console.log(
    `${workspace.name}: linked ${builds.linked} build artifact(s), ${blobs.linked} blob(s); ` +
      `estimated saved ${formatBytes(builds.estimatedBytesFreed + blobs.estimatedBytesFreed)}`
  );
}

const errors = [...buildTotal.errors, ...blobTotal.errors];
console.log(`Central data: ${centralDir}`);
console.log(`Global CAS: ${globalCasDir}`);
console.log(
  `Build artifacts: scanned ${buildTotal.scanned}, linked ${buildTotal.linked}, ` +
    `already shared ${buildTotal.alreadyShared}, skipped ${buildTotal.skipped}`
);
console.log(
  `Workspace blobs: scanned ${blobTotal.scanned}, linked ${blobTotal.linked}, ` +
    `already shared ${blobTotal.alreadyShared}`
);
console.log(
  `Estimated disk space saved: ${formatBytes(
    buildTotal.estimatedBytesFreed + blobTotal.estimatedBytesFreed
  )}`
);
if (errors.length > 0) {
  console.error(`Failed to dedupe ${errors.length} file(s):`);
  for (const error of errors.slice(0, 20)) console.error(`  ${error}`);
  if (errors.length > 20) console.error(`  ...and ${errors.length - 20} more`);
  process.exitCode = 1;
}
