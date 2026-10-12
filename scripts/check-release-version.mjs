#!/usr/bin/env node
import * as fs from "node:fs";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function assertReleaseVersion(tag, packageVersion) {
  const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/u.exec(tag);
  if (!match) {
    throw new Error(`Release tag must be an exact v-prefixed semantic version; received "${tag}"`);
  }
  const tagVersion = match[1];
  if (tagVersion !== packageVersion) {
    throw new Error(
      `Release tag ${tag} does not match committed package version ${packageVersion}`
    );
  }
  return tagVersion;
}

export function checkCommittedReleaseVersion(
  tag,
  packagePath = new URL("../package.json", import.meta.url)
) {
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  if (typeof pkg.version !== "string") {
    throw new Error(`Package manifest has no string version: ${fileURLToPath(packagePath)}`);
  }
  return assertReleaseVersion(tag, pkg.version);
}

export function assertSourceCommit(expectedSha, actualSha) {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(expectedSha)) {
    throw new Error(`Expected source SHA must be a full Git object ID; received "${expectedSha}"`);
  }
  if (actualSha !== expectedSha) {
    throw new Error(
      `Checked out source commit ${actualSha} does not match requested commit ${expectedSha}`
    );
  }
  return expectedSha;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
  try {
    const version = checkCommittedReleaseVersion(tag);
    const sourceShaIndex = process.argv.indexOf("--source-sha");
    const sourceSha = sourceShaIndex >= 0
      ? process.argv[sourceShaIndex + 1]
      : process.env.RELEASE_SOURCE_SHA;
    if (sourceShaIndex >= 0 && !sourceSha) {
      throw new Error("--source-sha requires a full Git object ID");
    }
    if (sourceSha !== undefined) {
      const headSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      assertSourceCommit(sourceSha, headSha);
    }
    console.log(`Release tag and committed package version agree: ${version}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
