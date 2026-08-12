#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceManifestPath = path.join(appRoot, "pnpm-workspace.yaml");
const lockfilePath = path.join(appRoot, "pnpm-lock.yaml");
const errors = [];

for (const pattern of readPnpmWorkspacePatterns(workspaceManifestPath)) {
  const normalized = pattern.replace(/^!/, "").replace(/\\/g, "/").replace(/\/$/, "");
  if (normalized.startsWith("workspace/")) {
    errors.push(
      `pnpm-workspace.yaml enrolls nested userland path ${JSON.stringify(pattern)}; ` +
        'only the checkout-tooling importer "workspace" may cross the package-manager boundary'
    );
  }
}

for (const importer of readLockfileImporters(lockfilePath)) {
  if (importer.startsWith("workspace/")) {
    errors.push(`pnpm-lock.yaml contains forbidden userland importer ${JSON.stringify(importer)}`);
  }
}

if (errors.length > 0) {
  console.error("Userland package-manager boundary check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("Userland package-manager boundary check passed.");

function readPnpmWorkspacePatterns(filePath) {
  const patterns = [];
  let inPackages = false;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    const line = rawLine.replace(/#.*$/u, "").trimEnd();
    if (!line.trim()) continue;
    if (/^packages\s*:\s*$/u.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S[^:]*\s*:/u.test(line)) break;
    if (!inPackages) continue;
    const item = /^\s*-\s*(.+)$/u.exec(line)?.[1]?.trim();
    if (!item) continue;
    patterns.push(
      item.replace(/^(?:"(.*)"|'(.*)')$/u, (_match, quoted, singleQuoted) => quoted ?? singleQuoted)
    );
  }
  return patterns;
}

function readLockfileImporters(filePath) {
  const importers = [];
  let inImporters = false;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    if (line === "importers:") {
      inImporters = true;
      continue;
    }
    if (inImporters && /^\S/u.test(line)) break;
    if (!inImporters) continue;
    const importer = /^  ([^\s][^:]*):\s*$/u.exec(line)?.[1];
    if (importer)
      importers.push(
        importer.replace(
          /^(?:"(.*)"|'(.*)')$/u,
          (_match, quoted, singleQuoted) => quoted ?? singleQuoted
        )
      );
  }
  return importers;
}
