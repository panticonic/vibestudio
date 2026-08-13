#!/usr/bin/env node
import * as path from "node:path";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  ensureSystemTestInstance,
  isLocalSystemTestHelpCommand,
  parseSystemTestLauncherArgs,
  stopManagedSystemTestInstance,
} from "./systemTestInstance.js";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

const HELP = `Usage: pnpm system-test [--instance ID] [--bootstrap-workspace NAME] COMMAND [ARGS...]

Self-provisions one isolated Vibestudio server for headless agentic acceptance.

Commands:
  doctor                         Provision, pair, and check infrastructure
  list --json                    List tests from the live system-test runner
  run TEST_NAME                  Run one exact test
  inspect RUN_ID --json          Inspect a bounded failed-run packet
  trajectory RUN_ID TEST --full --json
                                 Inspect the full trajectory when needed
  rerun RUN_ID                   Rerun the still-relevant tests from a run
  stop                           Stop only this launcher's managed instance

Options:
  --instance ID                  Stable unique instance name (default: system-test)
  --bootstrap-workspace NAME     Use a named persistent bootstrap workspace
  -h, --help                     Show this help without starting infrastructure
`;

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

function prepareFreshInstance(instanceId: string, expectedWorkspaceId: string): Promise<void> {
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
      { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] }
    );
    let output = "";
    let diagnostics = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
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
        try {
          const line = output
            .trim()
            .split(/\r?\n/u)
            .reverse()
            .find((candidate) => candidate.trim().startsWith("{"));
          const result = line ? (JSON.parse(line) as Record<string, unknown>) : null;
          const checks = Array.isArray(result?.["checks"])
            ? (result["checks"] as Array<Record<string, unknown>>)
            : [];
          const server = checks.find((check) => check["name"] === "server");
          const data =
            server?.["data"] && typeof server["data"] === "object"
              ? (server["data"] as Record<string, unknown>)
              : null;
          if (data?.["workspaceId"] !== expectedWorkspaceId) {
            throw new Error(
              `system-test startup preparation reached workspace ${String(data?.["workspaceId"] ?? "unknown")}; expected ${expectedWorkspaceId}`
            );
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      }
    });
  });
}

function pairedWorkspaceId(instanceRoot: string): string {
  const credentialsPath = path.join(instanceRoot, "cli-credentials.json");
  const value = JSON.parse(fs.readFileSync(credentialsPath, "utf8")) as Record<string, unknown>;
  if (typeof value["workspaceId"] !== "string" || value["workspaceId"].length === 0) {
    throw new Error(`managed instance credentials do not name a workspace: ${credentialsPath}`);
  }
  return value["workspaceId"];
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(process.cwd());
  const parsed = parseSystemTestLauncherArgs(process.argv.slice(2));
  if (isLocalSystemTestHelpCommand(parsed.command)) {
    process.stdout.write(HELP);
    return;
  }
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
    ...(parsed.bootstrapWorkspace ? { bootstrapWorkspace: parsed.bootstrapWorkspace } : {}),
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
  // first test command can race the review publication. Unmanaged existing
  // instances are deliberately left alone: their reviews may belong to an
  // interactive user. Managed instances retain ownership across launcher
  // retries, including recovery from a failed first doctor call.
  // Provisioning is not complete at the ready-file boundary. Run the same
  // semantic startup barrier for every newly created instance, including a
  // caller whose first command is doctor. Relying on that outer doctor alone
  // leaves a race where it can return at transport readiness and the creation
  // review appears immediately afterward, blocking the first real test.
  if (ensured.created) {
    await prepareFreshInstance(ensured.instance.id, pairedWorkspaceId(ensured.instance.root));
  }
  const command =
    ensured.managed &&
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
