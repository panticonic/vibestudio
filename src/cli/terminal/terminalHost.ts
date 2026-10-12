import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createRpcClient, type RpcConnectionStatus } from "@vibestudio/rpc";
import type { RecoveryKind } from "@vibestudio/rpc/protocol/recoveryCoordinator";
import {
  TERMINAL_BROWSER_HOST_CONTRACT_VERSION,
  type TerminalBrowserExit,
  type TerminalBrowserHost,
  type TerminalBrowserModule,
  type TerminalBrowserServerInfo,
  type TerminalBrowserWorkspace,
  type TerminalServerConnectionState,
} from "@vibestudio/shell-core/terminal/terminalBrowserHost";
import {
  AppPrincipalGrantResponseSchema,
  type AppPrincipalGrantResponse,
} from "@vibestudio/service-schemas/auth";
import { CliError } from "../output.js";
import type { PrincipalTransport, RpcClient } from "../rpcClient.js";
import { guardTerminal } from "./ttyRestore.js";

/** Requests the device's terminal-app principal over the CLI's own connection. */
export async function requestTerminalAppGrant(
  device: Pick<RpcClient, "call">,
  source: string | null
): Promise<AppPrincipalGrantResponse> {
  return AppPrincipalGrantResponseSchema.parse(
    await device.call("auth.grantAppPrincipal", [{ principal: "terminal-app", source }])
  );
}

/**
 * Fetch the terminal app's primary ESM module — exactly the build its
 * principal is bound to — and import it into this process.
 *
 * The bytes travel over the CLI's authenticated connection (`gateway.fetch`),
 * so a remote Iroh server works like a local one. The module is written to a
 * private scratch directory only so Node can import it with a file URL (and
 * stack traces name a file); the directory is removed once it is loaded.
 */
export async function loadTerminalBrowserModule(
  device: Pick<RpcClient, "stream">,
  app: AppPrincipalGrantResponse["app"]
): Promise<TerminalBrowserModule> {
  const entry = app.artifacts.filter((artifact) => artifact.role === "primary");
  if (entry.length !== 1 || !entry[0]!.path.endsWith(".mjs")) {
    throw new CliError(
      `The terminal app ${app.source} has no single ESM entry module in build ${app.buildKey}.`
    );
  }
  const response = await device.stream("main", "gateway.fetch", [
    { path: entry[0]!.route, method: "GET" },
  ]);
  if (!response.ok) {
    throw new CliError(
      `Could not download the terminal app (${app.source}): HTTP ${response.status} ` +
        `${(await response.text()).slice(0, 200)}`
    );
  }
  const source = Buffer.from(await response.arrayBuffer());
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-terminal-app-"));
  try {
    const file = path.join(scratch, path.basename(entry[0]!.path));
    fs.writeFileSync(file, source, { mode: 0o600 });
    const loaded = (await import(pathToFileURL(file).href)) as Partial<TerminalBrowserModule>;
    if (typeof loaded.run !== "function") {
      throw new CliError(
        `The terminal app ${app.source} does not export run(host). It was built for an ` +
          "older terminal contract; update the workspace's System template."
      );
    }
    return loaded as TerminalBrowserModule;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Connection state reported to the browser. `reconnecting` follows the
 * transport's own recovery; `lost` is set only by an authoritative terminal
 * event (session closed by the server, owned server exited, app updated).
 */
export class TerminalConnectionState {
  private state: TerminalServerConnectionState = { phase: "connected" };
  private readonly listeners = new Set<(state: TerminalServerConnectionState) => void>();

  constructor(private readonly endpoint: string) {}

  current(): TerminalServerConnectionState {
    return this.state;
  }

  subscribe(listener: (state: TerminalServerConnectionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  transportStatus(status: RpcConnectionStatus): void {
    if (this.state.phase === "lost") return;
    if (status === "connected") this.set({ phase: "connected" });
    else if (this.state.phase === "connected") {
      this.set({ phase: "reconnecting", cause: `connection to ${this.endpoint} interrupted` });
    }
  }

  lose(cause: string): void {
    if (this.state.phase === "lost") return;
    this.set({ phase: "lost", cause });
  }

  get lost(): boolean {
    return this.state.phase === "lost";
  }

  private set(state: TerminalServerConnectionState): void {
    this.state = state;
    for (const listener of [...this.listeners]) listener(state);
  }
}

export interface TerminalBrowserRunOptions {
  /** The CLI's device connection, routed to the browser's workspace. */
  device: RpcClient;
  grant: AppPrincipalGrantResponse;
  module: TerminalBrowserModule;
  workspace: TerminalBrowserWorkspace;
  server: TerminalBrowserServerInfo;
  /** Owned server lifetime: its exit is an authoritative terminal event. */
  serverExited?: Promise<string>;
  listWorkspaces(): Promise<TerminalBrowserWorkspace[]>;
  openExternal(url: string): Promise<void>;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

export type TerminalBrowserRunResult =
  | { kind: "exit"; exit: TerminalBrowserExit }
  /** The app's active build changed under a running browser; load the new one. */
  | { kind: "app-updated" };

/**
 * Connect the app principal over the device's transport, hand the browser
 * its host, and run it until it settles. The terminal is restored on every
 * exit path, including errors and `process.exit` inside the app.
 */
export async function runTerminalBrowser(
  options: TerminalBrowserRunOptions
): Promise<TerminalBrowserRunResult> {
  const { device, grant } = options;
  const state = new TerminalConnectionState(options.server.endpoint);
  let appUpdated = false;
  let initialGrant: string | null = grant.connectionGrant;
  // Every (re)authentication redeems a fresh one-use grant for the same
  // principal. A grant bound to another build means the app was updated:
  // the running module can no longer be the principal's executable.
  const getToken = async (): Promise<string> => {
    if (state.lost) throw new CliError(`terminal session ended: ${describeLost(state)}`);
    if (initialGrant) {
      const token = initialGrant;
      initialGrant = null;
      return token;
    }
    const next = await requestTerminalAppGrant(device, grant.app.source);
    if (next.app.buildKey !== grant.app.buildKey) {
      appUpdated = true;
      state.lose("the terminal app was updated; reloading it");
      throw new CliError("the terminal app was updated");
    }
    return next.connectionGrant;
  };
  const recoveryHandlers = new Set<(kind: RecoveryKind) => void>();
  const transport: PrincipalTransport = await device.openPrincipalTransport({
    selfId: grant.callerId,
    getToken,
    clientLabel: "Vibestudio terminal",
    onRecovery: (kind) => {
      for (const handler of [...recoveryHandlers]) handler(kind);
    },
    onTerminalClose: (error) => state.lose(error.message),
  });
  const unsubscribeStatus = transport.onStatusChange((status) => state.transportStatus(status));
  void options.serverExited?.then((cause) => state.lose(cause));
  const lifetime = new AbortController();
  const rpc = createRpcClient({
    selfId: grant.callerId,
    callerKind: "app",
    transport,
    lifetime: lifetime.signal,
    onRecovery: (handler) => {
      recoveryHandlers.add(handler);
      return () => recoveryHandlers.delete(handler);
    },
  });
  const host: TerminalBrowserHost = {
    contractVersion: TERMINAL_BROWSER_HOST_CONTRACT_VERSION,
    rpc,
    appId: grant.callerId,
    workspace: options.workspace,
    server: options.server,
    stdin: options.stdin,
    stdout: options.stdout,
    connectionState: () => state.current(),
    onConnectionState: (listener) => state.subscribe(listener),
    listWorkspaces: () => options.listWorkspaces(),
    openExternal: (url) => options.openExternal(url),
    readLocalFile,
  };
  const releaseTerminal = guardTerminal(options.stdin, options.stdout);
  try {
    const exit = await options.module.run(host);
    return appUpdated ? { kind: "app-updated" } : { kind: "exit", exit };
  } finally {
    releaseTerminal();
    unsubscribeStatus();
    lifetime.abort(new Error("terminal browser exited"));
    await transport.close();
  }
}

function describeLost(state: TerminalConnectionState): string {
  const current = state.current();
  return current.phase === "lost" ? current.cause : current.phase;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".html": "text/html",
};

/** Read a local file the user chose in the browser (`~` expands to the home directory). */
export async function readLocalFile(
  requested: string
): Promise<{ name: string; bytes: Uint8Array; mimeType?: string }> {
  const expanded =
    requested === "~" || requested.startsWith("~/")
      ? path.join(os.homedir(), requested.slice(1))
      : requested;
  const resolved = path.resolve(expanded);
  const stat = await fs.promises.stat(resolved).catch((error: NodeJS.ErrnoException) => {
    throw new CliError(
      error.code === "ENOENT"
        ? `No such file: ${resolved}`
        : `Cannot read ${resolved}: ${error.message}`
    );
  });
  if (!stat.isFile()) throw new CliError(`Not a regular file: ${resolved}`);
  const bytes = new Uint8Array(await fs.promises.readFile(resolved));
  const mimeType = MIME_BY_EXTENSION[path.extname(resolved).toLowerCase()];
  return { name: path.basename(resolved), bytes, ...(mimeType ? { mimeType } : {}) };
}
