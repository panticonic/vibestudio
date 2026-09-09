import { nativeStorageScope } from "./nativeStorageScope.js";
/**
 * ServerSession — server connection establishment.
 *
 * Subsumes local attach-or-spawn vs remote connect and workspace info fetch.
 * Returns a single SessionConnection with everything needed to continue
 * startup. There is ONE auth model in all topologies: device pairing +
 * refresh credentials. Locally the desktop owns a detached hub and routes into
 * a child over its loopback proxy; remotely it reaches the child over Iroh.
 */

import { app } from "electron";
import { createHash, randomBytes } from "node:crypto";
import * as path from "node:path";
import { createDevLogger } from "@vibestudio/dev-log";
import { getAppRoot, getServerProcessBuildId } from "./paths.js";
import { HubProcessManager } from "./hubProcessManager.js";
import { createServerClient, type ServerClient, type ConnectionStatus } from "./serverClient.js";
import type { DeviceCredential } from "@vibestudio/rpc/protocol/wsProtocol";
import { startPanelAssetFacade } from "../node/panelAssets/panelAssetFacade.js";
import { relaunchApp } from "./relaunchApp.js";
import {
  preflightDeviceCredentialStoreForPairing,
  saveDeviceCredential,
  type StoredRemote,
} from "./services/deviceCredentialStore.js";
import type { PanelHttpServerLike } from "@vibestudio/shared/panelInterfaces";
import type { RemoteTransportDiagnostics } from "@vibestudio/shared/types";
import type { ServerInfo } from "./serverInfo.js";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import type { CentralDataManager, HubProcessLeaseRecord } from "@vibestudio/shared/centralData";
import type { ConnectedStartupMode } from "./startupMode.js";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { workspaceMethods } from "@vibestudio/service-schemas/workspace";
import {
  hubControlMethods,
  HubWorkspaceRouteSchema,
  type HubWorkspaceRoute,
} from "@vibestudio/service-schemas/hubControl";
import { WorkspaceSessionDirectory } from "./workspaceSessionDirectory.js";
import { serverAuthRouteUrl, serverRpcWsUrl } from "@vibestudio/shared/connect";
import { assertIrohReach, type ConnectPairing, type IrohReach } from "@vibestudio/iroh-transport";
import { DesktopIrohConnectionSupervisor } from "./desktopIrohConnectionSupervisor.js";
import { registerOwnedHubWithDevRunner } from "./devRunnerHubRegistration.js";
import {
  FRESH_REMOTE_STARTUP_CONNECTION_PHASES,
  LOCAL_STARTUP_CONNECTION_PHASES,
  RETURNING_REMOTE_STARTUP_CONNECTION_PHASES,
  startupConnectionProgress,
  type StartupConnectionPhase,
  type StartupConnectionPhaseId,
  type StartupConnectionProgress,
} from "../startupConnectionProgress.js";

const log = createDevLogger("ServerSession");

async function throwAfterOwnedCleanup(
  failure: unknown,
  resources: ReadonlyArray<{ label: string; close: () => Promise<void> }>,
  context: string
): Promise<never> {
  const settled = await Promise.allSettled(resources.map((resource) => resource.close()));
  const cleanupFailures = settled.flatMap((result, index) => {
    if (result.status !== "rejected") return [];
    const resource = resources[index];
    return resource
      ? [new Error(`${resource.label} cleanup failed`, { cause: result.reason })]
      : [new Error("Unknown session resource cleanup failed", { cause: result.reason })];
  });
  if (cleanupFailures.length === 0) throw failure;
  throw new AggregateError(
    [failure, ...cleanupFailures],
    `${context} failed and owned resources could not all be released`
  );
}

function ownSessionResources(
  resources: ReadonlyArray<{ label: string; close: () => Promise<void> }>
): () => Promise<void> {
  let closing: Promise<void> | null = null;
  return () => {
    if (closing) return closing;
    closing = (async () => {
      const settled = await Promise.allSettled(resources.map((resource) => resource.close()));
      const failures = settled.flatMap((result, index) => {
        if (result.status !== "rejected") return [];
        const resource = resources[index];
        return resource
          ? [new Error(`${resource.label} close failed`, { cause: result.reason })]
          : [new Error("Unknown session resource close failed", { cause: result.reason })];
      });
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Session resources could not all be closed");
      }
    })();
    return closing;
  };
}

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
  gatewayConfig: { serverUrl: string };
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
   * remote runs the RPC-channel CDP path with no token). Refreshed from the
   * device refresh credential via the loopback `/refresh-shell` route on every
   * (re)connect.
   */
  getCdpAuthToken: () => string;
}

export interface SessionConnection extends WorkspaceSessionConnection {
  initialFocusedWorkspaceId?: string;
  /** Stable control transport, independent of panel focus and workspace connections. */
  hubControlClient: ServerClient;
  hubProcessManager: HubProcessManager | null;
  workspaceSessions: WorkspaceSessionDirectory<WorkspaceSessionConnection>;
}

function createStartupPhaseReporter(
  context: string,
  phases: readonly StartupConnectionPhase[],
  onProgress: ((progress: StartupConnectionProgress) => void) | undefined
): (phase: StartupConnectionPhaseId) => void {
  const beganAt = Date.now();
  return (phaseId) => {
    const progress = startupConnectionProgress(phases, phaseId);
    const phase = progress.phases.find((candidate) => candidate.id === phaseId);
    log.info(`[Server] ${context} +${Date.now() - beganAt}ms: ${phase?.label ?? phaseId}`);
    onProgress?.(progress);
  };
}

/**
 * Build the ServerInfo object that provides RPC proxying and gateway wiring.
 */
function buildServerInfo(
  gatewayPort: number,
  externalHost: string,
  protocol: "http" | "https",
  gatewayConfig: { serverUrl: string },
  getClient: () => ServerClient
): ServerInfo {
  return {
    gatewayConfig,
    workerdPort: 0,
    externalHost,
    gatewayPort,
    protocol,
    call: (service, method, args) => getClient().call(service, method, args),
  };
}

/**
 * Connect to a remote server over the Iroh pipe (the only remote transport;
 * §8 deleted the direct-wss/TLS-pin path). The QR-pairing flow hands its parsed
 * `ConnectPairing` (Endpoint ID, ordered relays, one-time code, and expiry)
 * here, along with the shell-token provider derived from the persisted device
 * credential.
 */
export interface IrohReconnectProgress {
  attempt: number;
  phase: "scheduled" | "failed";
  reason: string;
  nextRetryInMs?: number;
}

/**
 * Establish a server session. Three branches, in precedence order:
 *
 *   (a) FRESH pair — `args.pendingPairing` carries a pairing link the bootstrap
 *       chooser redeemed THIS launch.
 *   (b) Returning device — a pairing explicitly selected by the startup
 *       orchestrator (Iroh).
 *   (c) Local — attach to a healthy detached local workspace server, or spawn
 *       one, and connect over loopback WS with device-pairing auth.
 */
export async function establishServerSession(args: {
  mode: ConnectedStartupMode | null;
  pendingPairing?: ConnectPairing;
  /** Human-readable label for a freshly-paired device (from the pairing dialog). */
  pendingPairLabel?: string;
  /**
   * Saved remote selected by the startup orchestrator. Session establishment
   * never chooses a target implicitly; explicit local/chooser intent therefore
   * cannot be stolen by credential-store state.
   */
  storedRemote?: StoredRemote;
  centralData: CentralDataManager;
  confirmExistingLocalHub?: (
    lease: HubProcessLeaseRecord
  ) => Promise<"attach" | "replace" | "cancel">;
  /** Structured startup progress for the bootstrap timeline. */
  onStartupProgress?: (progress: StartupConnectionProgress) => void;
  onConnectionStatusChanged?: (status: ConnectionStatus) => void;
  onTransportDiagnosticsChanged?: (diagnostics: RemoteTransportDiagnostics | null) => void;
  onReconnectProgress?: (progress: IrohReconnectProgress) => void;
  onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>;
  onMainSessionTerminalClose?: (error: Error) => void;
}): Promise<SessionConnection> {
  const { mode, pendingPairing, storedRemote } = args;

  // (a) FRESH pair: the bootstrap chooser handed us a pairing link this launch.
  if (pendingPairing) {
    return establishFreshPairSession(pendingPairing, args, args.pendingPairLabel);
  }
  // (b) Returning device: a paired Iroh remote persisted on a prior launch.
  if (storedRemote) {
    return establishRemoteSession(storedRemote, args);
  }
  // (c) Local attach-or-spawn.
  if (!mode) {
    throw new Error(
      "establishServerSession: no connected startup mode, fresh pairing, or stored remote pairing"
    );
  }

  const protocol = "http" as const;
  const externalHost = "localhost";
  const hubProcessManager = new HubProcessManager({
    workspaceName: mode.workspaceName,
    ephemeral: mode.isEphemeral,
    ephemeralLifecycle: mode.ephemeralLifecycle,
    appRoot: getAppRoot(),
    appVersion: app.getVersion(),
    buildId: getServerProcessBuildId(),
    centralData: args.centralData,
    confirmExistingHub: args.confirmExistingLocalHub,
    onCrash: (code) => {
      console.error(`[App] Local hub died and could not be recovered (code ${code ?? "?"})`);
      relaunchApp({ exitCode: 1 });
    },
    onOwnedHubSpawn: registerOwnedHubWithDevRunner,
  });
  const phase = createStartupPhaseReporter(
    "local connect",
    LOCAL_STARTUP_CONNECTION_PHASES,
    args.onStartupProgress
  );
  phase("start-local-server");
  const target = await hubProcessManager.attachOrSpawn({
    onHubReady: () => phase("connect-workspace"),
  });
  log.info(
    `[Server] ${target.attached ? "Attached to" : "Spawned"} local hub and routed ${mode.workspaceName}`
  );
  const gatewayConfig = { serverUrl: target.serverUrl };

  let cdpAuthToken = "";
  const refreshCdpAuthToken = async (): Promise<void> => {
    const serverUrl = hubProcessManager.getCurrentServerUrl();
    if (!serverUrl) return;
    try {
      const response = await fetch(serverAuthRouteUrl(serverUrl, "refresh-shell"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: target.deviceId,
          refreshToken: target.refreshToken,
        }),
      });
      if (!response.ok) {
        log.warn(`[Server] child refresh-shell failed with ${response.status}`);
        return;
      }
      const payload = (await response.json()) as { shellToken?: string };
      if (payload.shellToken) cdpAuthToken = payload.shellToken;
    } catch (error) {
      log.warn(
        `[Server] child refresh-shell error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const serverClient = await createServerClient(target.gatewayPort, target.authToken, {
    reconnect: true,
    clientPlatform: "desktop",
    oauthCallbackMode: "client-loopback",
    getWsUrl: () => hubProcessManager.getCurrentWsUrl() ?? target.wsUrl,
    refreshAuthToken: async () => hubProcessManager.getAuthToken(),
    onConnectionStatusChanged: (status) => {
      if (status === "connecting") hubProcessManager.handleDisconnect();
      if (status === "connected") void refreshCdpAuthToken();
      args.onConnectionStatusChanged?.(status);
    },
    onRecovery: args.onRecovery,
    onDisconnect: () => console.error("[App] Local workspace connection closed"),
  });
  let hubControlClient: ServerClient | null = null;
  try {
    hubControlClient = await createServerClient(
      target.gatewayPort,
      await hubProcessManager.getHubAuthToken(),
      {
        reconnect: true,
        clientPlatform: "desktop",
        oauthCallbackMode: "client-loopback",
        getWsUrl: () => hubProcessManager.getHubWsUrl(),
        refreshAuthToken: () => hubProcessManager.getHubAuthToken(),
        onDisconnect: () => console.error("[App] Local hub control connection closed"),
      }
    );
    const connectedHubControlClient = hubControlClient;
    phase("prepare-workspace-session");
    await refreshCdpAuthToken();

    log.info("[Server] Shell client connected through the local hub");

    const getClient = () => serverClient;
    const serverInfo = buildServerInfo(
      target.gatewayPort,
      externalHost,
      protocol,
      gatewayConfig,
      getClient
    );

    // Get workspace metadata from server
    const workspaceClient = createTypedServiceClient("workspace", workspaceMethods, (svc, m, a) =>
      serverClient.call(svc, m, a)
    );
    const wsInfo = await workspaceClient.getInfo();
    log.info(`[Workspace] Server workspace: ${wsInfo.config.id}`);

    const gatewayPort = target.gatewayPort;
    const panelHttpServer: PanelHttpServerLike = {
      getBuildRevision: () => undefined,
      invalidateBuild: () => {},
      getPort: () => gatewayPort,
    };

    const storageScope = nativeStorageScope("local", target.serverId, target.deviceId);
    const initial: WorkspaceSessionConnection = {
      nativeStorageScope: storageScope,
      connectionMode: "local",
      serverOwnership: "desktop-local",
      protocol,
      gatewayPort,
      externalHost,
      gatewayConfig,
      workerdPort: 0,
      workspaceName: target.workspaceName,
      workspaceId: wsInfo.config.id,
      workspacePath: wsInfo.path,
      /** The local server's own state directory (same host). */
      statePath: wsInfo.statePath,
      workspaceConfig: wsInfo.config,
      serverClient,
      close: ownSessionResources([
        { label: "local workspace client", close: () => serverClient.close() },
      ]),
      panelHttpServer,
      serverInfo,
      getCdpAuthToken: () => cdpAuthToken,
    };
    const workspaceSessions = new WorkspaceSessionDirectory(initial, async (workspaceId) => {
      const route = HubWorkspaceRouteSchema.parse(
        await connectedHubControlClient.call("hubControl", "routeWorkspace", [{ workspaceId }])
      );
      return connectLocalWorkspace(route, target.deviceId, target.refreshToken, storageScope);
    });
    return {
      ...initial,
      initialFocusedWorkspaceId: target.initialFocusedWorkspaceId,
      hubControlClient: connectedHubControlClient,
      hubProcessManager,
      workspaceSessions,
      close: ownSessionResources([
        { label: "local workspace sessions", close: () => workspaceSessions.close() },
        { label: "local hub control client", close: () => connectedHubControlClient.close() },
      ]),
    };
  } catch (error) {
    hubProcessManager.detach();
    return throwAfterOwnedCleanup(
      error,
      [
        ...(hubControlClient
          ? [
              {
                label: "local hub control client",
                close: hubControlClient.close.bind(hubControlClient),
              },
            ]
          : []),
        { label: "local workspace client", close: () => serverClient.close() },
      ],
      "Local session establishment"
    );
  }
}

/** The connect-callback subset both remote-session paths forward to the pipe. */
type RemoteConnectArgs = {
  onStartupProgress?: (progress: StartupConnectionProgress) => void;
  onConnectionStatusChanged?: (status: ConnectionStatus) => void;
  onTransportDiagnosticsChanged?: (diagnostics: RemoteTransportDiagnostics | null) => void;
  onReconnectProgress?: (progress: IrohReconnectProgress) => void;
  onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>;
  onMainSessionTerminalClose?: (error: Error) => void;
};

function createDesktopIrohSupervisor(
  endpointSecret: Uint8Array,
  relays: readonly string[]
): DesktopIrohConnectionSupervisor {
  return new DesktopIrohConnectionSupervisor(endpointSecret, relays);
}

/**
 * Connect to a paired Iroh remote as the RETURNING device and shape it into a
 * {@link SessionConnection}. The shell re-authenticates with its refresh token
 * (`refresh:<deviceId>:<refreshToken>`); the RPC plane rides the pipe exactly as
 * the local loopback-WS plane does.
 */
async function establishRemoteSession(
  stored: StoredRemote,
  args: RemoteConnectArgs,
  origin: "fresh pairing" | "returning device" = "returning device"
): Promise<SessionConnection> {
  let current = stored;
  const rotate = (credential: DeviceCredential): void => {
    current = {
      ...current,
      deviceId: credential.deviceId,
      refreshToken: credential.refreshToken,
      rotatedAt: Date.now(),
    };
    saveDeviceCredential(current);
  };
  const auth = () => `refresh:${current.deviceId}:${current.refreshToken}`;
  const supervisor = createDesktopIrohSupervisor(
    Buffer.from(stored.endpointSecret, "base64url"),
    stored.controlPairing.relays
  );
  const phase = createStartupPhaseReporter(
    "remote connect",
    RETURNING_REMOTE_STARTUP_CONNECTION_PHASES,
    args.onStartupProgress
  );
  phase("connect-server-and-workspace");
  try {
    const hubControlClient = await supervisor.connect(stored.controlPairing, {
      callerId: `shell:${stored.deviceId}`,
      getShellToken: auth,
      onPaired: rotate,
    });
    const hub = createTypedServiceClient("hubControl", hubControlMethods, (svc, method, args) =>
      hubControlClient.call(svc, method, args)
    );
    const pair = await hub.ensureUserWorkspaces();
    const visible = await hub.listWorkspaces();
    const initialFocusedWorkspaceId =
      visible.find((entry) => entry.name === stored.workspaceName)?.workspaceId ??
      pair.personal.workspaceId;
    const route = await hub.routeWorkspace({ workspaceId: pair.system.workspaceId });
    const serverClient = await supervisor.connect(storedReach(route.workspaceReach), {
      callerId: `shell:${stored.deviceId}`,
      getShellToken: auth,
      onPaired: rotate,
      onConnectionStatusChanged: args.onConnectionStatusChanged,
      onTransportDiagnosticsChanged: args.onTransportDiagnosticsChanged,
      onReconnectProgress: args.onReconnectProgress,
      onRecovery: args.onRecovery,
      onMainSessionTerminalClose: args.onMainSessionTerminalClose,
    });
    phase("prepare-workspace-session");
    const connection = await buildRemoteSessionConnection(
      serverClient,
      hubControlClient,
      route.workspace,
      nativeStorageScope("iroh", stored.controlPairing.endpointId, stored.deviceId),
      () => supervisor.close(),
      (route) =>
        supervisor.connect(storedReach(route.workspaceReach), {
          callerId: `shell:${current.deviceId}`,
          getShellToken: auth,
          onPaired: rotate,
        })
    );
    log.info(`[Server] Shell client connected over Iroh (${origin})`);
    return { ...connection, initialFocusedWorkspaceId };
  } catch (error) {
    return throwAfterOwnedCleanup(
      error,
      [{ label: "remote Iroh connection supervisor", close: () => supervisor.close() }],
      "Returning remote session establishment"
    );
  }
}

/**
 * Pair a FRESH device on the stable hub, resolve its exact workspace reach, then
 * hand off to a distinct workspace pipe. The hub pipe is control-plane only; it
 * never masquerades as a workspace RPC session.
 */
async function establishFreshPairSession(
  pairing: ConnectPairing,
  args: RemoteConnectArgs,
  label?: string
): Promise<SessionConnection> {
  assertIrohReach(pairing);
  const endpointSecretBytes = randomBytes(32);
  const endpointSecret = endpointSecretBytes.toString("base64url");
  const supervisor = createDesktopIrohSupervisor(endpointSecretBytes, pairing.relays);
  const paired: {
    current: {
      credential: { deviceId: string; refreshToken: string };
      /** Null for a root-bootstrap invite: no workspace exists to bind yet. */
      workspaceId: string | null;
    } | null;
  } = {
    current: null,
  };
  let currentStored: StoredRemote | null = null;
  let codeOffered = false;
  const phase = createStartupPhaseReporter(
    "fresh pairing",
    FRESH_REMOTE_STARTUP_CONNECTION_PHASES,
    args.onStartupProgress
  );
  phase("check-credential-storage");
  preflightDeviceCredentialStoreForPairing();
  phase("redeem-pairing-link");
  let controlClient: ServerClient;
  try {
    controlClient = await supervisor.connect(pairing, {
      // The server assigns the real `shell:<deviceId>` principal when it redeems the
      // one-time code; we don't know that id yet, so dial with a stable selfId. (If
      // the resolved id is ever threaded back, swap it in here.)
      callerId: "shell:pairing",
      getShellToken: () => {
        const credential = paired.current?.credential;
        if (credential) return `refresh:${credential.deviceId}:${credential.refreshToken}`;
        // The invite is one-time. Replaying it after the server already
        // redeemed it reports "link expired" and buries whatever actually
        // failed, so refuse the replay and keep the real failure visible.
        if (codeOffered) {
          throw new Error(
            "The server already redeemed this pairing link, but the issued device credential was lost before it could be saved. Request a fresh pairing link."
          );
        }
        codeOffered = true;
        return pairing.code;
      },
      // Persist the issued device credential against the pairing material (minus the
      // one-time code) so the NEXT launch reconnects via refresh:<deviceId>:<token>.
      onPaired: (credential, context) => {
        if (!paired.current) {
          // A root-bootstrap invite is bound to no workspace (none exists yet),
          // so the server sends no pairing context. Throwing here would discard
          // a credential the one-time code has already been spent on; the
          // workspace is resolved through ensureUserWorkspaces() below.
          paired.current = { credential, workspaceId: context?.workspaceId ?? null };
        } else {
          paired.current = { ...paired.current, credential };
        }
        if (currentStored) {
          currentStored = {
            ...currentStored,
            deviceId: credential.deviceId,
            refreshToken: credential.refreshToken,
            rotatedAt: Date.now(),
          };
          persistFreshDeviceCredential(currentStored);
        }
      },
    });
  } catch (error) {
    await supervisor.close().catch(() => undefined);
    throw error;
  }
  let workspaceClient: ServerClient | null = null;
  try {
    if (!paired.current) {
      throw new Error(
        "Fresh Iroh pairing completed without an issued device credential — mint a new invite and try again."
      );
    }
    const issued = paired.current;
    phase("resolve-workspace");
    const hub = createTypedServiceClient("hubControl", hubControlMethods, (svc, method, args) =>
      controlClient.call(svc, method, args)
    );
    const pair = await hub.ensureUserWorkspaces();
    const requested = await hub.routeWorkspace({
      workspaceId: issued.workspaceId ?? pair.system.workspaceId,
    });
    const route = await hub.routeWorkspace({ workspaceId: pair.system.workspaceId });
    const { code: _code, ...stableHubReach } = pairing;
    const controlPairing = storedReach(stableHubReach);
    const workspacePairing = storedReach(route.workspaceReach);
    currentStored = {
      serverId: route.serverId,
      transport: "iroh",
      endpointSecret,
      controlPairing,
      workspacePairing,
      workspaceName: requested.workspace,
      deviceId: issued.credential.deviceId,
      refreshToken: issued.credential.refreshToken,
      ...(label ? { label } : {}),
      pairedAt: Date.now(),
    };
    persistFreshDeviceCredential(currentStored);
    const auth = () => {
      const active = currentStored;
      if (!active) throw new Error("Fresh pairing credential was not committed");
      return `refresh:${active.deviceId}:${active.refreshToken}`;
    };
    phase("connect-workspace");
    workspaceClient = await supervisor.connect(currentStored.workspacePairing, {
      callerId: `shell:${currentStored.deviceId}`,
      getShellToken: auth,
      onPaired: (credential) => {
        if (!currentStored) return;
        currentStored = {
          ...currentStored,
          deviceId: credential.deviceId,
          refreshToken: credential.refreshToken,
          rotatedAt: Date.now(),
        };
        persistFreshDeviceCredential(currentStored);
      },
      onConnectionStatusChanged: args.onConnectionStatusChanged,
      onTransportDiagnosticsChanged: args.onTransportDiagnosticsChanged,
      onReconnectProgress: args.onReconnectProgress,
      onRecovery: args.onRecovery,
      onMainSessionTerminalClose: args.onMainSessionTerminalClose,
    });
    phase("prepare-workspace-session");
    const connection = await buildRemoteSessionConnection(
      workspaceClient,
      controlClient,
      route.workspace,
      nativeStorageScope("iroh", pairing.endpointId, issued.credential.deviceId),
      () => supervisor.close(),
      (route) =>
        supervisor.connect(storedReach(route.workspaceReach), {
          callerId: `shell:${issued.credential.deviceId}`,
          getShellToken: auth,
        })
    );
    log.info("[Server] Shell client connected over Iroh (fresh pairing)");
    return { ...connection, initialFocusedWorkspaceId: requested.workspaceId };
  } catch (error) {
    return throwAfterOwnedCleanup(
      error,
      [{ label: "fresh Iroh connection supervisor", close: () => supervisor.close() }],
      "Fresh remote session establishment"
    );
  }
}

function storedReach(
  reach: HubWorkspaceRoute["workspaceReach"] | IrohReach
): StoredRemote["controlPairing"] {
  const stored = { endpointId: reach.endpointId, relays: [...reach.relays], v: reach.v };
  assertIrohReach(stored);
  return stored;
}

function persistFreshDeviceCredential(credential: StoredRemote): void {
  try {
    saveDeviceCredential(credential);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The server accepted the pairing link, but Vibestudio could not save the issued device credential: ${cause} The pairing link is now used; fix local credential storage and request a fresh link.`,
      { cause: error }
    );
  }
}

async function connectLocalWorkspace(
  route: HubWorkspaceRoute,
  deviceId: string,
  refreshToken: string,
  storageScope: string
): Promise<WorkspaceSessionConnection> {
  let cdpAuthToken = "";
  const refresh = async (): Promise<string> => {
    const response = await fetch(serverAuthRouteUrl(route.serverUrl, "refresh-shell"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, refreshToken }),
    });
    if (!response.ok) throw new Error(`Workspace authentication failed (${response.status})`);
    const payload = (await response.json()) as { shellToken?: unknown };
    if (typeof payload.shellToken !== "string" || !payload.shellToken) {
      throw new Error("Workspace authentication returned no session token");
    }
    cdpAuthToken = payload.shellToken;
    return cdpAuthToken;
  };
  const url = new URL(route.serverUrl);
  const protocol = url.protocol === "https:" ? "https" : "http";
  const gatewayPort = Number(url.port || (protocol === "https" ? 443 : 80));
  const serverClient = await createServerClient(gatewayPort, await refresh(), {
    reconnect: true,
    clientPlatform: "desktop",
    oauthCallbackMode: "client-loopback",
    getWsUrl: () => serverRpcWsUrl(route.serverUrl),
    refreshAuthToken: refresh,
    onDisconnect: () => log.info(`Workspace connection closed: ${route.workspaceId}`),
  });
  try {
    const workspace = createTypedServiceClient("workspace", workspaceMethods, (svc, m, a) =>
      serverClient.call(svc, m, a)
    );
    const info = await workspace.getInfo();
    const gatewayConfig = { serverUrl: route.serverUrl };
    return {
      nativeStorageScope: storageScope,
      connectionMode: "local",
      serverOwnership: "desktop-local",
      protocol,
      gatewayPort,
      externalHost: url.hostname,
      gatewayConfig,
      workerdPort: 0,
      workspaceName: route.workspace,
      workspaceId: info.config.id,
      workspacePath: info.path,
      statePath: info.statePath,
      workspaceConfig: info.config,
      serverClient,
      panelHttpServer: {
        getBuildRevision: () => undefined,
        invalidateBuild: () => {},
        getPort: () => gatewayPort,
      },
      serverInfo: buildServerInfo(
        gatewayPort,
        url.hostname,
        protocol,
        gatewayConfig,
        () => serverClient
      ),
      getCdpAuthToken: () => cdpAuthToken,
      close: ownSessionResources([
        { label: "local workspace client", close: () => serverClient.close() },
      ]),
    };
  } catch (error) {
    return throwAfterOwnedCleanup(
      error,
      [{ label: "local workspace client", close: () => serverClient.close() }],
      "Workspace connection establishment"
    );
  }
}

async function buildRemoteSessionConnection(
  serverClient: ServerClient,
  hubControlClient: ServerClient,
  workspaceName: string,
  storageScope: string,
  closeRemote: () => Promise<void>,
  connectWorkspace: (route: HubWorkspaceRoute) => Promise<ServerClient>
): Promise<SessionConnection> {
  const initial = await shapeRemoteWorkspaceConnection(serverClient, workspaceName, storageScope);
  const workspaceSessions = new WorkspaceSessionDirectory(initial, async (workspaceId) => {
    const route = HubWorkspaceRouteSchema.parse(
      await hubControlClient.call("hubControl", "routeWorkspace", [{ workspaceId }])
    );
    const client = await connectWorkspace(route);
    try {
      return await shapeRemoteWorkspaceConnection(client, route.workspace, storageScope);
    } catch (error) {
      return throwAfterOwnedCleanup(
        error,
        [{ label: "remote workspace client", close: () => client.close() }],
        "Remote workspace connection establishment"
      );
    }
  });
  return {
    ...initial,
    hubControlClient,
    hubProcessManager: null,
    workspaceSessions,
    // Facades and workspace sessions drain before their shared Iroh supervisor.
    close: ownSessionResources([
      {
        label: "remote workspace directory",
        close: async () => {
          try {
            await workspaceSessions.close();
          } finally {
            await closeRemote();
          }
        },
      },
    ]),
  };
}

/**
 * Shape an already-connected remote Iroh pipe into a {@link SessionConnection}.
 * Shared by the fresh-pair and returning-device paths — the only difference
 * between them is HOW the pipe authenticated (one-time code vs refresh token).
 */
async function shapeRemoteWorkspaceConnection(
  serverClient: ServerClient,
  workspaceName: string,
  storageScope: string
): Promise<WorkspaceSessionConnection> {
  const protocol = "http" as const;
  const externalHost = "localhost";
  // There is no local gateway/workerd process in remote mode — the RPC plane
  // rides the pipe. Panel ASSETS, however, must still load from a loopback
  // origin (buildPanelUrl → http://127.0.0.1:{gatewayPort}/{source}/), so stand
  // up an assets-only façade that proxies each request to the remote server's
  // own gateway over the pipe (gateway.fetch RPC). The façade lives for the
  // whole session and is closed alongside the connection supervisor by
  // SessionConnection.close.
  // Persist the façade's asset cache + stable loopback port under userData so the
  // content-addressed cache and the webview HTTP cache both survive restarts.
  const workspaceClient = createTypedServiceClient("workspace", workspaceMethods, (svc, m, a) =>
    serverClient.call(svc, m, a)
  );
  const wsInfo = await workspaceClient.getInfo();
  const workspaceStateDirectory = path.join(
    app.getPath("userData"),
    "connections",
    storageScope,
    "workspaces",
    createHash("sha256").update(wsInfo.config.id).digest("hex")
  );
  const facade = await startPanelAssetFacade(serverClient, {
    stateDir: path.join(workspaceStateDirectory, "panel-asset-facade"),
  });
  try {
    const gatewayConfig = { serverUrl: `http://127.0.0.1:${facade.port}` };

    const serverInfo = buildServerInfo(
      facade.port,
      externalHost,
      protocol,
      gatewayConfig,
      () => serverClient
    );

    log.info(`[Workspace] Remote workspace: ${wsInfo.config.id}`);

    const panelHttpServer: PanelHttpServerLike = {
      getBuildRevision: () => undefined,
      invalidateBuild: () => {},
      getPort: () => facade.port,
    };

    // Local consumers (shellCore, app state, diagnostics) WRITE to statePath, so it
    // must be a locally-writable path — the remote `wsInfo.statePath` describes the
    // server's host, not ours. Scope a local scratch dir under userData.
    const statePath = path.join(workspaceStateDirectory, "state");

    return {
      nativeStorageScope: storageScope,
      connectionMode: "remote",
      serverOwnership: "external",
      protocol,
      gatewayPort: facade.port,
      externalHost,
      gatewayConfig,
      workerdPort: 0,
      workspaceName,
      workspaceId: wsInfo.config.id,
      // Remote manifests and assets are served through panelAssetFacade. The
      // remote path remains metadata for labels and workspace identity only.
      workspacePath: wsInfo.path,
      statePath,
      workspaceConfig: wsInfo.config,
      serverClient,
      close: ownSessionResources([
        { label: "remote panel asset facade", close: () => facade.close() },
        { label: "remote workspace client", close: () => serverClient.close() },
      ]),
      panelHttpServer,
      serverInfo,
      // CDP over the pipe uses the RPC-channel socket, not a bearer.
      getCdpAuthToken: () => "",
    };
  } catch (error) {
    return throwAfterOwnedCleanup(
      error,
      [{ label: "remote panel asset facade", close: () => facade.close() }],
      "Remote session shaping"
    );
  }
}
