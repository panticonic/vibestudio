#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  clearDevelopmentTemplateRoot,
  configuredDevelopmentTemplateRoot,
  developmentTemplateHead,
  readOfficialTemplateCatalog,
  requireDevelopmentTemplateCheckouts,
  setDevelopmentTemplateRoot,
  TEMPLATE_REGISTRY_DIRECTORY,
  TEMPLATE_REGISTRY_URL,
} from "../src/dev/developmentTemplateConfig.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] ?? "status";
const args = process.argv.slice(3);

function run(executable: string, childArgs: string[], cwd = repoRoot): number {
  const result = spawnSync(executable, childArgs, { cwd, env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${executable} exited on ${result.signal}`);
  return result.status ?? 1;
}

if (command === "setup") {
  if (args.length > 1) throw new Error("usage: pnpm dev:templates setup [root]");
  const root = path.resolve(args[0] ?? path.join(repoRoot, "..", "vibestudio-templates"));
  fs.mkdirSync(root, { recursive: true });
  const registry = path.join(root, TEMPLATE_REGISTRY_DIRECTORY);
  if (!fs.existsSync(registry)) {
    console.log(`Cloning the official template registry into ${registry}`);
    const status = run("git", ["clone", TEMPLATE_REGISTRY_URL, registry]);
    if (status !== 0) process.exit(status);
  }
  const catalog = readOfficialTemplateCatalog(root);
  for (const source of catalog.sources) {
    const checkout = path.join(root, source.id);
    if (fs.existsSync(checkout)) continue;
    console.log(`Cloning ${source.id} template into ${checkout}`);
    const status = run("git", ["clone", source.url.slice("git+".length), checkout]);
    if (status !== 0) process.exit(status);
  }
  const selected = setDevelopmentTemplateRoot(repoRoot, root);
  console.log(
    `Configured complete local template universe (${selected.sources.length} templates): ${selected.root}`
  );
} else if (command === "use") {
  if (args.length !== 1) throw new Error("usage: pnpm dev:templates use <root>");
  console.log(
    `Configured canonical template checkouts: ${setDevelopmentTemplateRoot(repoRoot, args[0]!).root}`
  );
} else if (command === "clear") {
  if (args.length !== 0) throw new Error("usage: pnpm dev:templates clear");
  clearDevelopmentTemplateRoot(repoRoot);
  console.log(
    "Cleared development template checkouts; use pnpm dev:production for pinned releases."
  );
} else if (command === "path") {
  if (args.length !== 0) throw new Error("usage: pnpm dev:templates path");
  console.log(requireDevelopmentTemplateCheckouts(repoRoot).root);
} else if (command === "status") {
  if (args.length !== 0) throw new Error("usage: pnpm dev:templates status");
  const root = configuredDevelopmentTemplateRoot(repoRoot);
  if (!root) {
    console.log("Development templates: not configured (run `pnpm dev:templates setup`)");
  } else {
    const selected = requireDevelopmentTemplateCheckouts(repoRoot);
    console.log(`Template sources: complete local development set at ${selected.root}`);
    for (const source of selected.sources) {
      const head = developmentTemplateHead(selected.checkouts[source.id]);
      console.log(
        `  ${source.id} (${source.role}): ${head.commit}${head.dirty ? " (worktree has changes)" : ""}`
      );
    }
  }
} else if (command === "sync") {
  if (args.length !== 0) throw new Error("usage: pnpm dev:templates sync");
  const selected = requireDevelopmentTemplateCheckouts(repoRoot);
  for (const checkout of [selected.registry, ...selected.sources.map((s) => selected.checkouts[s.id])]) {
    const label = path.basename(checkout);
    const head = developmentTemplateHead(checkout);
    if (head.dirty) {
      throw new Error(`Cannot synchronize ${label}: its worktree has local changes`);
    }
    console.log(`Synchronizing ${label}`);
    let status = run("git", ["fetch", "origin"], checkout);
    if (status === 0) status = run("git", ["merge", "--ff-only", "origin/main"], checkout);
    if (status !== 0) process.exit(status);
  }
} else if (command === "exec") {
  const name = args[0];
  const separator = args[1] === "--" ? 2 : 1;
  const executable = args[separator];
  const selected = requireDevelopmentTemplateCheckouts(repoRoot);
  if (!name || !selected.checkouts[name] || !executable) {
    throw new Error("usage: pnpm dev:templates exec <template-id> -- <command> [args...]");
  }
  const checkout = selected.checkouts[name];
  process.exitCode = run(executable, args.slice(separator + 1), checkout);
} else {
  throw new Error(
    "usage: pnpm dev:templates setup [root] | use <root> | status | sync | path | clear | exec <name> -- <command> [args...]"
  );
}
