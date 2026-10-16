/**
 * The terminal host ABI `terminal-host-1`: the complete contract between the
 * `vibestudio` CLI (the trusted terminal host) and a `terminal`-runtime client
 * (docs/client-hosts-and-clients-plan.md §4.2, §5.2).
 *
 * The host asks the server to launch a client (`clients.launch`), fetches its
 * primary artifact into a verified cache, checks the manifest's `hostAbi`
 * against this ABI, imports the verified module in the CLI process and calls
 * its exported `run(host)`. The client owns the TTY until `run` settles. The
 * host owns the device credential, the RPC connections, the client's principal
 * identity, the terminal-restore guard (`guardTerminal`) and, when it started
 * one, the local server process.
 *
 * Host modules are capability-gated: `files`, `clipboard` and `notify` exist
 * only when the server granted the client `local-files`, `clipboard` or
 * `notifications`. A client never reaches a host power it was not granted.
 *
 * A client that shows another workspace (the terminal browser, like the
 * desktop shell) keeps its own state in the System workspace, reached through
 * `rpc` as its principal; the shown workspace is reached through
 * `workspaceRpc`, this device's own connection to it.
 */
import type { RpcClient } from "@vibestudio/rpc";
import type { ClientCapability } from "@vibestudio/workspace-contracts/clients";

export type TerminalServerConnectionState =
  | { phase: "connected" }
  | { phase: "reconnecting"; cause: string }
  /** Authoritative terminal event (credential revoked, owned server exited, ...). */
  | { phase: "lost"; cause: string };

export interface TerminalClientServerInfo {
  /** `owned`: this CLI invocation started the server and stops it when `run` settles. */
  kind: "attached" | "owned";
  /** Human-readable endpoint (URL or Iroh label) for the status bar. */
  endpoint: string;
  /** Server stdio log, when the server is owned by this invocation. */
  logFile?: string;
}

export interface TerminalClientWorkspace {
  id: string;
  /**
   * What the person sees: "Personal" and "System" for the account's private
   * pair, otherwise the workspace's display name or name. Never the private
   * pair's internal names; `id` identifies the workspace.
   */
  name: string;
}

/** The running client build, as the server admitted and the host verified it. */
export interface TerminalClientIdentity {
  /** Product id (`browser`, `chat`, ...). */
  id: string;
  /** The client's source in the System workspace. */
  source: string;
  buildKey: string;
  /** Capabilities the server granted this build; modules for the rest are absent. */
  grantedCapabilities: readonly ClientCapability[];
}

/** The intent this client was launched with (§4.7.1), `params` as the person gave them. */
export interface TerminalClientIntent {
  name: string;
  params: Readonly<Record<string, string>>;
}

export interface TerminalFileResult {
  path: string;
  size: number;
}

/**
 * Trusted, explicit file gestures on the client computer. Every call names one
 * path the person chose (typed, picked or dropped): there is no directory
 * listing, no enumeration and no ambient access, so consent is per path. A
 * client must never derive a path the person did not give.
 */
export interface TerminalClientFiles {
  upload(
    input: { contextId: string; localPath: string; workspacePath: string },
    options?: { signal?: AbortSignal }
  ): Promise<TerminalFileResult>;
  download(
    input: { contextId: string; workspacePath: string; localPath: string },
    options?: { signal?: AbortSignal }
  ): Promise<TerminalFileResult>;
  /** Save a user-selected text artifact; existing files are never overwritten. */
  saveText(
    input: { localPath: string; text: string },
    options?: { signal?: AbortSignal }
  ): Promise<TerminalFileResult>;
  /** Read one regular file the person attached (8 MB at most). */
  read(
    input: { localPath: string },
    options?: { signal?: AbortSignal }
  ): Promise<TerminalFileResult & { bytes: Uint8Array }>;
}

/** Writes to the person's clipboard through the terminal (OSC 52); the host owns the escape. */
export interface TerminalClipboard {
  write(text: string): void;
}

export interface TerminalNotification {
  title: string;
  body?: string;
}

/**
 * Desktop notification through the terminal emulator (OSC 9, 777 or 99 chosen by
 * the detected terminal); the terminal bell where the terminal has none.
 */
export interface TerminalNotifier {
  notify(notification: TerminalNotification): void;
}

/**
 * Persisted settings scoped to this client on this device. The host owns the
 * storage; a client sees one JSON object it reads and replaces whole.
 */
export interface TerminalClientState {
  get(): Promise<Record<string, unknown>>;
  set(settings: Record<string, unknown>): Promise<void>;
}

/** A newer ready build of this client than the one running. */
export interface TerminalClientUpdate {
  buildKey: string;
  effectiveVersion: string | null;
  previousBuildKey: string | null;
}

/**
 * The host's observation of this client's updates (§4.6). The server announces
 * a ready build; the terminal host never swaps a running client's code. The
 * client decides when it is safe to be re-entered: it calls
 * `restartAtSafePoint()` at that moment, `run` settles, and the host launches
 * the client again on the newest build. A client that never asks keeps running
 * its build and the next launch uses the new one. In development mode (a host
 * setting for this client on this device) the host re-enters the client
 * itself as soon as a build is ready, so a client must be re-enterable at any
 * time: its state belongs on the server or in `state`.
 */
export interface TerminalClientUpdates {
  /** The newest ready build not yet adopted, or null. */
  pending(): TerminalClientUpdate | null;
  onUpdate(listener: (update: TerminalClientUpdate) => void): () => void;
  /** Declare that this client is at a safe point: end this run and re-enter on the pending build. */
  restartAtSafePoint(): void;
}

export interface TerminalClientHost {
  client: TerminalClientIdentity;
  /** The intent the client was launched with, or null for a plain open. */
  intent: TerminalClientIntent | null;
  /** The client principal's RPC session in the System workspace (callerKind "client"). */
  rpc: RpcClient;
  /** The account's System workspace, where the client itself is installed. */
  system: TerminalClientWorkspace;
  /** The workspace the client shows. */
  workspace: TerminalClientWorkspace;
  /**
   * This device's RPC client for `workspace` (callerKind "shell"), the same
   * identity the desktop shell uses for the workspace it shows. When
   * `workspace` is the System workspace it is a separate session there.
   */
  workspaceRpc: RpcClient;
  server: TerminalClientServerInfo;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  connectionState(): TerminalServerConnectionState;
  onConnectionState(listener: (state: TerminalServerConnectionState) => void): () => void;
  /** Lists workspaces the paired device may select (for `switch-workspace`). */
  listWorkspaces(): Promise<TerminalClientWorkspace[]>;
  /** Opens a URL on the user's machine (host-side, after client-side confirmation). */
  openExternal(url: string): Promise<void>;
  /** Present only with the `local-files` capability. */
  files?: TerminalClientFiles;
  /** Present only with the `clipboard` capability. */
  clipboard?: TerminalClipboard;
  /** Present only with the `notifications` capability. */
  notify?: TerminalNotifier;
  state: TerminalClientState;
  update: TerminalClientUpdates;
  /** The CLI invocation's authoritative cancellation lifetime. */
  signal: AbortSignal;
}

export type TerminalClientExit =
  | { kind: "quit" }
  | { kind: "switch-workspace"; workspaceId: string }
  | { kind: "connection-lost"; cause: string };

export interface TerminalClientModule {
  run(host: TerminalClientHost): Promise<TerminalClientExit>;
}
