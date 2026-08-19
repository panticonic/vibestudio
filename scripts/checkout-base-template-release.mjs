#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function readPinnedBaseRelease(root = repoRoot) {
  const releasePath = path.join(root, "build-resources", "base-template-release.json");
  const document = JSON.parse(fs.readFileSync(releasePath, "utf8"));
  const release = document?.baseTemplate;
  if (document?.format !== "vibestudio-base-release/1") {
    throw new Error(`Unsupported Base release document: ${releasePath}`);
  }
  if (
    typeof release?.url !== "string" ||
    !release.url.startsWith("git+https://") ||
    typeof release.ref !== "string" ||
    !/^refs\/(?:heads|tags)\/[^/].+$/.test(release.ref) ||
    typeof release.commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(release.commit)
  ) {
    throw new Error(`Base release document has invalid coordinates: ${releasePath}`);
  }
  return {
    url: release.url.slice("git+".length),
    ref: release.ref,
    commit: release.commit,
  };
}

export function checkoutPinnedBaseRelease({
  destination,
  release = readPinnedBaseRelease(),
  runGit = defaultRunGit,
}) {
  const output = path.resolve(destination);
  if (fs.existsSync(output)) {
    throw new Error(`Base release checkout destination already exists: ${output}`);
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const branch = release.ref.replace(/^refs\/(?:heads|tags)\//, "");
  runGit([
    "clone",
    "--filter=blob:none",
    "--no-checkout",
    "--single-branch",
    "--branch",
    branch,
    release.url,
    output,
  ]);
  runGit(["-C", output, "checkout", "--detach", release.commit]);
  const actual = runGit(["-C", output, "rev-parse", "HEAD"]).trim();
  if (actual !== release.commit) {
    throw new Error(`Base release checkout resolved ${actual}; expected ${release.commit}`);
  }
  return output;
}

function defaultRunGit(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination || process.argv.length !== 3) {
    throw new Error("usage: node scripts/checkout-base-template-release.mjs <destination>");
  }
  const release = readPinnedBaseRelease();
  const checkout = checkoutPinnedBaseRelease({ destination, release });
  console.log(`Checked out Base ${release.commit} (${release.ref}) at ${checkout}`);
}
