import type {
  TerminalBrowserExit,
  TerminalBrowserServerInfo,
  TerminalBrowserWorkspace,
} from "@vibestudio/shell-core/terminal/terminalBrowserHost";
import { openExternalBrowser } from "../../node/openExternalBrowser.js";
import { CliError } from "../output.js";
import {
  listWorkspacesVia,
  selectRemoteWorkspace,
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
   * Where the browser opens. Defaults to the account's System workspace: the
   * terminal browser is a client app, and client apps are installed there,
   * exactly as the desktop shell's own connection is.
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
  runGate: typeof runTerminalLaunchGate;
  requestGrant: typeof requestTerminalAppGrant;
  loadModule: typeof loadTerminalBrowserModule;
  runBrowser: typeof runTerminalBrowser;
  openExternal(url: string): Promise<void>;
}

const DEFAULT_DEPENDENCIES: TerminalSessionDependencies = {
  route: selectRemoteWorkspace,
  createDevice: (credentials) => new RpcClient(credentials),
  runGate: runTerminalLaunchGate,
  requestGrant: requestTerminalAppGrant,
  loadModule: loadTerminalBrowserModule,
  runBrowser: runTerminalBrowser,
  openExternal: (url) => openExternalBrowser(url),
};

/**
 * Run the terminal browser until the user quits or the connection is lost.
 *
 * Each pass routes to the browser's workspace, runs the launch gate (build,
 * approvals, activation) while the terminal is still in line mode, obtains
 * the device's terminal-app principal, imports the exact module that
 * principal is bound to, and runs it. A `switch-workspace` exit routes to the
 * chosen workspace and runs another pass; so does an app update observed
 * while reconnecting.
 */
export async function runTerminalSessions(
  options: TerminalSessionsOptions
): Promise<TerminalBrowserExit> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  let selector: RemoteWorkspaceSelector = options.workspace ?? { privateRole: "system" };
  for (;;) {
    const routed = await deps.route(options.credentials, selector);
    const result = await runOnce(routed, options, deps);
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
  routed: DeviceCredential,
  options: TerminalSessionsOptions,
  deps: TerminalSessionDependencies
): Promise<Awaited<ReturnType<typeof runTerminalBrowser>>> {
  const workspace: TerminalBrowserWorkspace = {
    id: routed.workspaceId,
    name: routed.workspaceName,
  };
  const device = deps.createDevice(routed);
  // One device connection carries the gate, the grant, the module download and
  // the app principal's session (a second session on the same Iroh connection).
  const releaseDevice = device.retainConnection();
  let control: RpcClient | null = null;
  try {
    options.progress(`Preparing the terminal app in ${workspace.name}…`);
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
        `The terminal app is not available in ${workspace.name}: ${reason}. ` +
          "Its workspace must declare it under hostTargets.terminal.app in meta/vibestudio.yml."
      );
    }
    const grant = await deps.requestGrant(device, gate.launch.entity.source || null);
    options.progress("Loading the terminal app…");
    const module = await deps.loadModule(device, grant.app);
    return await deps.runBrowser({
      device,
      grant,
      module,
      workspace,
      server: options.server,
      ...(options.serverExited ? { serverExited: options.serverExited } : {}),
      listWorkspaces: async () => {
        control ??= await device.openControlConnection();
        return (await listWorkspacesVia(control)).map((entry) => ({
          id: entry.workspaceId,
          name: entry.name,
        }));
      },
      openExternal: deps.openExternal,
      stdin: options.stdin,
      stdout: options.stdout,
    });
  } finally {
    const openControl = control as RpcClient | null;
    await Promise.allSettled([openControl?.close(), releaseDevice()]);
    await device.close();
  }
}
