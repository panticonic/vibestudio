#!/usr/bin/env node
import * as path from "node:path";
import * as fs from "node:fs";
import type { StdioOptions } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { getProfileDataPath } from "@vibestudio/env-paths";
import { Ownership, awaitRetirement, readLedger, sweep } from "@vibestudio/shared/ownership";
import { ledgerDirOf } from "@vibestudio/shared/ownershipLedger";
import { signalExitCode } from "../../scripts/run-electron-lifecycle.mjs";
import {
  adoptSystemTestSession,
  acquireSystemTestInstance,
  commandProvisionsSystemTestInstance,
  describeInstanceLedger,
  isLocalSystemTestHelpCommand,
  managedTestSessionName,
  parseSystemTestLauncherArgs,
  stopManagedSystemTestInstance,
} from "./systemTestInstance.js";
import {
  assertSystemTestPreparationResult,
  systemTestPreparationFailureDetail,
} from "./systemTestPreparation.js";
import { attachDeviceDrivers } from "./deviceExecutors.js";
import {
  adoptSelfDevelopmentProjects,
  selfDevelopmentProjects,
  type SelfDevelopmentProject,
} from "./selfDevelopmentAdoption.js";

const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve("tsx")).href;
const TERMINATION_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

const HELP = `Usage: pnpm system-test [--instance ID] [--workspace NAME] COMMAND [ARGS...]

Self-provisions one isolated Vibestudio server for headless agentic acceptance.
Only doctor and run provision it; every other command (list, inspect, trajectory,
rerun, ...) addresses a running instance and fails if there is none.

Commands:
  doctor                         Provision, pair, and check infrastructure; the instance
                                 it creates lives until \`stop\`
  list --json                    List tests from the live system-test runner
  run TEST_NAME [TEST_NAME...]    Run selected exact tests; use --concurrency N
                                 for independent cases in one accounted run. An
                                 instance this command creates is leased to it and
                                 retired when it ends, unless --keep; an instance
                                 \`doctor\` created is attached to and left running
  inspect RUN_ID --json          Inspect a bounded failed-run packet
  trajectory RUN_ID TEST --full --json
                                 Inspect the full trajectory when needed
  rerun RUN_ID                   Rerun the still-relevant tests from a run
  stop                           Stop only this launcher's managed instance

Options:
  --instance ID                  Stable unique instance name (default: system-test)
  --workspace personal|system    Private workspace this instance runs in (default: system).
                                 Fixed when the instance pairs; cases naming units
                                 the workspace does not install are reported
                                 not-installed rather than run.
  --keep                         With run: create the instance until \`stop\` instead of
                                 leasing it to this command
  --persistent                   Keep this instance's state across restarts
  --self-development             Adopt this checkout as projects/vibestudio
  --device terminal|desktop      Attach that device driver for the command and stop it
                                 afterwards; repeat for both. The client system tests
                                 (client-*) drive a person's device through it.
  -h, --help                     Show this help without starting infrastructure
`;

function cliArgv(instanceId: string, command: readonly string[]): string[] {
  return ["--import", tsxLoader, "src/dev/runCli.ts", "--instance", instanceId, ...command];
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * One ordinary CLI process, a member of this launcher's ownership: killed at
 * once if the launcher is terminated, and retired by the launcher's reaper if
 * the launcher dies. Its group is joined before the result is returned.
 */
async function spawnCli(
  ownership: Ownership,
  instanceId: string,
  command: readonly string[],
  stdio: StdioOptions,
  label: string
): Promise<CliResult> {
  const owned = ownership.spawn(process.execPath, cliArgv(instanceId, command), {
    cwd: process.cwd(),
    env: process.env,
    stdio,
    kill: "immediate",
    label: `cli:${command[0] ?? "command"}`,
  });
  let stdout = "";
  let stderr = "";
  owned.child.stdout?.setEncoding("utf8");
  owned.child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  owned.child.stderr?.setEncoding("utf8");
  owned.child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  // `close`, not `exit`: the captured output is complete only once the pipes end.
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      owned.child.once("error", reject);
      owned.child.once("close", (code, signal) => resolve({ code, signal }));
    }
  );
  const [status] = await Promise.all([closed, owned.registered]);
  await owned.join();
  if (status.signal) throw new Error(`${label} exited from signal ${status.signal}`);
  return { code: status.code ?? 1, stdout, stderr };
}

async function runCli(
  ownership: Ownership,
  instanceId: string,
  command: readonly string[]
): Promise<number> {
  return (
    await spawnCli(ownership, instanceId, ["system-test", ...command], "inherit", "system-test CLI")
  ).code;
}

/** Run one ordinary CLI command and capture what it reported. */
function captureCli(
  ownership: Ownership,
  instanceId: string,
  command: readonly string[]
): Promise<CliResult> {
  return spawnCli(ownership, instanceId, command, ["ignore", "pipe", "pipe"], command[0] ?? "CLI");
}

async function prepareFreshInstance(
  ownership: Ownership,
  instanceId: string,
  expectedWorkspaceId: string
): Promise<void> {
  const prepared = await captureCli(ownership, instanceId, [
    "system-test",
    "doctor",
    "--approve-startup",
    "--json",
  ]);
  if (prepared.code !== 0) {
    throw new Error(
      `system-test startup preparation failed:\n${systemTestPreparationFailureDetail(
        prepared.stdout,
        prepared.stderr
      )}`
    );
  }
  assertSystemTestPreparationResult(prepared.stdout, expectedWorkspaceId);
}

async function adoptSelfDevelopmentSource(
  ownership: Ownership,
  instanceId: string,
  projects: readonly SelfDevelopmentProject[]
): Promise<void> {
  if (projects.length === 0) return;
  const adopted = await adoptSelfDevelopmentProjects({
    projects,
    runCli: (args) => captureCli(ownership, instanceId, args),
  });
  for (const project of adopted) {
    console.error(
      `[system-test] ${project.adopted ? "adopted" : "reusing"} ${project.repoPath} ` +
        `from ${project.url}`
    );
  }
}

/**
 * `runs` lists the records this CLI profile already holds and takes no scope,
 * so naming a session there is a usage error rather than a narrower listing.
 * Every other system-test command accepts one.
 */
const UNSCOPED_SYSTEM_TEST_COMMANDS = new Set(["runs"]);

function commandTakesScope(command: readonly string[]): boolean {
  const subcommand = command[0];
  return subcommand !== undefined && !UNSCOPED_SYSTEM_TEST_COMMANDS.has(subcommand);
}

function pairedWorkspaceId(instanceRoot: string): string {
  const credentialsPath = path.join(instanceRoot, "cli-credentials.json");
  const value = JSON.parse(fs.readFileSync(credentialsPath, "utf8")) as Record<string, unknown>;
  if (typeof value["workspaceId"] !== "string" || value["workspaceId"].length === 0) {
    throw new Error(`managed instance credentials do not name a workspace: ${credentialsPath}`);
  }
  return value["workspaceId"];
}

interface CommandContext {
  repoRoot: string;
  parsed: ReturnType<typeof parseSystemTestLauncherArgs>;
  ownership: Ownership;
  signal: AbortSignal;
  /** Leased supervisors whose retirement this launcher must join before it ends. */
  joins: Array<{ ledgerId: string; pid: number }>;
}

async function runCommand({
  repoRoot,
  parsed,
  ownership,
  signal,
  joins,
}: CommandContext): Promise<void> {
  // `run` leases the instance it creates to this launcher, so the instance
  // cannot outlive the command that wanted it; `doctor` (and `run --keep`)
  // create it until `stop`, which a later `run` attaches to and leaves alone.
  const lifetime = parsed.command[0] === "run" && !parsed.keep ? "leased" : "until-stop";
  const ensured = await acquireSystemTestInstance(repoRoot, parsed.instanceId, parsed.command, {
    explicitInstance: parsed.explicitInstance,
    persistent: parsed.persistent,
    ...(parsed.selfDevelopment ? { selfDevelopment: true } : {}),
    ...(parsed.workspace ? { workspace: parsed.workspace } : {}),
    lifetime,
    ownership,
    onLeased: (supervisor) => joins.push(supervisor),
    signal,
  });
  process.env["VIBESTUDIO_INSTANCE_ROOT"] = ensured.instance.root;
  process.env["VIBESTUDIO_INSTANCE"] = ensured.instance.id;
  console.error(
    `[system-test] ${ensured.created ? "created" : "using"} instance ${ensured.instance.id}; ` +
      `workspace=${pairedWorkspaceId(ensured.instance.root)}`
  );
  if (!commandProvisionsSystemTestInstance(parsed.command)) {
    console.error(`[system-test] ${describeInstanceLedger(ensured.ledger)}`);
  }
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
    // Startup preparation has to come first: until the creation review is
    // resolved, the workspace refuses to invoke the extension that adopts a
    // project. It also creates the system-test session, whose context forks
    // main at that moment — so tests move to a session created afterwards.
    await prepareFreshInstance(
      ownership,
      ensured.instance.id,
      pairedWorkspaceId(ensured.instance.root)
    );
  }
  if (parsed.selfDevelopment) {
    await adoptSelfDevelopmentSource(
      ownership,
      ensured.instance.id,
      selfDevelopmentProjects(repoRoot)
    );
    const session = adoptSystemTestSession(ensured.instance, "self-development");
    console.error(`[system-test] tests on this instance run under session ${session}`);
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
  // A moved session belongs to the instance, not to one invocation, so every
  // later command on it has to name the same one. An explicit --session the
  // caller passed always wins. A session's context forks main once, when the
  // session is created, so it has to be created after anything a run must see
  // was published to the workspace's main.
  const session = managedTestSessionName(ensured.instance);
  const scopedCommand =
    session && commandTakesScope(command) && !command.includes("--session")
      ? [...command, "--session", session]
      : command;
  // Device drivers are scoped to the command: attached once the instance is
  // ready (so they pair into a prepared account), stopped on every exit path.
  const drivers = parsed.devices?.length
    ? await attachDeviceDrivers({
        ownership,
        repoRoot,
        instanceId: ensured.instance.id,
        kinds: parsed.devices,
      })
    : null;
  let commandFailure: unknown;
  try {
    process.exitCode = await runCli(ownership, ensured.instance.id, scopedCommand);
  } catch (error) {
    commandFailure = error;
  }
  try {
    await drivers?.stop();
  } catch (error) {
    if (commandFailure === undefined) commandFailure = error;
    else
      commandFailure = new AggregateError(
        [commandFailure, error],
        "The command and device driver retirement both failed"
      );
  }
  if (commandFailure !== undefined) throw commandFailure;
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(process.cwd());
  const parsed = parseSystemTestLauncherArgs(process.argv.slice(2));
  if (isLocalSystemTestHelpCommand(parsed.command)) {
    if (parsed.command.length === 1) {
      process.stdout.write(HELP);
    } else {
      // Subcommand descriptions are also local metadata. Enter the CLI's
      // parser directly so help never binds to or provisions a server.
      const { main: runLocalCli } = await import("../cli/client.js");
      process.exitCode = await runLocalCli(["system-test", ...parsed.command]);
    }
    return;
  }
  if (parsed.keep && parsed.command[0] !== "run") {
    throw new Error("--keep applies to `run`: doctor always creates its instance until stop");
  }
  const profileDir = getProfileDataPath();
  const ledgerDir = ledgerDirOf(profileDir);
  // Every command reconciles ownership first: whatever a launcher or
  // supervisor that died left behind is retired before anything is looked up.
  const reconciled = await sweep(ledgerDir);
  for (const id of reconciled.retired) {
    console.error(`[system-test] retired the leftovers of ownership ${id}`);
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
  if (parsed.devices?.length && parsed.command.includes("--detach")) {
    throw new Error(
      "--device drivers live only as long as this command; a detached run would outlive them. Run it attached."
    );
  }

  const ownership = await Ownership.open({
    profileDir,
    lifetime: "leased",
    meta: { kind: "system-test-launcher", instance: parsed.instanceId, command: parsed.command[0] },
  });
  // A termination request ends the command's workload at once through the
  // idempotent release; the command's own flow then unwinds and this function
  // exits with the signal's status once the retirement is joined.
  const interrupt = new AbortController();
  const interruption: { signal: NodeJS.Signals | null } = { signal: null };
  const onSignal = (signal: NodeJS.Signals): void => {
    interruption.signal ??= signal;
    interrupt.abort(new Error(`Interrupted by ${signal}`));
    void ownership.release().catch(() => undefined);
  };
  for (const signal of TERMINATION_SIGNALS) process.on(signal, onSignal);
  const joins: Array<{ ledgerId: string; pid: number }> = [];
  let failure: unknown;
  let retirementFailure: unknown;
  try {
    await runCommand({ repoRoot, parsed, ownership, signal: interrupt.signal, joins });
  } catch (error) {
    failure = error;
  }
  try {
    await ownership.release();
  } catch (error) {
    retirementFailure = error;
  }
  // A leased instance's own reaper retires its root and record after the
  // supervisor exits; this command is not done until that has been joined.
  for (const { ledgerId, pid } of joins) {
    try {
      // Only the claim our supervisor holds: a racing launcher's instance is not ours to join.
      if (readLedger(ledgerDir, ledgerId)?.owner.pid === pid) {
        await awaitRetirement(ledgerDir, ledgerId);
      }
    } catch (error) {
      retirementFailure ??= error;
    }
  }
  for (const signal of TERMINATION_SIGNALS) process.off(signal, onSignal);
  if (interruption.signal) {
    // The workload ended because it was told to; only a failed retirement is a failure.
    process.exitCode = signalExitCode(interruption.signal);
    if (retirementFailure !== undefined) throw retirementFailure;
    return;
  }
  if (failure !== undefined && retirementFailure !== undefined) {
    throw new AggregateError(
      [failure, retirementFailure],
      "The command and its resource retirement both failed"
    );
  }
  if (failure !== undefined) throw failure;
  if (retirementFailure !== undefined) throw retirementFailure;
}

try {
  await main();
} catch (error) {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.cause !== undefined
        ? { cause: error.cause instanceof Error ? error.cause.message : String(error.cause) }
        : {}),
      classification: record["classification"] ?? "infrastructure",
      recoverable: record["recoverable"] ?? false,
      ...(record["automaticRecovery"] ? { automaticRecovery: record["automaticRecovery"] } : {}),
      ...(record["command"] ? { command: record["command"] } : {}),
    })
  );
  process.exitCode = 1;
}
