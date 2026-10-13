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
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  /** One concise progress line for the user (before the browser takes over). */
  progress(line: string): void;
  /** Test seams. */
  dependencies?: Partial<TerminalSessionDependencies>;
}

export interface TerminalSessionDependencies {
  route(
    credentials: DeviceCredential,
    selector: RemoteWorkspaceSelector
  ): Promise<DeviceCredential>;
  createDevice(credentials: DeviceCredential): RpcClient;
  listWorkspaces(control: RpcClient): Promise<RemoteWorkspaceEntry[]>;
  runGate: typeof runTerminalLaunchGate;
  requestGrant: typeof requestTerminalAppGrant;
  loadModule: typeof loadTerminalBrowserModule;
  runBrowser: typeof runTerminalBrowser;
  openExternal(url: string): Promise<void>;
}

const DEFAULT_DEPENDENCIES: TerminalSessionDependencies = {
  route: selectRemoteWorkspace,
  createDevice: (credentials) => new RpcClient(credentials),
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
    const system = await deps.route(options.credentials, { privateRole: "system" });
    const shown = await deps.route(options.credentials, selector);
    const result = await runOnce(system, shown, options, deps);
    if (result.kind === "app-updated") {
      options.progress("The terminal app was updated; loading the new version…");
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
  options: TerminalSessionsOptions,
  deps: TerminalSessionDependencies
): Promise<Awaited<ReturnType<typeof runTerminalBrowser>>> {
  const device = deps.createDevice(systemRoute);
  // One System connection carries the gate, the grant, the module download and
  // the app principal's session (a second session on the same Iroh connection).
  const releaseDevice = device.retainConnection();
  let control: RpcClient | null = null;
  let workspaceDevice: RpcClient | null = null;
  // Workspaces as the person sees them: by label, never by internal name.
  const listWorkspaces = async (): Promise<TerminalBrowserWorkspace[]> => {
    control ??= await device.openControlConnection();
    return (await deps.listWorkspaces(control)).map((entry) => ({
      id: entry.workspaceId,
      name: workspaceLabel(entry),
    }));
  };
  try {
    const visible = await listWorkspaces();
    const routed = (route: DeviceCredential): TerminalBrowserWorkspace => {
      const entry = visible.find((candidate) => candidate.id === route.workspaceId);
      if (!entry) throw new CliError("The selected workspace is not visible to this account.");
      return entry;
    };
    const system = routed(systemRoute);
    const workspace = routed(shownRoute);
    options.progress(`Preparing the terminal browser in ${system.name}…`);
    const gate = await deps.runGate(device, {
      target: "terminal",
      yes: options.yes,
      input: options.stdin,
      output: options.stdout,
      onProgress: (line) => options.progress(line),
    });
    if (gate.status === "denied") {
      throw new CliError("Terminal startup was declined; nothing was started.");
    }
    if (gate.launch?.status !== "ready") {
      const reason = gate.launch && "reason" in gate.launch ? gate.launch.reason : gate.status;
      throw new CliError(
        `The terminal browser is not available in ${system.name}: ${reason}. ` +
          "The System workspace must declare it under hostTargets.terminal.app in meta/vibestudio.yml."
      );
    }
    const grant = await deps.requestGrant(device, gate.launch.entity.source || null);
    options.progress("Loading the terminal browser…");
    const module = await deps.loadModule(device, grant.app);
    // The workspace the browser shows is reached as this device, exactly as
    // the desktop shell reaches the workspace it shows.
    workspaceDevice =
      workspace.id === system.id ? device : await device.openWorkspaceConnection(shownRoute);
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
    });
  } finally {
    const openControl = control as RpcClient | null;
    const openWorkspace = workspaceDevice as RpcClient | null;
    await Promise.allSettled([
      openControl?.close(),
      openWorkspace && openWorkspace !== device ? openWorkspace.close() : undefined,
      releaseDevice(),
    ]);
    await device.close();
  }
}
