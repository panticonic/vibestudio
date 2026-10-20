import * as fs from "node:fs";
import {
  CLI_WORKSPACE_ENV,
  isCliWorkspaceSelection,
  type CliWorkspaceSelection,
} from "./cliWorkspaceSelection.js";
import { SYSTEM_TEST_INSTANCE_ENV } from "../server/systemTestInstanceMode.js";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { observeProcessStart } from "@vibestudio/shared/ownedProcessIdentity";
import type { Ownership, OwnershipLifetime } from "@vibestudio/shared/ownership";
import {
  awaitRetirement,
  ledgerLiveness,
  readLedger,
  summarizeLedger,
  type Ledger,
} from "@vibestudio/shared/ownershipLedger";
import {
  devInstanceLedgerDir,
  devInstanceLedgerId,
  persistentInstanceRoot,
  readDevInstanceLedger,
  resolveDevInstance,
  waitForDevInstanceReady,
  type DevInstanceReadyRecord,
  type DevInstanceRecord,
} from "./instanceRegistry.js";
import { DEFAULT_IROH_RELAYS } from "../server/irohRelayConfig.js";
import { DEVICE_KINDS, isDeviceKind, type DeviceKind } from "./deviceExecutors.js";

const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve("tsx")).href;
const DEFAULT_SYSTEM_TEST_INSTANCE = "system-test";
/** Cadence of the registration observation; never a deadline. */
const REGISTRATION_OBSERVE_MS = 100;

type LauncherArgs = {
  instanceId: string;
  explicitInstance: boolean;
  persistent: boolean;
  selfDevelopment: boolean;
  /**
   * `run` creates its instance leased to the launcher, which retires it when
   * the command ends. `--keep` creates it `until-stop` instead, as `doctor`
   * always does.
   */
  keep: boolean;
  /** Which private workspace this instance's CLI opens; System by default. */
  workspace?: CliWorkspaceSelection;
  /** Device drivers to attach for the command (`--device terminal|desktop`). */
  devices?: DeviceKind[];
  command: string[];
};

export function systemTestInstanceEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  extra: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  return {
    ...base,
    ...extra,
    // Managed tests own their network topology and must not inherit a caller's
    // relay override. Use the same public Phase-0 topology as the product default.
    VIBESTUDIO_IROH_RELAYS: DEFAULT_IROH_RELAYS.join(","),
    // This server exists to run system tests, which is what admits unattended
    // test policies and harness-only seams. A developer starting it is the
    // whole authorisation; no caller asserts anything.
    [SYSTEM_TEST_INSTANCE_ENV]: "1",
  };
}

export type EnsuredSystemTestInstance = {
  instance: DevInstanceRecord;
  ready: DevInstanceReadyRecord;
  created: boolean;
  managed: boolean;
  /** The instance's ownership claim as observed when it was acquired. */
  ledger: Ledger;
  logFile?: string;
};

export function parseSystemTestLauncherArgs(argv: readonly string[]): LauncherArgs {
  let instanceId: string | undefined;
  let persistent = false;
  let selfDevelopment = false;
  let keep = false;
  let workspace: CliWorkspaceSelection | undefined;
  const devices: DeviceKind[] = [];
  const command: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) break;
    if (arg === "--instance") {
      const value = argv[index + 1];
      if (!value) throw new Error("--instance requires an id");
      if (instanceId) throw new Error("--instance may only be specified once");
      instanceId = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--instance=")) {
      if (instanceId) throw new Error("--instance may only be specified once");
      instanceId = arg.slice("--instance=".length);
      if (!instanceId) throw new Error("--instance requires an id");
      continue;
    }
    if (arg === "--workspace" || arg.startsWith("--workspace=")) {
      const value = arg.startsWith("--workspace=")
        ? arg.slice("--workspace=".length)
        : argv[(index += 1)];
      if (!value) throw new Error("--workspace requires personal or system");
      if (workspace) throw new Error("--workspace may only be specified once");
      if (!isCliWorkspaceSelection(value)) {
        throw new Error(`--workspace must name personal or system, not ${value}`);
      }
      workspace = value;
      continue;
    }
    if (arg === "--device" || arg.startsWith("--device=")) {
      const value = arg.startsWith("--device=")
        ? arg.slice("--device=".length)
        : argv[(index += 1)];
      if (!value || !isDeviceKind(value)) {
        throw new Error(
          `--device must name ${DEVICE_KINDS.join(" or ")}, not ${value ?? "nothing"}`
        );
      }
      if (!devices.includes(value)) devices.push(value);
      continue;
    }
    if (arg === "--persistent") {
      persistent = true;
      continue;
    }
    if (arg === "--self-development") {
      selfDevelopment = true;
      continue;
    }
    if (arg === "--keep") {
      keep = true;
      continue;
    }
    command.push(arg);
  }
  return {
    instanceId: instanceId ?? DEFAULT_SYSTEM_TEST_INSTANCE,
    explicitInstance: instanceId !== undefined,
    persistent,
    selfDevelopment,
    keep,
    ...(workspace ? { workspace } : {}),
    ...(devices.length > 0 ? { devices } : {}),
    command,
  };
}

/**
 * Launcher help is local metadata. It must never provision, pair, reuse, or
 * reclaim an instance merely to explain the command boundary.
 */
export function isLocalSystemTestHelpCommand(command: readonly string[]): boolean {
  for (const argument of command) {
    if (argument === "--") return false;
    if (argument === "--help" || argument === "-h") return true;
  }
  return false;
}

function canonicalRepoRoot(repoRoot: string): string {
  return fs.realpathSync(path.resolve(repoRoot));
}

function logPath(repoRoot: string, instanceId: string): string {
  const instanceRoot = persistentInstanceRoot(repoRoot, instanceId);
  return path.join(path.dirname(instanceRoot), "system-test-logs", `${instanceId}.log`);
}

/**
 * Whether pnpm system-test created this instance is a fact of its ownership
 * claim, written by the supervisor that holds it. Nothing else can authorise
 * stopping an instance, and nothing outlives the claim to be mistaken for it.
 */
export function isManagedSystemTestInstance(
  instance: Pick<DevInstanceRecord, "ledgerId" | "ledgerToken">
): boolean {
  return readDevInstanceLedger(instance)?.meta["managed"] === true;
}

/**
 * CLI session every test command on this instance runs under.
 *
 * A session's context forks protected main when the session is created, and
 * recreating a session under the same key recovers the same context rather
 * than forking again. An instance that published something after startup
 * preparation, such as adopting a development source, therefore has to move
 * its tests to a session created after that publication, or they would run in
 * a context where it never happened. The choice belongs to one generation of
 * the instance and lives in its root, so it ends with it.
 */
function sessionFile(instance: Pick<DevInstanceRecord, "root">): string {
  return path.join(instance.root, "system-test-session.json");
}

/** Move this instance's tests to a session created after `label`. */
export function adoptSystemTestSession(instance: DevInstanceRecord, label: string): string {
  if (!isManagedSystemTestInstance(instance)) {
    throw new Error(`Instance ${instance.id} is not a managed system-test instance`);
  }
  const name = `system-tests-${label}`;
  const target = sessionFile(instance);
  const staging = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(
    staging,
    `${JSON.stringify({ schemaVersion: 1, generationId: instance.generationId, name })}\n`,
    { mode: 0o600 }
  );
  fs.renameSync(staging, target);
  return name;
}

/** The session this instance's test commands must run under, if it moved. */
export function managedTestSessionName(instance: DevInstanceRecord): string | null {
  if (!isManagedSystemTestInstance(instance)) return null;
  let value: { schemaVersion?: unknown; generationId?: unknown; name?: unknown };
  try {
    value = JSON.parse(fs.readFileSync(sessionFile(instance), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return value.schemaVersion === 1 &&
    value.generationId === instance.generationId &&
    typeof value.name === "string"
    ? value.name
    : null;
}

function resolveRunning(repoRoot: string, instanceId: string): DevInstanceRecord | null {
  try {
    return resolveDevInstance(repoRoot, instanceId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("Unknown Vibestudio instance") ||
      message.includes("is no longer running")
    ) {
      return null;
    }
    throw error;
  }
}

const ownerAlive = (ledger: Ledger): boolean => observeProcessStart(ledger.owner) === "live";

function holderOf(repoRoot: string, instanceId: string): Ledger | null {
  return readLedger(devInstanceLedgerDir(), devInstanceLedgerId(repoRoot, instanceId));
}

/** One line of what an instance's ownership claim holds, with the summed RSS of its groups. */
export function describeInstanceLedger(ledger: Ledger): string {
  const summary = summarizeLedger(ledger);
  const mib = (kb: number): string => `${Math.round(kb / 1024)} MiB`;
  const groups = summary.groups.map(
    (group) =>
      `${group.label ?? group.key} pid ${group.pid} ${mib(group.rssKb)} (${group.members} process${
        group.members === 1 ? "" : "es"
      }${group.truncated ? ", truncated" : ""})`
  );
  return (
    `ownership ${ledger.id}: ${ledger.lifetime}, ${ledger.state}, ` +
    `${summary.groups.length} group${summary.groups.length === 1 ? "" : "s"}, ` +
    `${mib(summary.rssKb)} resident` +
    (groups.length ? `; ${groups.join("; ")}` : "")
  );
}

function startupFailure(instanceId: string, logFile: string, reason: string): Error {
  return Object.assign(
    new Error(
      `Could not provision system-test instance ${JSON.stringify(instanceId)}: ${reason}. ` +
        `Supervisor log: ${logFile}`
    ),
    {
      classification: "infrastructure",
      recoverable: true,
      automaticRecovery: "create_ephemeral_instance",
      command: `pnpm system-test --instance ${instanceId} doctor`,
    }
  );
}

/**
 * The commands that exist to bring an instance up. Every other command only
 * addresses an instance that is already there: `inspect` and `trajectory` read
 * a finished run from the live runner that holds it, so against a stopped
 * instance a fresh server would hold nothing and merely leak.
 */
const PROVISIONING_COMMANDS: ReadonlySet<string> = new Set(["doctor", "run"]);

export function commandProvisionsSystemTestInstance(command: readonly string[]): boolean {
  const name = command[0];
  return name !== undefined && PROVISIONING_COMMANDS.has(name);
}

type EnsureOptions = {
  explicitInstance?: boolean;
  /** Keep this instance's state on disk across restarts. */
  persistent?: boolean;
  /** Serve the developer's own checkouts so their projects can be adopted. */
  selfDevelopment?: boolean;
  /** Private workspace this instance's CLI pairs into; System by default. */
  workspace?: CliWorkspaceSelection;
  /**
   * The contract of an instance this call creates (default `until-stop`).
   * `leased` ends with the launcher's ownership; `until-stop` ends only when
   * stopped. Attaching to a `leased` instance while requiring `until-stop` is
   * an error: its life is its first launcher's.
   */
  lifetime?: OwnershipLifetime;
  /**
   * The launcher's ownership, required to create an instance: a `leased`
   * supervisor is a member of it, an `until-stop` one is handed over to its own.
   */
  ownership?: Ownership;
  /**
   * Told, right after a `leased` supervisor is spawned, which claim and
   * process it was started as: the launcher must join that retirement when it
   * ends, even if this call then fails.
   */
  onLeased?(supervisor: { ledgerId: string; pid: number }): void;
  /** A termination request: aborts every wait this call is in. */
  signal?: AbortSignal;
  /** The supervisor entry point, relative to the checkout. Overridden only by tests standing in for it. */
  supervisorEntry?: string;
};

/**
 * The one admission point for a launcher command: provision only for commands
 * that are meant to create an instance, and otherwise require a running one.
 */
export async function acquireSystemTestInstance(
  repoRoot: string,
  instanceId: string,
  command: readonly string[],
  options: EnsureOptions = {}
): Promise<EnsuredSystemTestInstance> {
  return ensureSystemTestInstance(repoRoot, instanceId, options, {
    provision: commandProvisionsSystemTestInstance(command),
  });
}

/**
 * Observe an instance claim until its holder has registered the instance.
 * With `failed`, the starter's own failure ends the wait; without it, a claim
 * that is absent or dead means there is nothing to wait for (null).
 */
async function waitForRegistration(
  repoRoot: string,
  instanceId: string,
  signal: AbortSignal | undefined,
  failed?: Promise<never>
): Promise<DevInstanceRecord | null> {
  for (;;) {
    signal?.throwIfAborted();
    const ledger = holderOf(repoRoot, instanceId);
    if (ledger && ledgerLiveness(ledger) === "live") {
      if (ledger.state === "ready") {
        const instance = resolveRunning(repoRoot, instanceId);
        if (instance) return instance;
      }
    } else if (!failed) {
      return null;
    }
    await Promise.race([
      new Promise((resolve) => setTimeout(resolve, REGISTRATION_OBSERVE_MS)),
      ...(failed ? [failed] : []),
    ]);
  }
}

async function createInstance(
  repoRoot: string,
  instanceId: string,
  options: EnsureOptions
): Promise<{ instance: DevInstanceRecord; created: boolean; logFile: string }> {
  const lifetime = options.lifetime ?? "until-stop";
  const ownership = options.ownership;
  if (!ownership) {
    throw new TypeError("Creating a system-test instance needs the launcher's ownership");
  }
  // A holder whose owner is gone is being retired (or died with its reaper):
  // finish that retirement, rethrowing its failure, before claiming the id.
  const departing = holderOf(repoRoot, instanceId);
  if (departing && !ownerAlive(departing)) {
    await awaitRetirement(devInstanceLedgerDir(), departing.id);
  }
  const logFile = logPath(repoRoot, instanceId);
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  const entry = path.resolve(repoRoot, options.supervisorEntry ?? "src/dev/runInstance.ts");
  const args = [
    "--import",
    tsxLoader,
    entry,
    "server",
    ...(options.persistent ? [] : ["--ephemeral"]),
    "--instance",
    instanceId,
    "--lifetime",
    lifetime,
    "--system-test-managed",
    ...(options.selfDevelopment ? ["--self-development"] : []),
  ];
  const env = systemTestInstanceEnvironment(process.env, {
    ...(options.workspace ? { [CLI_WORKSPACE_ENV]: options.workspace } : {}),
  });
  const output = fs.openSync(logFile, "a", 0o600);
  let child: ChildProcess;
  let registered: Promise<void> | undefined;
  try {
    if (lifetime === "leased") {
      // The supervisor's group is the launcher's: its reaper retires it when
      // the launcher ends or dies, and the lease tells the supervisor to stop
      // in order the moment the launcher's end of the pipe closes.
      const owned = ownership.spawn(process.execPath, args, {
        cwd: repoRoot,
        env,
        stdio: ["ignore", output, output],
        kill: "graceful",
        lease: true,
        label: `instance:${instanceId}`,
      });
      child = owned.child;
      registered = owned.registered;
      if (child.pid !== undefined) {
        options.onLeased?.({ ledgerId: devInstanceLedgerId(repoRoot, instanceId), pid: child.pid });
      }
    } else {
      // `until-stop` outlives its launcher by contract, so its supervisor is not
      // a member of the launcher's ownership. It owns itself instead: its own
      // reaper retires everything it started if it dies, and `stop` retires it.
      const owned = ownership.spawnDetached(process.execPath, args, {
        cwd: repoRoot,
        env,
        stdio: ["ignore", output, output],
        label: `instance:${instanceId}`,
      });
      child = owned.child;
      registered = owned.registered;
    }
  } finally {
    fs.closeSync(output);
  }
  const failed = new Promise<never>((_resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          `System-test instance owner exited ${
            signal ? `on signal ${signal}` : `with code ${code ?? 1}`
          } before registration`
        )
      );
    });
    registered?.catch(reject);
  });
  failed.catch(() => undefined);
  try {
    const instance = await waitForRegistration(repoRoot, instanceId, options.signal, failed);
    if (!instance) throw new Error("the instance did not register");
    const holder = readDevInstanceLedger(instance);
    return { instance, created: holder?.owner.pid === child.pid, logFile };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // Another launcher may have claimed the id first; its instance is then the
    // one to attach to, and our supervisor has already given way.
    const racer = await waitForRegistration(repoRoot, instanceId, options.signal);
    if (racer) return { instance: racer, created: false, logFile };
    throw startupFailure(
      instanceId,
      logFile,
      error instanceof Error ? error.message : String(error)
    );
  }
}

function assertAttachable(
  instance: DevInstanceRecord,
  ledger: Ledger,
  instanceId: string,
  options: EnsureOptions
): void {
  if (instance.kind !== "server") {
    throw new Error(`System tests require a server instance; ${instanceId} is ${instance.kind}`);
  }
  if (!options.explicitInstance && ledger.meta["managed"] !== true) {
    throw new Error(
      `System-test instance ${JSON.stringify(instanceId)} is already owned by another workflow. ` +
        `Choose a unique id with --instance.`
    );
  }
  if (options.lifetime === "until-stop" && ledger.lifetime === "leased") {
    throw new Error(
      `System-test instance ${JSON.stringify(instanceId)} is leased to the launcher that ` +
        `created it (supervisor pid ${ledger.owner.pid}) and ends with it; it cannot be kept. ` +
        `Stop it, or choose another id with --instance.`
    );
  }
  if (options.selfDevelopment && ledger.meta["selfDevelopment"] !== true) {
    throw new Error(
      `System-test instance ${JSON.stringify(instanceId)} was not created with --self-development, ` +
        `and an instance cannot be upgraded to one. Stop it and create another.`
    );
  }
}

export async function ensureSystemTestInstance(
  repoRootInput: string,
  instanceId: string,
  options: EnsureOptions = {},
  { provision = true }: { provision?: boolean } = {}
): Promise<EnsuredSystemTestInstance> {
  const repoRoot = canonicalRepoRoot(repoRootInput);
  let instance = resolveRunning(repoRoot, instanceId);
  if (!instance) {
    // A claim whose holder is alive but has not registered yet is another
    // launcher's instance still starting: wait for it instead of contending.
    const holder = holderOf(repoRoot, instanceId);
    if (holder && ownerAlive(holder) && ledgerLiveness(holder) === "live") {
      instance = await waitForRegistration(repoRoot, instanceId, options.signal);
    }
  }
  if (!instance && !provision) {
    throw Object.assign(
      new Error(
        `System-test instance ${JSON.stringify(instanceId)} is not running, and this command ` +
          `does not start one. Start it with: pnpm system-test --instance ${instanceId} doctor`
      ),
      {
        classification: "infrastructure",
        recoverable: true,
        command: `pnpm system-test --instance ${instanceId} doctor`,
      }
    );
  }
  let created = false;
  let outputFile: string | undefined;
  if (!instance) {
    const made = await createInstance(repoRoot, instanceId, options);
    instance = made.instance;
    created = made.created;
    outputFile = made.logFile;
  }
  const claim = readDevInstanceLedger(instance);
  if (!claim) {
    throw startupFailure(
      instanceId,
      outputFile ?? logPath(repoRoot, instanceId),
      "the instance's ownership claim ended before it was ready"
    );
  }
  if (!created) assertAttachable(instance, claim, instanceId, options);
  else if (instance.kind !== "server") {
    throw new Error(`System tests require a server instance; ${instanceId} is ${instance.kind}`);
  }
  const managed = claim.meta["managed"] === true;
  let ready: DevInstanceReadyRecord;
  try {
    // Readiness belongs to the registered supervisor generation. Its process
    // exit is the terminal failure event; elapsed cold-build time is not.
    ready = await waitForDevInstanceReady(instance, options.signal);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw startupFailure(
      instanceId,
      outputFile ?? logPath(repoRoot, instanceId),
      error instanceof Error ? error.message : String(error)
    );
  }
  if (ready.status === "invite-required") {
    throw startupFailure(
      instanceId,
      outputFile ?? logPath(repoRoot, instanceId),
      "the server did not provide an automatically pairable development invite"
    );
  }
  return {
    instance,
    ready,
    created,
    managed,
    ledger: readDevInstanceLedger(instance) ?? claim,
    ...(outputFile ? { logFile: outputFile } : {}),
  };
}

/**
 * Stop a managed instance and join its retirement through its ownership claim:
 * the supervisor is identity-checked (pid, start coordinate, boot) before it
 * is signalled, and the stop completes when the claim's reaper has exited with
 * everything retired. A retirement failure the reaper recorded is thrown
 * as-is. Returns false when no instance holds the claim.
 */
export async function stopManagedSystemTestInstance(
  repoRootInput: string,
  instanceId: string
): Promise<boolean> {
  const repoRoot = canonicalRepoRoot(repoRootInput);
  const ledger = holderOf(repoRoot, instanceId);
  if (!ledger) return false;
  if (ledger.meta["managed"] !== true) {
    throw new Error(
      `Refusing to stop instance ${JSON.stringify(instanceId)} because it was not created by pnpm system-test`
    );
  }
  if (ownerAlive(ledger)) {
    process.kill(ledger.owner.pid, "SIGTERM");
    // Retirement is complete only when the claim's reaper exits; there is no
    // deadline by design, so name what is awaited and where its shutdown stages
    // are logged. Without this an interrupted wait leaves only the package
    // manager's bare lifecycle failure.
    console.error(
      `[system-test] sent SIGTERM to supervisor pid ${ledger.owner.pid} of ${JSON.stringify(instanceId)}; ` +
        `waiting for it to retire (shutdown stages: ${logPath(repoRoot, instanceId)})`
    );
  }
  await awaitRetirement(devInstanceLedgerDir(), ledger.id);
  return true;
}
