#!/usr/bin/env node
import {
  prepareWorkspaceRelease,
  type WorkspaceReleasePreparation,
} from "../../scripts/prepare-workspace-release.mjs";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { createShellSurfaceLink } from "@vibestudio/shared/shellSurface";
import { CLI_WORKSPACE_ENV, isCliWorkspaceSelection } from "./cliWorkspaceSelection.js";
import { spawn, type StdioOptions } from "node:child_process";
import { DevInstanceSupervisor } from "./devInstanceSupervisor.js";
import { DerivedCacheCoordinator, derivedCacheDatabasePath } from "@vibestudio/shared/derivedCache";
import {
  clearDevInstanceReady,
  createEphemeralInstanceRoot,
  readDevInstanceRecord,
  waitForDevInstanceReady,
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
import { readCurrentHostBuildGeneration } from "../../scripts/host-build-generations.mjs";
import {
  inspectWorkspaceSources,
  workspaceSourceFromCheckout,
} from "../workspaceTemplateSource.js";

type Mode = DevInstanceRecord["kind"];
type LaunchMode = Mode | "terminal";

/**
 * `pnpm terminal` keeps the terminal for the browser: build, template and
 * server output go to `<instanceRoot>/logs/server.log` instead.
 */
interface TerminalLaunch {
  logFile: string;
  logFd: number;
  log: fs.WriteStream;
  yes: boolean;
  workspace?: string;
}

async function prunePersistentInstanceBuildCache(root: string, instanceId: string): Promise<void> {
  const buildCacheRoot = path.join(root, "build-cache");
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

function withoutFlag(argv: readonly string[], name: string): string[] {
  return argv.filter((arg) => arg !== name && !arg.startsWith(`${name}=`));
}

function optionValue(argv: readonly string[], name: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === name) return argv[index + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

function run(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; allowFailure?: boolean; stdio?: StdioOptions }
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: options.env,
      stdio: options.stdio ?? "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${path.basename(command)} exited on ${signal}`));
        return;
      }
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !options.allowFailure) {
        reject(new Error(`${path.basename(command)} exited with code ${exitCode}`));
        return;
      }
      resolve(exitCode);
    });
  });
}

/** Source launches publish the same resources an installed product ships.
 * Preparation owns its native domains and scratch; the supervisor owns the
 * resulting immutable resources for the entire instance generation. */
function prepareLaunchTemplates(
  env: NodeJS.ProcessEnv,
  root: string,
  generationId: string,
  log?: NodeJS.WritableStream
): WorkspaceReleasePreparation {
  const output = path.join(root, "workspace-release", generationId);
  return prepareWorkspaceRelease({
    executable: process.execPath,
    entry: path.join(env["VIBESTUDIO_HOST_ARTIFACT_ROOT"]!, "prepare-workspace-templates.mjs"),
    appRoot: process.cwd(),
    output,
    scratch: path.join(root, "template-preparation", generationId),
    env,
    ...(log ? { log } : {}),
  });
}

async function runServer(
  forwarded: string[],
  env: NodeJS.ProcessEnv,
  instance: DevInstanceRecord,
  resources: { preparation?: WorkspaceReleasePreparation; supervisor?: DevInstanceSupervisor },
  terminal?: TerminalLaunch
): Promise<DevInstanceSupervisor> {
  // credentialStore/environment paths are resolved at module evaluation time.
  // Load the bootstrap only after main() has installed this instance's process
  // environment, so an ephemeral server can never mistake the developer's
  // ordinary CLI credential for its own.
  const { pairLocalCli } = await import("../cli/localPairing.js");
  const stdio: StdioOptions = terminal ? ["ignore", terminal.logFd, terminal.logFd] : "inherit";
  if (terminal) console.log("Building Vibestudio from this checkout…");
  await run(process.execPath, ["scripts/native-host-dependencies.mjs", "--repair"], { env, stdio });
  await run(process.execPath, ["build.mjs", "--source-server-prereqs"], { env, stdio });
  env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] = readCurrentHostBuildGeneration(process.cwd(), "source");
  if (terminal) console.log("Preparing workspace templates…");
  resources.preparation = prepareLaunchTemplates(
    env,
    instance.root,
    instance.generationId,
    terminal?.log
  );
  await resources.preparation.completed;
  if (terminal) console.log("Starting the server…");
  const configuredReadyFile = optionValue(forwarded, "--ready-file");
  const readyFile =
    configuredReadyFile ?? path.join(instance.root, "server-auth", "hub-ready.json");
  fs.rmSync(readyFile, { force: true });
  const serverArgs = configuredReadyFile ? forwarded : [...forwarded, "--ready-file", readyFile];
  const supervisor = new DevInstanceSupervisor({
    sourceRoot: fs.realpathSync(process.cwd()),
    command: process.execPath,
    args: [path.join(env["VIBESTUDIO_HOST_ARTIFACT_ROOT"]!, "server.mjs"), ...serverArgs],
    env,
    stdio,
    forwardParentSignals: true,
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
        if (terminal) console.log("Pairing this terminal…");
        const bootstrap = await pairLocalCli(ready, {
          ...(selectedWorkspace ? { workspace: selectedWorkspace } : {}),
        });
        publishDevInstanceReady(instance, bootstrap);
        if (bootstrap.status === "invite-required") {
          console.warn(
            `[instance:${instance.id}] CLI is not paired. Create a device invite, then run ` +
              `\`pnpm cli --instance ${instance.id} remote pair <invite>\`.`
          );
        } else if (!terminal) {
          console.log(
            `[instance:${instance.id}] CLI ${bootstrap.status}; workspace=${bootstrap.workspaceName}`
          );
        }
      },
    },
  });
  resources.supervisor = supervisor;
  await supervisor.start();
  return supervisor;
}

async function runDesktop(
  forwarded: string[],
  env: NodeJS.ProcessEnv,
  instance: DevInstanceRecord,
  resources: { preparation?: WorkspaceReleasePreparation; supervisor?: DevInstanceSupervisor }
): Promise<DevInstanceSupervisor> {
  await run(process.execPath, ["scripts/native-host-dependencies.mjs", "--repair"], { env });
  // Desktop launches share the repository host artifacts with parallel
  // developer instances. The coordinator waits for an in-flight build and
  // reuses its verified output; invoking build.mjs directly would clean the
  // shared dist/ while another instance is starting its workspace runtime.
  await run(process.execPath, ["scripts/ensure-host-build.mjs"], { env });
  env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] = readCurrentHostBuildGeneration(process.cwd(), "desktop");
  resources.preparation = prepareLaunchTemplates(env, instance.root, instance.generationId);
  await resources.preparation.completed;
  const supervisor = new DevInstanceSupervisor({
    sourceRoot: fs.realpathSync(process.cwd()),
    command: process.execPath,
    args: ["scripts/run-electron.mjs", ...forwarded],
    env,
    stdio: "inherit",
    forwardParentSignals: true,
  });
  resources.supervisor = supervisor;
  await supervisor.start();
  return supervisor;
}

const TERMINAL_HELP = `pnpm terminal — run this checkout's server and open the terminal browser

Usage: pnpm terminal [--instance <id>] [--ephemeral] [--workspace <name>] [--yes]

  --instance <id>     Use a named persistent isolated instance (default: source).
                      When that instance is already running, attach to it.
  --ephemeral         Use a temporary instance root, removed on exit.
  --workspace <name>  Show this workspace (default: your Personal workspace).
  --yes               Approve startup approvals once without asking.

Build, template and server output go to <instanceRoot>/logs/server.log.
Quitting the browser stops and joins the server this command started.
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

/** A live instance with this id, or null when none is running. */
function liveInstance(repoRoot: string, id: string): DevInstanceRecord | null {
  let record: DevInstanceRecord;
  try {
    record = readDevInstanceRecord(repoRoot, id);
  } catch {
    return null;
  }
  try {
    process.kill(record.supervisorPid, 0);
    return record;
  } catch {
    return null;
  }
}

/**
 * Open the terminal browser against an instance another supervisor owns,
 * through the same command a user runs: `vibestudio terminal`.
 */
async function attachTerminal(
  repoRoot: string,
  instance: DevInstanceRecord,
  terminalArgs: string[]
): Promise<number> {
  process.env["VIBESTUDIO_APP_ROOT"] = repoRoot;
  process.env["VIBESTUDIO_INSTANCE_ROOT"] = instance.root;
  process.env["VIBESTUDIO_INSTANCE"] = instance.id;
  console.log(`Instance ${instance.id} is already running; attaching to it.`);
  if (instance.kind === "server") await waitForDevInstanceReady(instance);
  const { main: runCli } = await import("../cli/client.js");
  return await runCli(["terminal", ...terminalArgs]);
}

/** Run the browser against the server this supervisor owns; returns the exit status. */
async function runOwnedTerminal(
  terminal: TerminalLaunch,
  supervisor: DevInstanceSupervisor
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
    const credentials = requireDeviceCliCredentials(loaded, "pnpm terminal");
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
      stdin: process.stdin,
      stdout: process.stdout,
      progress: (line) => console.log(line),
    });
    return command.reportTerminalExit(exit, terminal.logFile);
  } catch (error) {
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
  if (
    terminalOptions &&
    !hasFlag(parsed.forwarded, "--ephemeral") &&
    liveInstance(repoRoot, parsed.instanceId ?? "source")
  ) {
    process.exitCode = await attachTerminal(
      repoRoot,
      liveInstance(repoRoot, parsed.instanceId ?? "source")!,
      [
        ...(terminalOptions.workspace ? ["--workspace", terminalOptions.workspace] : []),
        ...(terminalOptions.yes ? ["--yes"] : []),
      ]
    );
    return;
  }
  if (mode === "server" && hasFlag(parsed.forwarded, "--help")) {
    console.log(`Developer instance options:
  --instance <id>  Use a named persistent isolated instance (default: source)
  --ephemeral      Use an isolated temporary instance root; combine with
                   --instance to give parallel CLI commands a stable target
  --template-checkouts <path>
                   Complete registry-defined official template source root
  --extra-template-checkout <path>
                   Add a non-official template checkout (repeatable)
  --workspace-checkout <path>
                   Open this checkout as an additional workspace
  --production-templates Ignore configured checkouts and boot the pinned releases
`);
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "development" };
    await run(process.execPath, ["build.mjs", "--source-server-prereqs"], { env });
    env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] = readCurrentHostBuildGeneration(process.cwd(), "source");
    process.exitCode = await run(
      process.execPath,
      [path.join(env["VIBESTUDIO_HOST_ARTIFACT_ROOT"]!, "server.mjs"), ...parsed.forwarded],
      { env }
    );
    return;
  }
  const disposable = hasFlag(parsed.forwarded, "--ephemeral");
  // `--ephemeral` selects a disposable instance root and nothing else. It is
  // consumed here so that no launcher further down can read a second meaning
  // into the same word.
  const forwarded = withoutFlag(parsed.forwarded, "--ephemeral");
  const id = parsed.instanceId ?? (disposable ? generatedInstanceId(mode) : "source");
  const root = disposable ? createEphemeralInstanceRoot(id) : persistentInstanceRoot(repoRoot, id);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const instance = registerDevInstance({
    id,
    root,
    repoRoot,
    supervisorPid: process.pid,
    kind: mode,
    lifecycle: disposable ? "ephemeral" : "persistent",
    startedAt: Date.now(),
  });
  const terminal = terminalOptions ? openTerminalLog(root, terminalOptions) : undefined;
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
  const resources: {
    preparation?: WorkspaceReleasePreparation;
    supervisor?: DevInstanceSupervisor;
  } = {};
  try {
    const defaultTemplates =
      (await resolveDevelopmentTemplateSet({
        repoRoot,
        checkpointRoot: checkpointTarget,
        ...(parsed.templateCheckouts ? { explicitRoot: parsed.templateCheckouts } : {}),
        productionTemplates: parsed.productionTemplates,
      })) ?? undefined;
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
    const sourceCoupled = id === "source" && !disposable;
    const env = developmentInstanceEnvironment({
      parent: process.env,
      repoRoot,
      instanceRoot: root,
      instanceId: id,
      sourceCoupled,
      disposable,
      ...(defaultTemplates ? { defaultTemplates } : {}),
      ...(targetWorkspace ? { initialWorkspaceTemplate: targetWorkspace.pin } : {}),
      ...(developmentTemplates.length ? { templates: developmentTemplates } : {}),
    });
    process.env["VIBESTUDIO_INSTANCE_ROOT"] = root;
    process.env["VIBESTUDIO_INSTANCE"] = id;

    // Only the lock owner may mutate this instance's readiness marker. Once
    // registered, concurrent CLI readers reject an older generation.
    if (mode === "server") clearDevInstanceReady(instance);
    detail(`[instance:${id}] ${instance.lifecycle} ${mode} state: ${root}`);
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
      supervisor = await runServer(launchArgs, env, instance, resources, terminal);
      const browser = runOwnedTerminal(terminal, supervisor);
      process.exitCode = await Promise.race([
        browser,
        resources.preparation!.completed.then(() => browser),
      ]);
      console.log("Stopping the server…");
    } else {
      supervisor =
        mode === "server"
          ? await runServer(launchArgs, env, instance, resources)
          : await runDesktop(launchArgs, env, instance, resources);
      const foreground = supervisor.wait();
      process.exitCode = await Promise.race([
        foreground,
        resources.preparation!.completed.then(() => foreground),
      ]);
    }
  } catch (error) {
    retirementFailed = (error as NodeJS.ErrnoException)?.code === "EOWNERSHIP";
    launchFailure = error;
    // The log is inside the instance root, which an ephemeral launch removes.
    if (terminal) reportTerminalStartupFailure(error, terminal);
  } finally {
    try {
      // Storage belongs to the full process lifetime, including failed
      // startup and relaunch. Never remove source checkpoints before joining
      // every acknowledged native owner.
      const retirement = await Promise.allSettled([
        resources.supervisor?.stop(),
        resources.preparation?.stop(),
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
        await new Promise<void>((resolve) => terminal.log.end(() => resolve()));
        fs.closeSync(terminal.logFd);
        if (!retirementFailure) console.log("Server stopped.");
      }
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
