#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FOUNDATION_TEMPLATE_NAMES = ["base", "personal", "system"];

export function readPinnedWorkspaceTemplateRelease(root = repoRoot) {
  const releasePath = path.join(root, "build-resources", "workspace-template-release.json");
  const document = JSON.parse(fs.readFileSync(releasePath, "utf8"));
  if (document?.format !== "vibestudio-template-release/1") {
    throw new Error(`Unsupported workspace template release document: ${releasePath}`);
  }

  return Object.fromEntries(
    FOUNDATION_TEMPLATE_NAMES.map((name) => {
      const release = document?.workspaceTemplates?.[name];
      if (
        typeof release?.url !== "string" ||
        !release.url.startsWith("git+https://") ||
        typeof release.ref !== "string" ||
        !/^refs\/(?:heads|tags)\/[^/].+$/.test(release.ref) ||
        typeof release.commit !== "string" ||
        !/^[0-9a-f]{40}$/.test(release.commit)
      ) {
        throw new Error(
          `Workspace template release document has invalid ${name} coordinates: ${releasePath}`
        );
      }
      return [
        name,
        {
          url: release.url.slice("git+".length),
          ref: release.ref,
          commit: release.commit,
        },
      ];
    })
  );
}

export function checkoutPinnedWorkspaceTemplateRelease({
  destination,
  releases = readPinnedWorkspaceTemplateRelease(),
  runGit = defaultRunGit,
}) {
  const output = path.resolve(destination);
  if (fs.existsSync(output)) {
    throw new Error(`Workspace template release destination already exists: ${output}`);
  }
  fs.mkdirSync(output, { recursive: true });

  const checkouts = {};
  for (const name of FOUNDATION_TEMPLATE_NAMES) {
    const release = releases[name];
    const checkout = path.join(output, name);
    const branch = release.ref.replace(/^refs\/(?:heads|tags)\//, "");
    runGit([
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      "--single-branch",
      "--branch",
      branch,
      release.url,
      checkout,
    ]);
    runGit(["-C", checkout, "checkout", "--detach", release.commit]);
    const actual = runGit(["-C", checkout, "rev-parse", "HEAD"]).trim();
    if (actual !== release.commit) {
      throw new Error(
        `${name} template release checkout resolved ${actual}; expected ${release.commit}`
      );
    }
    checkouts[name] = checkout;
  }
  return checkouts;
}

function defaultRunGit(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination || process.argv.length !== 3) {
    throw new Error("usage: node scripts/checkout-workspace-template-release.mjs <destination>");
  }
  const releases = readPinnedWorkspaceTemplateRelease();
  const checkouts = checkoutPinnedWorkspaceTemplateRelease({ destination, releases });
  for (const name of FOUNDATION_TEMPLATE_NAMES) {
    const release = releases[name];
    console.log(`Checked out ${name} ${release.commit} (${release.ref}) at ${checkouts[name]}`);
  }
}
