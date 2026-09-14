#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  clearDevelopmentTemplateRoot,
  configuredDevelopmentTemplateRoot,
  developmentTemplateHead,
  requireDevelopmentTemplateCheckouts,
  setDevelopmentTemplateRoot,
  TEMPLATE_NAMES,
} from "../src/dev/developmentTemplateConfig.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] ?? "status";
const args = process.argv.slice(3);

function releasedUrls(): Record<(typeof TEMPLATE_NAMES)[number], string> {
  const release = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, "build-resources", "workspace-template-release.json"),
      "utf8"
    )
  ) as { workspaceTemplates?: Record<string, { url?: unknown }> };
  return Object.fromEntries(
    TEMPLATE_NAMES.map((name) => {
      const url = release.workspaceTemplates?.[name]?.url;
      if (typeof url !== "string" || !url.startsWith("git+https://")) {
        throw new Error(`The host release does not declare a canonical ${name} template URL`);
      }
      return [name, url.slice("git+".length)];
    })
  ) as Record<(typeof TEMPLATE_NAMES)[number], string>;
}

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
  const urls = releasedUrls();
  for (const name of TEMPLATE_NAMES) {
    const checkout = path.join(root, name);
    if (fs.existsSync(checkout)) continue;
    console.log(`Cloning ${name} template into ${checkout}`);
    const status = run("git", ["clone", urls[name], checkout]);
    if (status !== 0) process.exit(status);
  }
  const selected = setDevelopmentTemplateRoot(repoRoot, root);
  console.log(`Configured canonical template checkouts: ${selected.root}`);
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
    console.log(`Development templates: ${selected.root}`);
    for (const name of TEMPLATE_NAMES) {
      const head = developmentTemplateHead(selected.checkouts[name]);
      console.log(`  ${name}: ${head.commit}${head.dirty ? " (worktree has changes)" : ""}`);
    }
  }
} else if (command === "exec") {
  const name = args[0] as (typeof TEMPLATE_NAMES)[number] | undefined;
  const separator = args[1] === "--" ? 2 : 1;
  const executable = args[separator];
  if (!name || !TEMPLATE_NAMES.includes(name) || !executable) {
    throw new Error("usage: pnpm dev:templates exec base|personal|system -- <command> [args...]");
  }
  const checkout = requireDevelopmentTemplateCheckouts(repoRoot).checkouts[name];
  process.exitCode = run(executable, args.slice(separator + 1), checkout);
} else {
  throw new Error(
    "usage: pnpm dev:templates setup [root] | use <root> | status | path | clear | exec <name> -- <command> [args...]"
  );
}
