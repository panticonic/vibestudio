#!/usr/bin/env node
import {
  prepareWorkspaceRelease,
  type WorkspacePreparationProgress,
  type WorkspaceReleasePreparation,
} from "../../scripts/prepare-workspace-release.mjs";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { createShellSurfaceLink } from "@vibestudio/shared/shellSurface";
import { CLI_WORKSPACE_ENV, isCliWorkspaceSelection } from "./cliWorkspaceSelection.js";
import type { StdioOptions } from "node:child_process";
import { DevInstanceSupervisor } from "./devInstanceSupervisor.js";
import { LaunchTermination, joinProducer } from "./launchTermination.js";
import { forEachOwnedConcurrent } from "../../scripts/lib/owned-concurrency.mjs";
import { hasOwnershipFailure, runWithOwnedCleanup } from "../../scripts/lib/owned-cleanup.mjs";
import {
  createLaunchProgress,
  runStep,
  type LaunchProgress,
  type LaunchStep,
} from "../cli/terminal/launchProgress.js";
import { routeProcessWarnings, tolerateTerminalHangup } from "../cli/terminal/ttyRestore.js";
import { signalExitCode } from "../../scripts/run-electron-lifecycle.mjs";
import {
  clearDevInstanceReady,
  createEphemeralInstanceRoot,
  generatedInstanceId,
  persistentInstanceRoot,
  publishDevInstanceReady,
  registerDevInstance,
  removeEphemeralInstanceRoot,
  unregisterDevInstance,
  type DevInstanceRecord,
} from "./instanceRegistry.js";
import { resolveDevelopmentTemplateSet } from "./developmentTemplateSet.js";
import { developmentInstanceEnvironment } from "./developmentInstanceEnvironment.js";
import { extractDevelopmentTemplateCheckoutArguments } from "./developmentTemplateOptions.js";
import { resolveDevelopmentInstanceIsolation } from "./developmentInstanceIsolation.js";
import { readCurrentHostBuildGeneration } from "../../scripts/host-build-generations.mjs";
import {
  inspectWorkspaceSources,
  workspaceSourceFromCheckout,
} from "../workspaceTemplateSource.js";

type Mode = DevInstanceRecord["kind"];
type LaunchMode = Mode | "terminal";

/**
 * `pnpm dev:terminal` keeps the terminal for the browser: build, template and
 * server output go to `<instanceRoot>/logs/server.log` instead.
 */
/** Steps `pnpm dev:terminal` runs before the browser owns the screen. */
const TERMINAL_LAUNCH_STEPS = 6;

interface TerminalLaunch {
  progress: LaunchProgress;
  logFile: string;
  logFd: number;
  log: fs.WriteStream;
  yes: boolean;
  workspace?: string;
}

async function prunePersistentInstanceBuildCache(root: string, instanceId: string): Promise<void> {
  const buildCacheRoot = path.join(root, "build-cache");
  // Loaded here, not with the launcher: its `node:sqlite` import raises an
  // ExperimentalWarning, which a disposable launch has no reason to see.
  const { DerivedCacheCoordinator, derivedCacheDatabasePath } =
    await import("@vibestudio/shared/derivedCache");
  const coordinator = new DerivedCacheCoordinator(derivedCacheDatabasePath(buildCacheRoot));
  try {
    const result = await coordinator.prune(buildCacheRoot);
    if (result.removedEntries > 0) {
      console.log(
        `[instance:${instanceId}] pruned ${result.removedEntries} cached builds ` +
          `(${(result.removedBytes / 1024 ** 3).toFixed(2)} GiB)`
      );
    }
    const cas = pruneUnreferencedInstanceCas(path.join(root, "cas"));
    if (cas.removedFiles > 0) {
      console.log(
        `[instance:${instanceId}] pruned ${cas.removedFiles} unreferenced CAS blobs ` +
          `(${(cas.removedBytes / 1024 ** 3).toFixed(2)} GiB)`
      );
    }
  } catch (error) {
    console.warn(
      `[instance:${instanceId}] build-cache pruning failed: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    coordinator.close();
  }
}

function pruneUnreferencedInstanceCas(root: string): {
  removedFiles: number;
  removedBytes: number;
} {
  const shaRoot = path.join(root, "sha256");
  let removedFiles = 0;
  let removedBytes = 0;
  const pending = [shaRoot];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const storedPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(storedPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(storedPath);
      if (stat.nlink !== 1) continue;
      fs.unlinkSync(storedPath);
      removedFiles += 1;
      removedBytes += stat.blocks * 512 || stat.size;
    }
  }
  return { removedFiles, removedBytes };
}

function extractInstance(argv: string[]): {
  instanceId?: string;
  templateCheckouts?: string;
  productionTemplates: boolean;
  forwarded: string[];
} {
  const forwarded: string[] = [];
  let instanceId: string | undefined;
  let templateCheckouts: string | undefined;
  let productionTemplates = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
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
    if (arg === "--template-checkouts") {
      const value = argv[index + 1];
      if (!value) throw new Error("--template-checkouts requires a path");
      if (templateCheckouts) throw new Error("--template-checkouts may only be specified once");
      templateCheckouts = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--template-checkouts=")) {
      if (templateCheckouts) throw new Error("--template-checkouts may only be specified once");
      templateCheckouts = arg.slice("--template-checkouts=".length);
      if (!templateCheckouts) throw new Error("--template-checkouts requires a path");
      continue;
    }
    if (arg === "--production-templates") {
      if (productionTemplates) throw new Error("--production-templates may only be specified once");
      productionTemplates = true;
      continue;
    }
    forwarded.push(arg);
  }
  return {
    ...(instanceId ? { instanceId } : {}),
    ...(templateCheckouts ? { templateCheckouts } : {}),
    productionTemplates,
    forwarded,
  };
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function optionValue(argv: readonly string[], name: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === name) return argv[index + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

/** All launch prerequisites share the same owned process-tree lifecycle. */
async function runPrerequisite(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio?: StdioOptions; termination?: LaunchTermination }
): Promise<number> {
  options.termination?.signal.throwIfAborted();
  const owner = new DevInstanceSupervisor({
    sourceRoot: fs.realpathSync(process.cwd()),
    command,
    args,
    env: options.env,
    stdio: options.stdio ?? "inherit",
    forwardParentSignals: !options.termination,
  });
  const unregister = options.termination?.onRequest(
    (signal) => void owner.stop(signal).catch(() => {})
  );
  return runWithOwnedCleanup(
    async () => {
      await owner.start();
      const code = await owner.wait();
      options.termination?.signal.throwIfAborted();
      if (code !== 0) throw new Error(`${path.basename(command)} exited with code ${code}`);
      return code;
    },
    async () => {
      try {
        await owner.close();
      } finally {
        unregister?.();
      }
    },
    "Development prerequisite and resource retirement failed"
  );
}

async function prepareHostArtifacts(
  mode: Mode,
  env: NodeJS.ProcessEnv,
  termination: LaunchTermination,
  terminal?: TerminalLaunch
): Promise<void> {
  const startedAt = performance.now();
  const stdio: StdioOptions = terminal ? ["ignore", terminal.logFd, terminal.logFd] : "inherit";
  await runPrerequisite(process.execPath, ["scripts/native-host-dependencies.mjs", "--repair"], {
    env,
    stdio,
    termination,
  });
  // The desktop coordinator reuses a verified generation instead of cleaning
  // shared dist/ beneath another instance.
  await runPrerequisite(
    process.execPath,
    mode === "desktop"
      ? ["scripts/ensure-host-build.mjs"]
      : ["build.mjs", "--source-server-prereqs"],
    { env, stdio, termination }
  );
  env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] = readCurrentHostBuildGeneration(
    process.cwd(),
    mode === "desktop" ? "desktop" : "source"
  );
  const line = `[Perf] development host prerequisites: ${Math.round(performance.now() - startedAt)}ms`;
  if (terminal) terminal.log.write(`${line}\n`);
  else console.log(line);
}

/** Source launches publish the same resources an installed product ships.
 * Preparation owns its native domains and scratch; the supervisor owns the
 * resulting immutable resources for the entire instance generation. */
function prepareLaunchTemplates(
  env: NodeJS.ProcessEnv,
  root: string,
  generationId: string,
  log?: NodeJS.WritableStream,
  onProgress?: (progress: WorkspacePreparationProgress) => void
): WorkspaceReleasePreparation {
  const output = path.join(root, "workspace-release", generationId);
  return prepareWorkspaceRelease({
    executable: process.execPath,
    entry: path.join(env["VIBESTUDIO_HOST_ARTIFACT_ROOT"]!, "prepare-workspace-templates.mjs"),
    appRoot: process.cwd(),
    output,
    sourceOutput: path.join(root, "workspace-sources", generationId),
    scratch: path.join(root, "template-preparation", generationId),
    env,
    ...(log ? { log } : {}),
    ...(onProgress ? { onProgress } : {}),
  });
}

interface LaunchResources {
  preparation?: WorkspaceReleasePreparation;
  supervisor?: DevInstanceSupervisor;
}

/**
 * Prepare templates as an owned resource: a termination request stops the
 * producer. Interactive launch waits for sources; cleanup joins completion.
 */
async function prepareOwnedTemplates(
  termination: LaunchTermination,
  resources: LaunchResources,
  start: () => WorkspaceReleasePreparation
): Promise<void> {
  termination.signal.throwIfAborted();
  const preparation = start();
  resources.preparation = preparation;
  // The launcher's cleanup joins the same stop and reports its failure.
  termination.onRequest(() => void preparation.stop().catch(() => {}));
  await preparation.sourcesReady;
}

/**
 * Start a supervisor as an owned resource. The launcher's termination, not
 * the supervisor's own signal forwarding, requests its stop, so one request
 * reaches every phase of the launch exactly once.
 */
async function startOwnedSupervisor(
  termination: LaunchTermination,
  resources: LaunchResources,
  supervisor: DevInstanceSupervisor
): Promise<DevInstanceSupervisor> {
  termination.signal.throwIfAborted();
  resources.supervisor = supervisor;
  // The launcher's cleanup joins the same retirement and reports its failure.
  termination.onRequest((signal) => void supervisor.stop(signal).catch(() => {}));
  await supervisor.start();
  return supervisor;
}

async function runServer(
  forwarded: string[],
  env: NodeJS.ProcessEnv,
  instance: DevInstanceRecord,
  resources: LaunchResources,
  termination: LaunchTermination,
  terminal?: TerminalLaunch
): Promise<DevInstanceSupervisor> {
  // credentialStore/environment paths are resolved at module evaluation time.
  // Load the bootstrap only after main() has installed this instance's process
  // environment, so an ephemeral server can never mistake the developer's
  // ordinary CLI credential for its own.
  const { pairLocalCli } = await import("../cli/localPairing.js");
  const stdio: StdioOptions = terminal ? ["ignore", terminal.logFd, terminal.logFd] : "inherit";
  const preparationStartedAt = performance.now();
  const prepareTemplates = (report?: (progress: WorkspacePreparationProgress) => void) =>
    prepareOwnedTemplates(termination, resources, () =>
      prepareLaunchTemplates(env, instance.root, instance.generationId, terminal?.log, report)
    );
  // All source clients share the same producer and sources-ready boundary.
  // Exhaustive release production continues under that owner after launch.
  if (terminal) {
    await runStep(terminal.progress, "Preparing workspace templates", (step) =>
      prepareTemplates((progress) => {
        if (progress.phase === "sources")
          step.note(`${progress.item} prepared (${progress.done}/${progress.total})`);
      })
    );
  } else await prepareTemplates();
  const preparationLine = `[Perf] development workspace sources: ${Math.round(performance.now() - preparationStartedAt)}ms`;
  if (terminal) terminal.log.write(`${preparationLine}\n`);
  else console.log(preparationLine);
  const configuredReadyFile = optionValue(forwarded, "--ready-file");
  const readyFile =
    configuredReadyFile ?? path.join(instance.root, "server-auth", "hub-ready.json");
  fs.rmSync(readyFile, { force: true });
  const serverArgs = configuredReadyFile ? forwarded : [...forwarded, "--ready-file", readyFile];
  const serverStep = terminal?.progress.step("Starting the server");
  let pairStep: LaunchStep | undefined;
  const supervisor = new DevInstanceSupervisor({
    sourceRoot: fs.realpathSync(process.cwd()),
    command: process.execPath,
    args: [path.join(env["VIBESTUDIO_HOST_ARTIFACT_ROOT"]!, "server.mjs"), ...serverArgs],
    env,
    stdio,
    readiness: {
      file: readyFile,
      async onReady(ready) {
        if (
          !ready ||
          typeof ready !== "object" ||
          (ready as { pid?: unknown }).pid !== supervisor.process?.pid
        ) {
          throw new Error("Source host readiness does not belong to its supervised server process");
        }
        // Which private workspace this instance's CLI opens is fixed when it
        // pairs: the workspace installs the units its cases need, so it is a
        // property of the instance rather than of a single command.
        const configuredWorkspace = env[CLI_WORKSPACE_ENV]?.trim();
        if (configuredWorkspace && !isCliWorkspaceSelection(configuredWorkspace)) {
          throw new Error(
            `${CLI_WORKSPACE_ENV} must name personal or system, not ${configuredWorkspace}`
          );
        }
        const selectedWorkspace = isCliWorkspaceSelection(configuredWorkspace)
          ? configuredWorkspace
          : undefined;
        serverStep?.done();
        pairStep = terminal?.progress.step("Pairing this terminal");
        const bootstrap = await pairLocalCli(ready, {
          ...(selectedWorkspace ? { workspace: selectedWorkspace } : {}),
        });
        publishDevInstanceReady(instance, bootstrap);
        pairStep?.done();
        if (bootstrap.status === "invite-required") {
          console.warn(
            `[instance:${instance.id}] CLI is not paired. Create a device invite, then run ` +
              `\`pnpm cli --instance ${instance.id} remote pair <invite>\`.`
          );
        } else if (!terminal) {
          console.log(
            `[instance:${instance.id}] CLI ${bootstrap.status}; workspace id=${bootstrap.workspaceId}`
          );
        }
      },
    },
  });
  try {
    return await startOwnedSupervisor(termination, resources, supervisor);
  } catch (error) {
    (pairStep ?? serverStep)?.fail();
    throw error;
  }
}

async function runDesktop(
  forwarded: string[],
  env: NodeJS.ProcessEnv,
  instance: DevInstanceRecord,
  resources: LaunchResources,
  termination: LaunchTermination
): Promise<DevInstanceSupervisor> {
  const preparationStartedAt = performance.now();
  await prepareOwnedTemplates(termination, resources, () =>
    prepareLaunchTemplates(env, instance.root, instance.generationId)
  );
  console.log(
    `[Perf] development workspace sources: ${Math.round(performance.now() - preparationStartedAt)}ms`
  );
  return await startOwnedSupervisor(
    termination,
    resources,
    new DevInstanceSupervisor({
      sourceRoot: fs.realpathSync(process.cwd()),
      command: process.execPath,
      args: ["scripts/run-electron.mjs", ...forwarded],
      env,
      stdio: "inherit",
    })
  );
}

const TERMINAL_HELP = `pnpm dev:terminal — build this checkout and open the terminal browser
on an ephemeral developer instance (the terminal counterpart of pnpm dev)

Usage: pnpm dev:terminal [--instance <id>] [--workspace <name>] [--yes]

  --instance <id>     Name the ephemeral instance, so parallel logs and
                      \`pnpm cli --instance <id>\` commands have a stable target.
  --workspace <name>  Show this workspace (default: your Personal workspace).
  --yes               Approve startup approvals once without asking.

Build, template and server output go to <instanceRoot>/logs/server.log.
Quitting the browser stops the server and removes the instance.
Attach to an instance that is already running with
\`pnpm cli --instance <id> terminal\`; run the product profile with
\`pnpm start:terminal\`.
Template checkout options are the same as for \`pnpm server:live --help\`.
`;

/** Pull the browser's own options out of the arguments forwarded to the server. */
function extractTerminalOptions(argv: string[]): {
  yes: boolean;
  workspace?: string;
  forwarded: string[];
} {
  const workspace = optionValue(argv, "--workspace");
  if (hasFlag(argv, "--workspace") && !workspace) throw new Error("--workspace requires a name");
  const forwarded: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--yes") continue;
    if (arg === "--workspace") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--workspace=")) continue;
    forwarded.push(arg);
  }
  return { yes: argv.includes("--yes"), ...(workspace ? { workspace } : {}), forwarded };
}

/** Run the browser against the server this supervisor owns; returns the exit status. */
async function runOwnedTerminal(
  terminal: TerminalLaunch,
  supervisor: DevInstanceSupervisor,
  termination: LaunchTermination
): Promise<number> {
  const [{ runTerminalSessions }, { loadCliCredentials, requireDeviceCliCredentials }, command] =
    await Promise.all([
      import("../cli/terminal/terminalSessions.js"),
      import("../cli/credentialStore.js"),
      import("../cli/terminal/terminalCommand.js"),
    ]);
  try {
    const loaded = loadCliCredentials();
    if (!loaded) {
      throw new Error(
        "The instance CLI is not paired: its server already has an owner account. " +
          "Start a fresh instance with --ephemeral, or pair this instance from a device."
      );
    }
    const credentials = requireDeviceCliCredentials(loaded, "pnpm dev:terminal");
    const exit = await runTerminalSessions({
      credentials,
      ...(terminal.workspace ? { workspace: terminal.workspace } : {}),
      server: {
        kind: "owned",
        endpoint: new URL(credentials.url).origin,
        logFile: terminal.logFile,
      },
      serverExited: supervisor.wait().then((code) => `the server exited (code ${code})`),
      yes: terminal.yes,
      signal: termination.signal,
      stdin: process.stdin,
      stdout: process.stdout,
      progress: terminal.progress,
    });
    return command.reportTerminalExit(exit, terminal.logFile);
  } catch (error) {
    // A requested stop is the person's own doing, not a failure to explain.
    if (termination.requested) {
      console.error("Interrupted.");
      return signalExitCode(termination.requested);
    }
    return command.printTerminalError(error, terminal.logFile);
  }
}

function openTerminalLog(
  root: string,
  options: { yes: boolean; workspace?: string }
): TerminalLaunch {
  const logFile = path.join(root, "logs", "server.log");
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(logFile, "w", 0o600);
  return {
    progress: createLaunchProgress({
      write: (line) => console.log(line),
      total: TERMINAL_LAUNCH_STEPS,
    }),
    logFile,
    logFd,
    log: fs.createWriteStream("", { fd: logFd, autoClose: false }),
    yes: options.yes,
    ...(options.workspace ? { workspace: options.workspace } : {}),
  };
}

function reportTerminalStartupFailure(error: unknown, terminal: TerminalLaunch): void {
  const message = error instanceof Error ? error.message : String(error);
  let tail = "";
  try {
    tail = fs.readFileSync(terminal.logFile, "utf8").split("\n").slice(-40).join("\n").trimEnd();
  } catch {
    // The message alone still says what failed.
  }
  console.error(`Startup failed: ${message}`);
  if (tail) console.error(`\nLast lines of ${terminal.logFile}:\n${tail}`);
}

async function main(): Promise<void> {
  const launchStartedAt = performance.now();
  const rawMode = process.argv[2];
  if (rawMode !== "desktop" && rawMode !== "server" && rawMode !== "terminal") {
    throw new Error("usage: runInstance.ts desktop|server|terminal [options]");
  }
  const launchMode: LaunchMode = rawMode;
  // The terminal browser runs against an ordinary server instance.
  const mode: Mode = launchMode === "desktop" ? "desktop" : "server";
  const repoRoot = fs.realpathSync(process.cwd());
  const templateOptions = extractDevelopmentTemplateCheckoutArguments(process.argv.slice(3));
  const instanceArgs = extractInstance(templateOptions.forwarded);
  if (launchMode === "terminal" && hasFlag(instanceArgs.forwarded, "--help")) {
    console.log(TERMINAL_HELP);
    return;
  }
  const terminalOptions =
    launchMode === "terminal" ? extractTerminalOptions(instanceArgs.forwarded) : null;
  const parsed = terminalOptions
    ? { ...instanceArgs, forwarded: terminalOptions.forwarded }
    : instanceArgs;
  if (mode === "server" && hasFlag(parsed.forwarded, "--help")) {
    console.log(`Developer instance options:
  --instance <id>  Use a named persistent isolated instance (default: source)
  --ephemeral      Use an isolated temporary instance root; combine with
                   --instance to give parallel CLI commands a stable target
  --clean-room     Use an ephemeral instance with private state, profile credentials,
                   and derived caches
  --template-checkouts <path>
                   Complete registry-defined official template source root
  --extra-template-checkout <path>
                   Add a non-official template checkout (repeatable)
  --workspace-checkout <path>
                   Open this checkout as an additional workspace
  --production-templates Ignore configured checkouts and boot the pinned releases
`);
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "development" };
    await runPrerequisite(process.execPath, ["build.mjs", "--source-server-prereqs"], { env });
    env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] = readCurrentHostBuildGeneration(process.cwd(), "source");
    process.exitCode = await runPrerequisite(
      process.execPath,
      [path.join(env["VIBESTUDIO_HOST_ARTIFACT_ROOT"]!, "server.mjs"), ...parsed.forwarded],
      { env }
    );
    return;
  }
  const { cleanRoom, disposable, forwarded } = resolveDevelopmentInstanceIsolation(
    parsed.forwarded
  );
  const id = parsed.instanceId ?? (disposable ? generatedInstanceId(mode) : "source");
  // From here this launcher owns state; a termination request (Ctrl-C,
  // SIGTERM, a terminal hang-up) must reach the cleanup below, not end the
  // process before it.
  const termination = new LaunchTermination();
  // A hung-up terminal fails every write with EIO; the cleanup still runs.
  if (terminalOptions) tolerateTerminalHangup();
  const root = disposable ? createEphemeralInstanceRoot(id) : persistentInstanceRoot(repoRoot, id);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const cleanRoomProfileRoot = cleanRoom ? path.join(root, "profile") : undefined;
  const instance = registerDevInstance({
    id,
    root,
    repoRoot,
    supervisorPid: process.pid,
    kind: mode,
    lifecycle: disposable ? "ephemeral" : "persistent",
    ...(cleanRoomProfileRoot ? { profileRoot: cleanRoomProfileRoot } : {}),
    startedAt: Date.now(),
  });
  const terminal = terminalOptions ? openTerminalLog(root, terminalOptions) : undefined;
  // The TTY belongs to the user: the launcher's own warnings go to the log.
  const releaseWarnings = terminal
    ? routeProcessWarnings((text) => terminal.log.write(text))
    : undefined;
  // In terminal mode the screen belongs to the browser: instance details go
  // to the server log, and the user sees a handful of progress lines.
  const detail = terminal
    ? (line: string) => terminal.log.write(`${line}\n`)
    : (line: string) => console.log(line);
  if (terminal) {
    console.log(`Vibestudio terminal (${instance.lifecycle} instance ${id})`);
    console.log(`  log: ${terminal.logFile}`);
  }
  const checkpointTarget = path.join(root, "default-template-checkpoints", instance.generationId);
  const templateCheckpointRoot = path.join(
    root,
    "development-template-checkpoints",
    instance.generationId
  );
  let retirementFailed = false;
  let launchFailure: unknown;
  let retirementFailure: unknown;
  let supervisor: DevInstanceSupervisor | undefined;
  const resources: LaunchResources = {};
  const sourceCoupled = id === "source" && !disposable;
  const env = developmentInstanceEnvironment({
    parent: process.env,
    repoRoot,
    instanceRoot: root,
    instanceId: id,
    sourceCoupled,
    disposable,
    cleanRoom,
  });
  try {
    let defaultTemplates: Awaited<ReturnType<typeof resolveDevelopmentTemplateSet>> | undefined;
    const prepareInputs = () =>
      forEachOwnedConcurrent(
        [
          () => prepareHostArtifacts(mode, env, termination, terminal),
          async () => {
            termination.signal.throwIfAborted();
            const startedAt = performance.now();
            defaultTemplates =
              (await resolveDevelopmentTemplateSet({
                repoRoot,
                checkpointRoot: checkpointTarget,
                ...(parsed.templateCheckouts ? { explicitRoot: parsed.templateCheckouts } : {}),
                productionTemplates: parsed.productionTemplates,
              })) ?? undefined;
            detail(
              `[Perf] development template checkpoints: ${Math.round(performance.now() - startedAt)}ms`
            );
          },
        ],
        2,
        (prepare) => prepare()
      );
    // These inputs are independent. One progress step waits for both, rather
    // than announcing either as complete while its sibling is still running.
    if (terminal)
      await runStep(
        terminal.progress,
        "Reading template checkouts and building Vibestudio",
        prepareInputs
      );
    else await prepareInputs();
    if (!parsed.productionTemplates && !defaultTemplates) {
      throw new Error(
        "No development template checkouts are configured. Run `pnpm dev:templates setup`, " +
          "or select the shipped release explicitly with `pnpm dev:production`."
      );
    }
    detail(
      parsed.productionTemplates
        ? `[instance:${id}] Template sources: published release set`
        : `[instance:${id}] Template sources: complete local set (${defaultTemplates!.sources.length} official templates)`
    );
    const developmentTemplates = await inspectWorkspaceSources({
      sources: [
        ...new Set(
          [
            ...templateOptions.checkouts,
            ...(templateOptions.workspaceCheckout ? [templateOptions.workspaceCheckout] : []),
          ].map((checkout) => fs.realpathSync(path.resolve(checkout)))
        ),
      ].map(workspaceSourceFromCheckout),
      checkpointRoot: templateCheckpointRoot,
    });
    const targetWorkspace = templateOptions.workspaceCheckout
      ? developmentTemplates.find(
          (template) =>
            template.sourceCheckout ===
            fs.realpathSync(path.resolve(templateOptions.workspaceCheckout!))
        )
      : undefined;
    if (templateOptions.workspaceCheckout && !targetWorkspace) {
      throw new Error("The requested workspace checkout has no prepared template snapshot");
    }
    const selectedTemplate = templateOptions.workspaceCheckout
      ? undefined
      : developmentTemplates[0];
    const launchArgs = targetWorkspace
      ? [
          ...forwarded,
          ...(mode === "desktop" ? ["--workspace-create-if-missing"] : []),
          mode === "server" ? "--bootstrap-workspace" : "--workspace",
          `${path
            .basename(targetWorkspace.sourceCheckout)
            .replace(/[^a-zA-Z0-9_-]/g, "-")
            .slice(
              0,
              30
            )}-${createHash("sha256").update(JSON.stringify(targetWorkspace.pin)).digest("hex").slice(0, 24)}`,
        ]
      : [
          ...forwarded,
          ...(mode === "desktop" && selectedTemplate
            ? [
                createShellSurfaceLink({
                  kind: "workspace-chooser",
                  template: selectedTemplate.pin,
                }),
              ]
            : []),
        ];
    Object.assign(
      env,
      developmentInstanceEnvironment({
        parent: env,
        repoRoot,
        instanceRoot: root,
        instanceId: id,
        sourceCoupled,
        disposable,
        cleanRoom,
        ...(defaultTemplates ? { defaultTemplates } : {}),
        ...(targetWorkspace ? { initialWorkspaceTemplate: targetWorkspace.pin } : {}),
        ...(developmentTemplates.length ? { templates: developmentTemplates } : {}),
      })
    );
    process.env["VIBESTUDIO_INSTANCE_ROOT"] = root;
    process.env["VIBESTUDIO_INSTANCE"] = id;

    // Only the lock owner may mutate this instance's readiness marker. Once
    // registered, concurrent CLI readers reject an older generation.
    if (mode === "server") clearDevInstanceReady(instance);
    detail(`[instance:${id}] ${instance.lifecycle} ${mode} state: ${root}`);
    detail(
      cleanRoom
        ? `[instance:${id}] Clean room: private disposable state, credentials, and caches`
        : `[instance:${id}] Derived cache: shared development profile`
    );
    detail(`[instance:${id}] CLI: pnpm cli --instance ${id} <command>`);
    if (parsed.productionTemplates) {
      detail(`[instance:${id}] Templates: canonical pinned production releases`);
    }
    if (defaultTemplates) {
      detail(
        `[instance:${id}] Default templates: ${Object.entries(defaultTemplates.pins)
          .map(([name, pin]) => `${name}@${pin.commit}`)
          .join(", ")}`
      );
    }
    if (targetWorkspace) {
      detail(
        `[instance:${id}] Opening additional workspace from ${targetWorkspace.sourceCheckout}`
      );
    }
    for (const template of developmentTemplates) {
      detail(
        `[instance:${id}] Template candidate: ${template.pin.url}@${template.pin.commit} from ${template.sourceCheckout}`
      );
      if (template.changedPaths.length > 0) {
        detail(
          `[instance:${id}] Template development checkpoint includes ${template.changedPaths.length} worktree change(s).`
        );
      }
    }
    if (!disposable) {
      await prunePersistentInstanceBuildCache(root, id);
    }
    if (terminal) {
      supervisor = await runServer(launchArgs, env, instance, resources, termination, terminal);
      detail(
        `[Perf] development launch inputs ready: ${Math.round(performance.now() - launchStartedAt)}ms`
      );
      const browser = runOwnedTerminal(terminal, supervisor, termination);
      process.exitCode = await Promise.race([
        browser,
        resources.preparation!.completed.then(() => browser),
      ]);
      // A hang-up or SIGTERM ended the browser by stopping its server.
      if (termination.requested) process.exitCode = signalExitCode(termination.requested);
      console.log("Stopping the server…");
    } else {
      supervisor =
        mode === "server"
          ? await runServer(launchArgs, env, instance, resources, termination)
          : await runDesktop(launchArgs, env, instance, resources, termination);
      detail(
        `[Perf] development launch inputs ready: ${Math.round(performance.now() - launchStartedAt)}ms`
      );
      const foreground = supervisor.wait();
      process.exitCode = await Promise.race([
        foreground,
        resources.preparation!.completed.then(() => foreground),
      ]);
    }
  } catch (error) {
    retirementFailed = hasOwnershipFailure(error);
    if (termination.requested && !retirementFailed) {
      // A requested stop is not a launch failure: every phase it cut short
      // settles with the cancellation, and the cleanup below still runs.
      detail(`[instance:${id}] ${error instanceof Error ? error.message : String(error)}`);
      console.error("Interrupted.");
      process.exitCode = signalExitCode(termination.requested);
    } else {
      launchFailure = error;
      // The log is inside the instance root, which an ephemeral launch removes.
      if (terminal) reportTerminalStartupFailure(error, terminal);
    }
  } finally {
    try {
      // Storage belongs to the full process lifetime, including failed
      // startup and relaunch. Never remove source checkpoints before joining
      // every acknowledged native owner.
      const retirement = await Promise.allSettled([
        resources.supervisor?.stop(),
        joinProducer(resources.preparation),
      ]);
      const failure = retirement.find((result) => result.status === "rejected");
      retirementFailed ||= !!failure;
      if (retirementFailed) {
        // State remains owned until every executor retires. Preserve the exact
        // registry and source checkpoints when that join cannot be established.
        console.error(`[instance:${id}] resource retirement failed; retaining owned state ${root}`);
      } else {
        fs.rmSync(path.join(root, "workspace-release", instance.generationId), {
          recursive: true,
          force: true,
        });
        fs.rmSync(path.join(root, "workspace-sources", instance.generationId), {
          recursive: true,
          force: true,
        });
        fs.rmSync(path.join(root, "template-preparation", instance.generationId), {
          recursive: true,
          force: true,
        });
        if (!disposable) await prunePersistentInstanceBuildCache(root, id);
        fs.rmSync(checkpointTarget, { recursive: true, force: true });
        fs.rmSync(templateCheckpointRoot, { recursive: true, force: true });
        const cleanupError = disposable ? removeEphemeralInstanceRoot(root) : null;
        if (cleanupError) {
          // Preserve the registry record and root together: the stale supervisor
          // PID makes the instance unusable, while retaining the exact root makes
          // a leaked descendant diagnosable. Most importantly, cleanup must not
          // replace the hub's original exit status with a bare ENOTEMPTY.
          console.error(
            `[instance:${id}] could not remove ephemeral state ${root}: ${cleanupError.message}`
          );
          process.exitCode = process.exitCode || 1;
        } else {
          unregisterDevInstance(repoRoot, id);
        }
      }
      if (failure?.status === "rejected") retirementFailure = failure.reason;
    } catch (error) {
      retirementFailure ??= error;
    } finally {
      try {
        await resources.supervisor?.close();
      } catch (error) {
        retirementFailure ??= error;
      }
      if (terminal) {
        releaseWarnings?.();
        await new Promise<void>((resolve) => terminal.log.end(() => resolve()));
        fs.closeSync(terminal.logFd);
        if (!retirementFailure) console.log("Server stopped.");
      }
      termination.dispose();
    }
  }
  if (terminal && launchFailure && !retirementFailure) {
    // Already reported, without a stack trace, with the log tail.
    process.exitCode = 1;
    return;
  }
  if (retirementFailure) {
    if (launchFailure && launchFailure !== retirementFailure)
      throw Object.assign(
        new AggregateError(
          [launchFailure, retirementFailure],
          "Workspace launch and retirement failed"
        ),
        {
          code: (retirementFailure as NodeJS.ErrnoException).code,
          cause: launchFailure,
        }
      );
    throw retirementFailure;
  }
  if (launchFailure) throw launchFailure;
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
