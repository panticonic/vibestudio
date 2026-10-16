import type {
  PanelAssetDiagnostics,
  PanelHttpServerLike,
} from "@vibestudio/shared/panelInterfaces";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import type { ProcessTreeTerminationResult } from "../../../scripts/owned-process-tree.mjs";
import type { ServerClient } from "./serverClient.js";
import type { ServerInfo } from "./serverInfo.js";
import type { WorkspaceSessionDirectory } from "./workspaceSessionDirectory.js";

/**
 * The desktop's connection as the Electron main process holds it.
 *
 * The connection itself (the hub, its logical sessions, the local hub process
 * and the remote asset facade) lives in the connection utility process; these
 * are the facts main needs about it and its clients, whose calls cross the
 * control channel. Renderer traffic never does.
 */
export interface WorkspaceSessionConnection {
  nativeStorageScope: string;
  connectionMode: "local" | "remote";
  /**
   * Who controls the server process: "desktop-local" means this app manages a
   * detached local hub (quit policy applies); "external" means
   * someone else owns it (remote Iroh server).
   */
  serverOwnership: "desktop-local" | "external";
  protocol: "http" | "https";
  gatewayPort: number;
  externalHost: string;
  gatewayConfig: { serverUrl: string; workspace?: string };
  workerdPort: number;
  /** Exact hub workspace selected by this desktop session. */
  workspaceName: string;
  workspaceId: string;
  workspacePath: string;
  statePath: string;
  workspaceConfig: WorkspaceConfig;
  /** Exact selected-workspace session. All workspace services belong here. */
  serverClient: ServerClient;
  /** Idempotently close every transport/facade owned by this session. */
  close(): Promise<void>;
  panelHttpServer: PanelHttpServerLike;
  serverInfo: ServerInfo;
  /**
   * Short-lived shell bearer for the CDP host's loopback socket (local only;
   * remote runs the RPC-channel CDP path with no token). Refreshed by the
   * connection process on every (re)connect and pushed here.
   */
  getCdpAuthToken: () => string;
  /** The remote asset facade's counters; null when this connection has none. */
  assetDiagnostics(): Promise<PanelAssetDiagnostics | null>;
}

/** The local hub process this desktop may stop, owned by the connection process. */
export interface HubProcessHandle {
  /** Leave the hub running and stop supervising it. */
  detach(): Promise<void>;
  beginShutdown(): Promise<void>;
  stopTree(): Promise<ProcessTreeTerminationResult>;
}

export interface SessionConnection extends WorkspaceSessionConnection {
  initialFocusedWorkspaceId?: string;
  /** Stable control transport, independent of panel focus and workspace connections. */
  hubControlClient: ServerClient;
  hubProcessManager: HubProcessHandle | null;
  workspaceSessions: WorkspaceSessionDirectory<WorkspaceSessionConnection>;
}
