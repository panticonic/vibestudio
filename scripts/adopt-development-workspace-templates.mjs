#!/usr/bin/env node
/**
 * Give a non-release host build the workspace distributions it needs to boot.
 *
 * A release names its Base, Personal and System distributions from publication
 * receipts, and `generate-base-template-release.mjs` refuses to invent them —
 * correctly, because a shipped build must say exactly what it installs. A `--dir`
 * package built for acceptance has no receipts, so it carries an artifact with
 * no distributions and cannot create a workspace at all, which leaves the
 * installed-application smoke testing a host that refuses to start.
 *
 * This adopts the development Base the rest of the acceptance suite already runs
 * against, so the packaged app under test resolves the same distributions the
 * desktop smoke does. It is deliberately not a release path: an artifact that
 * already names distributions is left untouched, so this can never quietly
 * replace receipts on a build that has them.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = path.join(repoRoot, "build-resources", "base-template-release.json");

const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
if (artifact.workspaceTemplates) {
  console.log("[workspace-templates] release artifact already names its distributions; unchanged");
  process.exit(0);
}

const checkpoint = process.argv[2];
if (!checkpoint) {
  console.error("usage: adopt-development-workspace-templates.mjs <checkpoint-dir>");
  process.exit(1);
}

const resolved = JSON.parse(
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(repoRoot, "scripts", "resolve-development-base.ts"),
      "--checkpoint-target",
      checkpoint,
    ],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
  ).trim()
);

if (!resolved?.pins) {
  console.error("[workspace-templates] no development Base is selected; cannot adopt distributions");
  process.exit(1);
}

artifact.workspaceTemplates = resolved.pins;
writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o644 });
console.log(
  `[workspace-templates] adopted development distributions: ${Object.entries(resolved.pins)
    .map(([role, pin]) => `${role}@${pin.commit.slice(0, 12)}`)
    .join(", ")}`
);
