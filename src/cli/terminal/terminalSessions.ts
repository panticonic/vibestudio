import type {
  TerminalBrowserExit,
  TerminalBrowserServerInfo,
  TerminalBrowserWorkspace,
} from "@vibestudio/shell-core/terminal/terminalBrowserHost";
import { openExternalBrowser } from "../../node/openExternalBrowser.js";
import { workspaceLabel } from "../../node/workspaceLabel.js";
import { CliError } from "../output.js";
import {
  listWorkspacesVia,
  selectRemoteWorkspace,
  type RemoteWorkspaceEntry,
  type RemoteWorkspaceSelector,
} from "../remoteClient.js";
import { RpcClient, type DeviceCredential } from "../rpcClient.js";
import { runTerminalLaunchGate } from "../terminalLaunchGate.js";
import type { LaunchProgress } from "./launchProgress.js";
import { runOwnedCleanupSteps, runWithOwnedCleanup } from "../../../scripts/lib/owned-cleanup.mjs";
import {
  loadTerminalBrowserModule,
  requestTerminalAppGrant,
  runTerminalBrowser,
} from "./terminalHost.js";

export interface TerminalSessionsOptions {
  /** The paired device credential (any selected workspace). */
  credentials: DeviceCredential;
  /**
   * The workspace the browser shows. Defaults to the account's Personal
   * workspace, as the desktop does. The browser itself always runs from the
   * account's System workspace, where client apps are installed.
   */
  workspace?: RemoteWorkspaceSelector;
  server: TerminalBrowserServerInfo;
  /** Owned server lifetime; its exit ends the browser with that cause. */
  serverExited?: Promise<string>;
  /** Approve startup approvals once without prompting. */
  yes: boolean;
  /** The owner's termination request; it ends a startup prompt that is still open. */
  signal?: AbortSignal;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  /** What is happening while the browser is made ready, before it takes the terminal. */
  progress: LaunchProgress;
  /** Test seams. */
  dependencies?: Partial<TerminalSessionDependencies>;
}

export interface TerminalSessionDependencies {
  route(
    credentials: DeviceCredential,
    selector: RemoteWorkspaceSelector,
    options?: { signal?: AbortSignal }
  ): Promise<DeviceCredential>;
  createDevice(credentials: DeviceCredential, options?: { signal?: AbortSignal }): RpcClient;
  listWorkspaces(control: RpcClient): Promise<RemoteWorkspaceEntry[]>;
  runGate: typeof runTerminalLaunchGate;
  requestGrant: typeof requestTerminalAppGrant;
  loadModule: typeof loadTerminalBrowserModule;
  runBrowser: typeof runTerminalBrowser;
  openExternal(url: string): Promise<void>;
}

const DEFAULT_DEPENDENCIES: TerminalSessionDependencies = {
  route: selectRemoteWorkspace,
  createDevice: (credentials, owner) => new RpcClient(credentials, owner),
  listWorkspaces: listWorkspacesVia,
  runGate: runTerminalLaunchGate,
  requestGrant: requestTerminalAppGrant,
  loadModule: loadTerminalBrowserModule,
  runBrowser: runTerminalBrowser,
  openExternal: (url) => openExternalBrowser(url),
};

/**
 * Run the terminal browser until the user quits or the connection is lost.
 *
 * Each pass routes to the account's System workspace, runs the launch gate
 * (build, approvals, activation) there while the terminal is still in line
 * mode, obtains the device's terminal-app principal, imports the exact module
 * that principal is bound to, and runs it showing the selected workspace. A
 * `switch-workspace` exit shows the chosen workspace in another pass; so does
 * an app update observed while reconnecting.
 */
export async function runTerminalSessions(
  options: TerminalSessionsOptions
): Promise<TerminalBrowserExit> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  let selector: RemoteWorkspaceSelector = options.workspace ?? { privateRole: "personal" };
  for (;;) {
    options.signal?.throwIfAborted();
    const routing = options.signal ? { signal: options.signal } : undefined;
    const system = routing
      ? await deps.route(options.credentials, { privateRole: "system" }, routing)
      : await deps.route(options.credentials, { privateRole: "system" });
    const shown = routing
      ? await deps.route(options.credentials, selector, routing)
      : await deps.route(options.credentials, selector);
    const showsPersonal =
      typeof selector === "object" &&
      "privateRole" in selector &&
      selector.privateRole === "personal";
    const personal = showsPersonal
      ? shown
      : routing
        ? await deps.route(options.credentials, { privateRole: "personal" }, routing)
        : await deps.route(options.credentials, { privateRole: "personal" });
    const result = await runOnce(system, shown, personal, options, deps);
    if (result.kind === "app-updated") {
      options.progress.note("The terminal app was updated; loading the new version…");
      continue;
    }
    if (result.exit.kind === "switch-workspace") {
      selector = { workspaceId: result.exit.workspaceId };
      continue;
    }
    return result.exit;
  }
}

async function runOnce(
  systemRoute: DeviceCredential,
  shownRoute: DeviceCredential,
  personalRoute: DeviceCredential,
  options: TerminalSessionsOptions,
  deps: TerminalSessionDependencies
): Promise<Awaited<ReturnType<typeof runTerminalBrowser>>> {
  const device = options.signal
    ? deps.createDevice(systemRoute, { signal: options.signal })
    : deps.createDevice(systemRoute);
  // One System connection carries the gate, the grant, the module download and
  // the app principal's session (a second session on the same Iroh connection).
  const releaseDevice = device.retainConnection();
  let control: RpcClient | null = null;
  let workspaceDevice: RpcClient | null = null;
  let personalDevice: RpcClient | null = null;
  // Workspaces as the person sees them: by label, never by internal name.
  const listWorkspaces = async (): Promise<TerminalBrowserWorkspace[]> => {
    control ??= await device.openControlConnection();
    return (await deps.listWorkspaces(control)).map((entry) => ({
      id: entry.workspaceId,
      name: workspaceLabel(entry),
    }));
  };
  return runWithOwnedCleanup(
    async () => {
      const visible = await listWorkspaces();
      const routed = (route: DeviceCredential): TerminalBrowserWorkspace => {
        const entry = visible.find((candidate) => candidate.id === route.workspaceId);
        if (!entry) throw new CliError("The selected workspace is not visible to this account.");
        return entry;
      };
      const system = routed(systemRoute);
      const workspace = routed(shownRoute);
      const prepare = options.progress.step(`Preparing the terminal browser in ${system.name}`);
      let gate: Awaited<ReturnType<typeof deps.runGate>>;
      try {
        // The account's Personal workspace starts with System: whether its code
        // may run is asked in the same gate, not again once the browser is up.
        if (personalRoute.workspaceId !== systemRoute.workspaceId)
          personalDevice = await device.openWorkspaceConnection(personalRoute);
        gate = await deps.runGate(device, {
          ...(personalDevice ? { companions: [personalDevice] } : {}),
          target: "terminal",
          yes: options.yes,
          input: options.stdin,
          output: options.stdout,
          onProgress: (line) => prepare.note(line),
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        prepare.fail();
        throw error;
      }
      if (gate.status === "denied") {
        prepare.fail();
        throw new CliError("Terminal startup was declined; nothing was started.");
      }
      if (gate.launch?.status !== "ready") {
        const reason = gate.launch && "reason" in gate.launch ? gate.launch.reason : gate.status;
        prepare.fail();
        throw new CliError(
          `The terminal browser is not available in ${system.name}: ${reason}. ` +
            "The System workspace must declare it under hostTargets.terminal.app in meta/vibestudio.yml."
        );
      }
      prepare.done();
      const load = options.progress.step("Loading the terminal browser");
      let grant: Awaited<ReturnType<typeof deps.requestGrant>>;
      let module: Awaited<ReturnType<typeof deps.loadModule>>;
      try {
        grant = options.signal
          ? await deps.requestGrant(device, gate.launch.entity.source || null, {
              signal: options.signal,
            })
          : await deps.requestGrant(device, gate.launch.entity.source || null);
        module = options.signal
          ? await deps.loadModule(device, grant.app, { signal: options.signal })
          : await deps.loadModule(device, grant.app);
        // The workspace the browser shows is reached as this device, exactly as
        // the desktop shell reaches the workspace it shows.
        workspaceDevice =
          workspace.id === system.id
            ? device
            : workspace.id === personalRoute.workspaceId && personalDevice
              ? personalDevice
              : await device.openWorkspaceConnection(shownRoute);
      } catch (error) {
        load.fail();
        throw error;
      }
      load.done();
      return await deps.runBrowser({
        device,
        workspaceDevice,
        grant,
        module,
        system,
        workspace,
        server: options.server,
        ...(options.serverExited ? { serverExited: options.serverExited } : {}),
        listWorkspaces,
        openExternal: deps.openExternal,
        stdin: options.stdin,
        stdout: options.stdout,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    },
    async () => {
      const openControl = control as RpcClient | null;
      const openWorkspace = workspaceDevice as RpcClient | null;
      const openPersonal = personalDevice as RpcClient | null;
      await runOwnedCleanupSteps(
        [
          async () => {
            const results = await Promise.allSettled([
              openControl?.close(),
              openWorkspace && openWorkspace !== device ? openWorkspace.close() : undefined,
              openPersonal && openPersonal !== openWorkspace ? openPersonal.close() : undefined,
              releaseDevice(),
            ]);
            const failures = [
              ...new Set(
                results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
              ),
            ];
            if (failures.length === 1) throw failures[0];
            if (failures.length)
              throw new AggregateError(failures, "Terminal connections could not all be closed");
          },
          () => device.close(),
        ],
        "Terminal connection retirement failed"
      );
    },
    "Terminal browser operation and retirement failed"
  );
}
