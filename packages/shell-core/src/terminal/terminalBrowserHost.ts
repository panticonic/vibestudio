/**
 * Contract between the `vibestudio terminal` CLI (trusted client) and the
 * workspace's terminal browser app (`hostTargets.terminal.app`).
 *
 * The CLI fetches the server-built primary artifact of the terminal app,
 * imports it in the CLI process, and calls its exported `run(host)`. The
 * browser owns the TTY until `run` settles. The CLI owns the RPC connections,
 * the app-principal identity, and (when it started one) the local server process.
 *
 * Like the desktop shell, the browser is a System-workspace app that shows
 * another workspace: its own state (session registry, settings) lives in the
 * System workspace and is reached through `rpc` as the app principal, while
 * terminal apps, their sessions and their approvals belong to the workspace
 * the person is working in (`workspace`, by default their Personal
 * workspace) and are reached through `workspaceRpc`, this device's own
 * connection to that workspace.
 */
import type { RpcClient } from "@vibestudio/rpc";

export const TERMINAL_BROWSER_HOST_CONTRACT_VERSION = 2 as const;

export type TerminalServerConnectionState =
  | { phase: "connected" }
  | { phase: "reconnecting"; cause: string }
  /** Authoritative terminal event (credential revoked, owned server exited, ...). */
  | { phase: "lost"; cause: string };

export interface TerminalBrowserServerInfo {
  /** `owned`: this CLI invocation started the server and stops it when `run` settles. */
  kind: "attached" | "owned";
  /** Human-readable endpoint (URL or Iroh label) for the status bar. */
  endpoint: string;
  /** Server stdio log, when the server is owned by this invocation. */
  logFile?: string;
}

export interface TerminalBrowserWorkspace {
  id: string;
  name: string;
}

export interface TerminalBrowserHost {
  contractVersion: typeof TERMINAL_BROWSER_HOST_CONTRACT_VERSION;
  /** App-principal RPC client in the System workspace (callerKind "app", selfId === appId). */
  rpc: RpcClient;
  appId: string;
  /** The account's System workspace, where the browser itself is installed. */
  system: TerminalBrowserWorkspace;
  /** The workspace the browser shows: its terminal apps, sessions and approvals. */
  workspace: TerminalBrowserWorkspace;
  /**
   * This device's RPC client for `workspace` (callerKind "shell"), the same
   * identity the desktop shell uses for the workspace it shows. When
   * `workspace` is the System workspace it is a separate session there.
   */
  workspaceRpc: RpcClient;
  server: TerminalBrowserServerInfo;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  connectionState(): TerminalServerConnectionState;
  onConnectionState(listener: (state: TerminalServerConnectionState) => void): () => void;
  /** Lists workspaces the paired device may select (for `switch-workspace`). */
  listWorkspaces(): Promise<TerminalBrowserWorkspace[]>;
  /** Opens a URL on the user's machine (CLI-side, after browser-side confirmation). */
  openExternal(url: string): Promise<void>;
  /** Reads a local file the user explicitly chose. */
  readLocalFile(path: string): Promise<{ name: string; bytes: Uint8Array; mimeType?: string }>;
}

export type TerminalBrowserExit =
  | { kind: "quit" }
  | { kind: "switch-workspace"; workspaceId: string }
  | { kind: "connection-lost"; cause: string };

export interface TerminalBrowserModule {
  run(host: TerminalBrowserHost): Promise<TerminalBrowserExit>;
}
