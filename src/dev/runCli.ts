#!/usr/bin/env node
import * as path from "node:path";
import { resolveDevInstance } from "./instanceRegistry.js";

function extractInstance(argv: string[]): { instanceId?: string; argv: string[] } {
  const remaining = [...argv];
  if (remaining[0] === "--instance") {
    const instanceId = remaining[1];
    if (!instanceId) throw new Error("--instance requires an id");
    return { instanceId, argv: remaining.slice(2) };
  }
  if (remaining[0]?.startsWith("--instance=")) {
    const instanceId = remaining[0].slice("--instance=".length);
    if (!instanceId) throw new Error("--instance requires an id");
    return { instanceId, argv: remaining.slice(1) };
  }
  const instanceId = process.env["VIBESTUDIO_INSTANCE"]?.trim();
  return { ...(instanceId ? { instanceId } : {}), argv: remaining };
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(process.cwd());
  const parsed = extractInstance(process.argv.slice(2));
  if (parsed.instanceId) {
    const instance = resolveDevInstance(repoRoot, parsed.instanceId);
    process.env["VIBESTUDIO_INSTANCE_ROOT"] = instance.root;
    process.env["VIBESTUDIO_INSTANCE"] = instance.id;
  }

  const { installBrokenPipeHandler, main: runCli } = await import("../cli/client.js");
  installBrokenPipeHandler(process.stdout);
  installBrokenPipeHandler(process.stderr);
  process.exitCode = await runCli(parsed.argv);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
