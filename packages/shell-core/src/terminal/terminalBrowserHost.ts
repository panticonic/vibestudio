/**
 * Contract between the `vibestudio terminal` CLI (trusted client) and the
 * workspace's terminal browser app (`hostTargets.terminal.app`).
 *
 * The CLI fetches the server-built primary artifact of the terminal app,
 * imports it in the CLI process, and calls its exported `run(host)`. The
 * browser owns the TTY until `run` settles. The CLI owns the RPC connection,
 * the app-principal identity, and (when it started one) the local server process.
 */
import type { RpcClient } from "@vibestudio/rpc";

export const TERMINAL_BROWSER_HOST_CONTRACT_VERSION = 1 as const;

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
  /** App-principal RPC client (callerKind "app", selfId === appId). */
  rpc: RpcClient;
  appId: string;
  workspace: TerminalBrowserWorkspace;
  server: TerminalBrowserServerInfo;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  connectionState(): TerminalServerConnectionState;
  onConnectionState(listener: (state: TerminalServerConnectionState) => void): () => void;
  /** Lists workspaces the paired device may select. */
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
