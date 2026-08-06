#!/usr/bin/env node
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  ensureSystemTestInstance,
  parseSystemTestLauncherArgs,
  stopManagedSystemTestInstance,
} from "./systemTestInstance.js";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

function runCli(instanceId: string, command: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [tsxCli, "src/dev/runCli.ts", "--instance", instanceId, "system-test", ...command],
      { cwd: process.cwd(), env: process.env, stdio: "inherit" }
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`system-test CLI exited from signal ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

function prepareFreshInstance(instanceId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        tsxCli,
        "src/dev/runCli.ts",
        "--instance",
        instanceId,
        "system-test",
        "doctor",
        "--approve-startup",
        "--json",
      ],
      { cwd: process.cwd(), env: process.env, stdio: ["ignore", "ignore", "pipe"] }
    );
    let diagnostics = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      diagnostics += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`system-test startup preparation exited from signal ${signal}`));
      } else if (code !== 0) {
        reject(
          new Error(
            `system-test startup preparation failed${diagnostics.trim() ? `: ${diagnostics.trim()}` : ""}`
          )
        );
      } else {
        resolve();
      }
    });
  });
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(process.cwd());
  const parsed = parseSystemTestLauncherArgs(process.argv.slice(2));
  if (parsed.command[0] === "stop") {
    if (parsed.command.length !== 1)
      throw new Error("usage: pnpm system-test [--instance ID] stop");
    const stopped = await stopManagedSystemTestInstance(repoRoot, parsed.instanceId);
    console.error(
      stopped
        ? `[system-test] stopped managed instance ${parsed.instanceId}`
        : `[system-test] managed instance ${parsed.instanceId} is not running`
    );
    return;
  }
  if (parsed.command.length === 0) {
    throw new Error("usage: pnpm system-test [--instance ID] COMMAND [ARGS...]");
  }
  const ensured = await ensureSystemTestInstance(repoRoot, parsed.instanceId, {
    explicitInstance: parsed.explicitInstance,
  });
  process.env["VIBESTUDIO_INSTANCE_ROOT"] = ensured.instance.root;
  process.env["VIBESTUDIO_INSTANCE"] = ensured.instance.id;
  console.error(
    `[system-test] ${ensured.created ? "created" : "using"} instance ${ensured.instance.id}; ` +
      `workspace=${ensured.ready.workspaceName}`
  );
  // The ready record means the host is addressable, not that asynchronous
  // workspace installation/admission has settled. A server provisioned for
  // unattended system tests owns that startup review, so settle it before the
  // first test command can race the review publication. Existing instances are
  // deliberately left alone: their reviews may belong to an interactive user.
  if (ensured.created && parsed.command[0] !== "doctor") {
    await prepareFreshInstance(ensured.instance.id);
  }
  const command =
    ensured.created &&
    parsed.command[0] === "doctor" &&
    !parsed.command.includes("--approve-startup")
      ? [...parsed.command, "--approve-startup"]
      : parsed.command;
  // Run the ordinary CLI in a fresh process after instance-scoped environment
  // has been installed. Several credential/path modules bind their stores at
  // module evaluation time; importing the CLI into this provisioning process
  // can therefore keep the pre-provision profile and also entangle its RPC
  // connection lifecycle with the launcher. The process boundary is the same
  // canonical path as `pnpm cli --instance ...` and preserves exit status.
  process.exitCode = await runCli(ensured.instance.id, command);
}

try {
  await main();
} catch (error) {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      classification: record["classification"] ?? "infrastructure",
      recoverable: record["recoverable"] ?? false,
      ...(record["automaticRecovery"] ? { automaticRecovery: record["automaticRecovery"] } : {}),
      ...(record["command"] ? { command: record["command"] } : {}),
    })
  );
  process.exitCode = 1;
}
