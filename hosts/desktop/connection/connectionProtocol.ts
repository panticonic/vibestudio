import type { RpcFailure } from "@vibestudio/rpc";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import type { RemoteTransportDiagnostics } from "@vibestudio/shared/types";
import type { StartupConnectionProgress } from "../../../src/startupConnectionProgress.js";
import type { ConnectionStatus, ScopedServerCaller } from "../main/serverClient.js";
import type {
  DeviceCredentialEntry,
  StoredRemote,
} from "../main/services/deviceCredentialStore.js";
import type { ConnectedStartupMode } from "../main/startupMode.js";
import type { NativeIpcCaller } from "./uiSessions.js";
import type { ConnectPairing } from "@vibestudio/iroh-transport";
import type { LaunchState, LaunchedClient } from "@vibestudio/client-host-core";
import type { ClientSelection, HostDescriptor } from "@vibestudio/workspace-contracts/clients";

/**
 * The control vocabulary between the Electron main process and the connection
 * utility process. Every name here is one `ControlChannel` request or event.
 *
 * Main asks the connection process to establish and own the hub connection and
 * to bind a renderer document's port to a session. The connection process asks
 * main for the few things only main can answer: the OS keystore, native
 * dialogs, the host-owned services each workspace runtime registers, and panel
 * leases.
 */

/** What main can observe of one server client without asking. */
export interface ClientState {
  /** The client's handle in the connection process. */
  handle: number;
  status: ConnectionStatus;
  closed: boolean;
  diagnostics: RemoteTransportDiagnostics | null;
  /** Whether the transport can probe a possibly-dead pipe. */
  canNudge: boolean;
}

/** One workspace's connection: the plain facts main needs, plus its client. */
export interface WorkspaceDescriptor {
  client: ClientState;
  nativeStorageScope: string;
  connectionMode: "local" | "remote";
  serverOwnership: "desktop-local" | "external";
  protocol: "http" | "https";
  gatewayPort: number;
  externalHost: string;
  gatewayConfig: { serverUrl: string; workspace?: string };
  workerdPort: number;
  workspaceName: string;
  workspaceId: string;
  workspacePath: string;
  statePath: string;
  workspaceConfig: WorkspaceConfig;
  /** The port panels load their assets from (the gateway, or the remote asset facade). */
  panelPort: number;
  /** Whether this connection has a panel asset facade with diagnostics. */
  hasAssetFacade: boolean;
  /** The bearer the CDP host's loopback socket uses (empty over Iroh). */
  cdpAuthToken: string;
}

export interface SessionDescriptor extends WorkspaceDescriptor {
  initialFocusedWorkspaceId?: string;
  hubControl: ClientState;
  /** Whether this desktop owns a local hub process it may stop. */
  hasHubProcess: boolean;
}

export interface EstablishArgs {
  mode: ConnectedStartupMode | null;
  /** Ask the hub to start the initial focus workspace while System is built. */
  prepareInitialWorkspace: boolean;
  pendingPairing?: ConnectPairing;
  pendingPairLabel?: string;
  storedRemote?: StoredRemote;
  appVersion: string;
  userDataPath: string;
}

/** The control methods main calls on the connection process. */
export interface MainToConnection {
  "connection.establish": { args: EstablishArgs };
  "connection.close": Record<string, never>;
  "hub.prepare-workspace": { workspaceId: string };
  "hub.detach": Record<string, never>;
  "hub.begin-shutdown": Record<string, never>;
  "hub.stop-tree": Record<string, never>;
  "workspace.connect": { workspaceId: string };
  "workspace.close": { workspaceId: string };
  "workspace.asset-diagnostics": { workspaceId: string };
  "client.call": ClientCall;
  "client.stream": ClientCall & { readable: boolean };
  "client.subscribe": { handle: number; event: string };
  "client.unsubscribe": { handle: number; event: string };
  "client.expose": { handle: number; method: string; stream: boolean };
  "client.nudge": { handle: number };
  "client.close": { handle: number };
  "launch.start": { launchId: number; descriptor: HostDescriptor; select: ClientSelection };
  "launch.clients-changed": { launchId: number };
  "launch.resolve-approvals": { launchId: number; decision: "once" | "deny" };
  "launch.end": { launchId: number };
  "launch.retain": { retained: RetainedClientBuild[] };
  "artifacts.read": { integrity: string };
  "ports.bind": { binding: NativeIpcCaller & PortBindingState };
  "ports.hold-client-session": { caller: NativeIpcCaller };
  "ports.update": { callerId: string; client: ClientBindingState };
  "ports.release": { callerId: string };
  "ports.shutdown": Record<string, never>;
  "ports.retire": { callerId: string };
  "ports.revoke-ui": { callerId: string };
  "ports.deliver-shell": { workspaceId: string; event: string; payload: unknown };
  "catalog.invalidate": { workspaceId: string };
}

/**
 * What the launcher reports to main. The one-use connection grant stays in the
 * connection process, which is the only place a grant is redeemed.
 */
export type LaunchedClientWire = Omit<LaunchedClient, "grant"> & { principalId: string };
export type LaunchStateWire =
  | Exclude<LaunchState, { state: "ready" }>
  | { state: "ready"; launched: LaunchedClientWire };

/** The verified artifacts a running client's builds still need cached. */
export interface RetainedClientBuild {
  clientId: string;
  integrities: string[];
}

export interface ClientCall {
  handle: number;
  /** Present for calls made as a hosted client principal. */
  as?: ScopedServerCaller;
  /** A routed runtime target, instead of a service. */
  target?: string;
  service: string;
  method: string;
  args: unknown[];
  options?: unknown;
}

/** The capability state of a client window, kept current as the host changes it. */
export interface ClientBindingState {
  capabilities: readonly string[];
  /** The sealed identity of the build the window runs. */
  executionDigest: string;
  effectiveVersion: string;
  /** The window's principal and the workspace it is registered in. */
  principalId: string;
  workspaceId: string;
}

export interface PortBindingState {
  /** Hosts the panel surface: shell-addressed panel events land on this document. */
  hostsPanels: boolean;
  client?: ClientBindingState;
}

/** The control methods and events the connection process directs at main. */
export interface ConnectionToMain {
  "host.confirm-existing-hub": { pid: number; gatewayPort: number };
  "host.credential-load": { serverId: string };
  "host.credential-save": { credential: DeviceCredentialEntry };
  "host.credential-preflight": Record<string, never>;
  "host.dispatch": HostDispatch;
  "host.catalog": { workspaceId: string };
  "host.ensure-workspace": { workspaceId: string };
  "host.panel-lease": { callerId: string };
  "host.call": { handle: number; method: string; args: unknown[] };
  "host.stream": { handle: number; method: string; args: unknown[] };
  "client.recovery": { handle: number; kind: "resubscribe" | "cold-recover" };
}

/** A call to a service main owns, made on behalf of an authenticated renderer. */
export interface HostDispatch {
  workspaceId: string;
  callerId: string;
  callerKind: "client" | "panel";
  requestId: string;
  service: string;
  method: string;
  args: unknown[];
  idempotencyKey?: string;
  readOnly?: boolean;
}

/** Events from the connection process; none expects an answer. */
export interface ConnectionEvents {
  "startup-progress": StartupConnectionProgress;
  "initial-workspace": { workspaceId: string };
  "connection-status": ConnectionStatus;
  "transport-diagnostics": RemoteTransportDiagnostics | null;
  "reconnect-progress": {
    attempt: number;
    phase: "scheduled" | "failed";
    reason: string;
    nextRetryInMs?: number;
  };
  "local-recovery-failure": RpcFailure;
  "terminal-close": RpcFailure;
  "credential-save-failed": RpcFailure;
  "client.status": ClientState;
  "client.event": { handle: number; event: string; payload: unknown };
  "launch.state": { launchId: number; state: LaunchStateWire };
  /** A hosted client principal's session ended for good (`trust-revoked`, `retired`, ...). */
  "clients.session-ended": { caller: ScopedServerCaller; reason: string };
  "cdp-token": { workspaceId: string; token: string };
  "host.observe-failure": {
    workspaceId: string;
    callerId: string;
    callerKind: "client" | "panel";
    requestId: string;
    service: string;
    method: string;
    error: RpcFailure;
  };
}
