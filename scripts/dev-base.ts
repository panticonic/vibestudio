#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  clearDevelopmentBaseCheckout,
  configuredDevelopmentBaseCheckout,
  developmentBaseHead,
  setDevelopmentBaseCheckout,
} from "../src/dev/developmentBaseConfig.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] ?? "status";
const args = process.argv.slice(3);

function canonicalBaseUrl(): string {
  const release = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "build-resources", "base-template-release.json"), "utf8")
  ) as { baseTemplate?: { url?: unknown } };
  const url = release.baseTemplate?.url;
  if (typeof url !== "string" || !url.startsWith("git+https://")) {
    throw new Error("The host Base release does not declare a canonical HTTPS Git URL");
  }
  return url.slice("git+".length);
}

function configured(): string {
  const checkout = configuredDevelopmentBaseCheckout(repoRoot);
  if (!checkout) {
    throw new Error("No development Base checkout is configured. Run `pnpm dev:base setup`.");
  }
  return checkout;
}

function run(executable: string, childArgs: string[], env = process.env): number {
  const result = spawnSync(executable, childArgs, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${executable} exited on ${result.signal}`);
  return result.status ?? 1;
}

if (command === "setup") {
  if (args.length > 1) throw new Error("usage: pnpm dev:base setup [path]");
  const requested = path.resolve(args[0] ?? path.join(repoRoot, "..", "vibestudio-workspace-base"));
  if (!fs.existsSync(requested)) {
    console.log(`Cloning Vibestudio Base into ${requested}`);
    const status = run("git", ["clone", canonicalBaseUrl(), requested]);
    if (status !== 0) process.exit(status);
  }
  const checkout = setDevelopmentBaseCheckout(repoRoot, requested);
  const head = developmentBaseHead(checkout);
  console.log(`Configured development Base: ${checkout}`);
  console.log(`Committed HEAD: ${head.commit}${head.dirty ? " (worktree has changes)" : ""}`);
} else if (command === "use") {
  if (args.length !== 1) throw new Error("usage: pnpm dev:base use <path>");
  const checkout = setDevelopmentBaseCheckout(repoRoot, args[0]!);
  console.log(`Configured development Base: ${checkout}`);
} else if (command === "clear") {
  if (args.length !== 0) throw new Error("usage: pnpm dev:base clear");
  clearDevelopmentBaseCheckout(repoRoot);
  console.log(
    "Cleared the development Base checkout; pnpm dev will use the published Base release."
  );
} else if (command === "path") {
  if (args.length !== 0) throw new Error("usage: pnpm dev:base path");
  console.log(configured());
} else if (command === "status") {
  if (args.length !== 0) throw new Error("usage: pnpm dev:base status");
  const checkout = configuredDevelopmentBaseCheckout(repoRoot);
  if (!checkout) {
    console.log("Development Base: published release (no local checkout configured)");
  } else {
    const head = developmentBaseHead(checkout);
    console.log(`Development Base: ${checkout}`);
    console.log(`Committed HEAD: ${head.commit}`);
    console.log(`Worktree: ${head.dirty ? "has uncommitted changes" : "clean"}`);
  }
} else if (command === "exec") {
  const separator = args[0] === "--" ? 1 : 0;
  const executable = args[separator];
  if (!executable) throw new Error("usage: pnpm dev:base exec -- <command> [args...]");
  const checkout = configured();
  process.exitCode = run(executable, args.slice(separator + 1), {
    ...process.env,
    VIBESTUDIO_USERLAND_ROOT: checkout,
  });
} else {
  throw new Error(
    "usage: pnpm dev:base setup [path] | use <path> | status | path | clear | exec -- <command>"
  );
}
