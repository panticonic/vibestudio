/**
 * ServerSession — server connection establishment.
 *
 * Subsumes local attach-or-spawn vs remote connect and workspace info fetch.
 * Returns a single SessionConnection with everything needed to continue
 * startup. There is ONE auth model in all topologies: device pairing +
 * refresh credentials. Locally the desktop owns a detached hub and routes into
 * a child over its loopback proxy; remotely it reaches the child over WebRTC.
 */

import { app } from "electron";
import * as path from "node:path";
import { createDevLogger } from "@vibestudio/dev-log";
import { getAppRoot } from "./paths.js";
import { HubProcessManager } from "./hubProcessManager.js";
import { createServerClient, type ServerClient, type ConnectionStatus } from "./serverClient.js";
import { createWebRtcServerClient } from "./webrtcServerClient.js";
import type { ReconnectProgress } from "@vibestudio/rpc/transports/webrtcClient";
import type { DeviceCredential, PairingContext } from "@vibestudio/rpc/protocol/wsProtocol";
import { startPanelAssetFacade } from "../node/panelAssets/panelAssetFacade.js";
import { relaunchApp } from "./relaunchApp.js";
import {
  loadStoredRemotePairing,
  saveDeviceCredential,
  type StoredRemote,
} from "./services/deviceCredentialStore.js";
import type { PanelHttpServerLike } from "@vibestudio/shared/panelInterfaces";
import type { ServerInfo } from "./serverInfo.js";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import type { CentralDataManager } from "@vibestudio/shared/centralData";
import type { ConnectedStartupMode } from "./startupMode.js";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { workspaceMethods } from "@vibestudio/service-schemas/workspace";
import {
  HubWorkspaceRouteSchema,
  type HubWorkspaceRoute,
} from "@vibestudio/service-schemas/hubControl";
import {
  normalizeFingerprint,
  PAIRING_PROTOCOL_VERSION,
  PAIRING_ROOM_PATTERN,
  parseSignalingEndpoint,
  serverAuthRouteUrl,
  type ConnectPairing,
} from "@vibestudio/shared/connect";

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

export interface SessionConnection {
  connectionMode: "local" | "remote";
  /**
   * Who controls the server process: "desktop-local" means this app manages a
   * detached local hub (quit policy applies); "external" means
   * someone else owns it (remote WebRTC server).
   */
  serverOwnership: "desktop-local" | "external";
  protocol: "http" | "https";
  gatewayPort: number;
  externalHost: string;
  gatewayConfig: { serverUrl: string };
  workerdPort: number;
  workspaceId: string;
  workspacePath: string;
  statePath: string;
  workspaceConfig: WorkspaceConfig;
  /** Stable server-wide control session. Only hubControl RPC belongs here. */
  hubControlClient: ServerClient;
  /** Exact selected-workspace session. All workspace services belong here. */
  serverClient: ServerClient;
  /** Idempotently close every transport/facade owned by this session. */
  close(): Promise<void>;
  hubProcessManager: HubProcessManager | null;
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
 * Connect to a remote server over the WebRTC pipe (the only remote transport;
 * §8 deleted the direct-wss/TLS-pin path). The QR-pairing flow hands its parsed
 * `ConnectPairing` ({room, fp, code, sig, ice}) here, along with the shell-token
 * provider derived from the persisted device credential.
 */
export function connectRemoteViaWebRtc(
  pairing: ConnectPairing,
  options: {
    /** The shell's caller id, e.g. `shell:<deviceId>`. */
    callerId: string;
    /** Device-credential → short-lived shell token (re-invoked per session open). */
    getShellToken: () => Promise<string> | string;
    connectionId?: string;
    /** Fired when a fresh device is paired — persist the returned credential. */
    onPaired?: (credential: DeviceCredential, context?: PairingContext) => void;
    onConnectionStatusChanged?: (status: ConnectionStatus) => void;
    onReconnectProgress?: (progress: ReconnectProgress) => void;
    onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>;
    onMainSessionTerminalClose?: (error: Error) => void;
  }
): Promise<ServerClient> {
  return createWebRtcServerClient({ pairing, ...options });
}

/**
 * Establish a server session. Three branches, in precedence order:
 *
 *   (a) FRESH pair — `args.pendingPairing` carries a pairing link the bootstrap
 *       chooser redeemed THIS launch.
 *   (b) Returning device — a pairing persisted on a prior launch (WebRTC).
 *   (c) Local — attach to a healthy detached local workspace server, or spawn
 *       one, and connect over loopback WS with device-pairing auth.
 */
export async function establishServerSession(args: {
  mode: ConnectedStartupMode | null;
  pendingPairing?: ConnectPairing;
  /** Human-readable label for a freshly-paired device (from the pairing dialog). */
  pendingPairLabel?: string;
  /**
   * Suppress returning-device auto-dial for this launch. Used by the chooser
   * fallback after a failed remote launch so a local workspace choice stays local.
   */
  skipStoredRemote?: boolean;
  centralData: CentralDataManager;
  onConnectionStatusChanged?: (status: ConnectionStatus) => void;
  onReconnectProgress?: (progress: ReconnectProgress) => void;
  onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>;
  onMainSessionTerminalClose?: (error: Error) => void;
}): Promise<SessionConnection> {
  const { mode, pendingPairing, skipStoredRemote } = args;

  // (a) FRESH pair: the bootstrap chooser handed us a pairing link this launch.
  if (pendingPairing) {
    return establishFreshPairSession(pendingPairing, args, args.pendingPairLabel);
  }
  // (b) Returning device: a paired WebRTC remote persisted on a prior launch.
  const storedRemote = skipStoredRemote ? null : loadStoredRemotePairing();
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
    appRoot: getAppRoot(),
    appVersion: app.getVersion(),
    centralData: args.centralData,
    onCrash: (code) => {
      console.error(`[App] Local hub died and could not be recovered (code ${code ?? "?"})`);
      relaunchApp({ exitCode: 1 });
    },
  });
  const target = await hubProcessManager.attachOrSpawn();
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
        getWsUrl: () => hubProcessManager.getHubWsUrl(),
        refreshAuthToken: () => hubProcessManager.getHubAuthToken(),
        onDisconnect: () => console.error("[App] Local hub control connection closed"),
      }
    );
    const connectedHubControlClient = hubControlClient;
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
      hasBuild: () => false,
      getBuildRevision: () => undefined,
      invalidateBuild: () => {},
      getPort: () => gatewayPort,
    };

    return {
      connectionMode: "local",
      serverOwnership: "desktop-local",
      protocol,
      gatewayPort,
      externalHost,
      gatewayConfig,
      workerdPort: 0,
      workspaceId: wsInfo.config.id,
      workspacePath: wsInfo.path,
      /** The local server's own state directory (same host). */
      statePath: wsInfo.statePath,
      workspaceConfig: wsInfo.config,
      hubControlClient: connectedHubControlClient,
      serverClient,
      close: ownSessionResources([
        { label: "local workspace client", close: () => serverClient.close() },
        {
          label: "local hub control client",
          close: () => connectedHubControlClient.close(),
        },
      ]),
      hubProcessManager,
      panelHttpServer,
      serverInfo,
      getCdpAuthToken: () => cdpAuthToken,
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
  onConnectionStatusChanged?: (status: ConnectionStatus) => void;
  onReconnectProgress?: (progress: ReconnectProgress) => void;
  onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>;
  onMainSessionTerminalClose?: (error: Error) => void;
};

/**
 * Connect to a paired WebRTC remote as the RETURNING device and shape it into a
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
  const hubControlClient = await connectRemoteViaWebRtc(
    { ...stored.controlPairing, code: "" },
    {
      callerId: `shell:${stored.deviceId}`,
      getShellToken: auth,
      onPaired: rotate,
    }
  );
  let serverClient: ServerClient | null = null;
  try {
    serverClient = await connectRemoteViaWebRtc(
      { ...stored.workspacePairing, code: "" },
      {
        callerId: `shell:${stored.deviceId}`,
        getShellToken: auth,
        onPaired: rotate,
        onConnectionStatusChanged: args.onConnectionStatusChanged,
        onReconnectProgress: args.onReconnectProgress,
        onRecovery: args.onRecovery,
        onMainSessionTerminalClose: args.onMainSessionTerminalClose,
      }
    );
    const connection = await buildRemoteSessionConnection(serverClient, hubControlClient);
    log.info(`[Server] Shell client connected over WebRTC remote pipe (${origin})`);
    return connection;
  } catch (error) {
    return throwAfterOwnedCleanup(
      error,
      [
        ...(serverClient
          ? [{ label: "remote workspace client", close: serverClient.close.bind(serverClient) }]
          : []),
        { label: "remote hub control client", close: () => hubControlClient.close() },
      ],
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
  if (pairing.v !== PAIRING_PROTOCOL_VERSION || !pairing.ice) {
    throw new Error("Fresh WebRTC pairing requires the current version and explicit ICE policy");
  }
  const fingerprint = normalizeFingerprint(pairing.fp);
  const signaling = parseSignalingEndpoint(pairing.sig);
  if (
    !PAIRING_ROOM_PATTERN.test(pairing.room) ||
    !/^[0-9A-F]{64}$/.test(fingerprint) ||
    signaling.kind === "error"
  ) {
    throw new Error("Fresh WebRTC pairing coordinates are not canonicalizable");
  }
  const paired: {
    current: {
      credential: { deviceId: string; refreshToken: string };
      workspaceId: string;
    } | null;
  } = {
    current: null,
  };
  let currentStored: StoredRemote | null = null;
  const controlClient = await connectRemoteViaWebRtc(pairing, {
    // The server assigns the real `shell:<deviceId>` principal when it redeems the
    // one-time code; we don't know that id yet, so dial with a stable selfId. (If
    // the resolved id is ever threaded back, swap it in here.)
    callerId: "shell:pairing",
    getShellToken: () => {
      const credential = paired.current?.credential;
      return credential
        ? `refresh:${credential.deviceId}:${credential.refreshToken}`
        : pairing.code;
    },
    // Persist the issued device credential against the pairing material (minus the
    // one-time code) so the NEXT launch reconnects via refresh:<deviceId>:<token>.
    onPaired: (credential, context) => {
      if (!paired.current) {
        if (!context) throw new Error("Fresh pairing did not identify its target workspace");
        paired.current = { credential, workspaceId: context.workspaceId };
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
        saveDeviceCredential(currentStored);
      }
    },
  });
  let workspaceClient: ServerClient | null = null;
  try {
    if (!paired.current) {
      throw new Error(
        "Fresh WebRTC pairing completed without an issued device credential — mint a new invite and try again."
      );
    }
    const issued = paired.current;
    const route = HubWorkspaceRouteSchema.parse(
      await controlClient.call("hubControl", "routeWorkspace", [
        { workspaceId: issued.workspaceId },
      ])
    );
    if (route.workspaceId !== issued.workspaceId) {
      throw new Error("Workspace route changed the pairing target");
    }
    const { code: _code, ...stableHubReach } = pairing;
    const controlPairing = storedReach(stableHubReach);
    const workspacePairing = storedReach(route.workspaceReach);
    currentStored = {
      serverId: route.serverId,
      transport: "webrtc",
      controlPairing,
      workspacePairing,
      workspaceName: route.workspace,
      deviceId: issued.credential.deviceId,
      refreshToken: issued.credential.refreshToken,
      ...(label ? { label } : {}),
      pairedAt: Date.now(),
    };
    saveDeviceCredential(currentStored);
    const auth = () => {
      const active = currentStored;
      if (!active) throw new Error("Fresh pairing credential was not committed");
      return `refresh:${active.deviceId}:${active.refreshToken}`;
    };
    workspaceClient = await connectRemoteViaWebRtc(
      { ...currentStored.workspacePairing, code: "" },
      {
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
          saveDeviceCredential(currentStored);
        },
        onConnectionStatusChanged: args.onConnectionStatusChanged,
        onReconnectProgress: args.onReconnectProgress,
        onRecovery: args.onRecovery,
        onMainSessionTerminalClose: args.onMainSessionTerminalClose,
      }
    );
    const connection = await buildRemoteSessionConnection(workspaceClient, controlClient);
    log.info("[Server] Shell client connected over WebRTC remote pipe (fresh pairing)");
    return connection;
  } catch (error) {
    return throwAfterOwnedCleanup(
      error,
      [
        ...(workspaceClient
          ? [
              {
                label: "fresh workspace client",
                close: workspaceClient.close.bind(workspaceClient),
              },
            ]
          : []),
        { label: "fresh hub control client", close: () => controlClient.close() },
      ],
      "Fresh remote session establishment"
    );
  }
}

function storedReach(
  reach: HubWorkspaceRoute["workspaceReach"] | Omit<ConnectPairing, "code">
): StoredRemote["controlPairing"] {
  const signaling = parseSignalingEndpoint(reach.sig);
  if (signaling.kind === "error") throw new Error(signaling.reason);
  return {
    room: reach.room,
    fp: normalizeFingerprint(reach.fp),
    sig: signaling.url,
    v: reach.v,
    ice: reach.ice,
  };
}

/**
 * Shape an already-connected remote WebRTC pipe into a {@link SessionConnection}.
 * Shared by the fresh-pair and returning-device paths — the only difference
 * between them is HOW the pipe authenticated (one-time code vs refresh token).
 */
async function buildRemoteSessionConnection(
  serverClient: ServerClient,
  hubControlClient: ServerClient
): Promise<SessionConnection> {
  const protocol = "http" as const;
  const externalHost = "localhost";
  // There is no local gateway/workerd process in remote mode — the RPC plane
  // rides the pipe. Panel ASSETS, however, must still load from a loopback
  // origin (buildPanelUrl → http://127.0.0.1:{gatewayPort}/{source}/), so stand
  // up an assets-only façade that proxies each request to the remote server's
  // own gateway over the pipe (gateway.fetch RPC). The façade lives for the
  // whole session and is closed with both RPC clients by SessionConnection.close.
  // Persist the façade's asset cache + stable loopback port under userData so the
  // content-addressed cache and the webview HTTP cache both survive restarts.
  const facade = await startPanelAssetFacade(serverClient, {
    stateDir: path.join(app.getPath("userData"), "panel-asset-facade"),
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

    // Mirror the local path: read the remote workspace's identity + config over
    // the pipe so the shell can label and route the session.
    const workspaceClient = createTypedServiceClient("workspace", workspaceMethods, (svc, m, a) =>
      serverClient.call(svc, m, a)
    );
    const wsInfo = await workspaceClient.getInfo();
    log.info(`[Workspace] Remote workspace: ${wsInfo.config.id}`);

    const panelHttpServer: PanelHttpServerLike = {
      hasBuild: () => false,
      getBuildRevision: () => undefined,
      invalidateBuild: () => {},
      getPort: () => facade.port,
    };

    // Local consumers (shellCore, app state, diagnostics) WRITE to statePath, so it
    // must be a locally-writable path — the remote `wsInfo.statePath` describes the
    // server's host, not ours. Scope a local scratch dir under userData.
    const statePath = path.join(app.getPath("userData"), "remote-state");

    return {
      connectionMode: "remote",
      serverOwnership: "external",
      protocol,
      gatewayPort: facade.port,
      externalHost,
      gatewayConfig,
      workerdPort: 0,
      workspaceId: wsInfo.config.id,
      // Remote manifests and assets are served through panelAssetFacade. The
      // remote path remains metadata for labels and workspace identity only.
      workspacePath: wsInfo.path,
      statePath,
      workspaceConfig: wsInfo.config,
      hubControlClient,
      serverClient,
      close: ownSessionResources([
        { label: "remote workspace client", close: () => serverClient.close() },
        { label: "remote hub control client", close: () => hubControlClient.close() },
        { label: "remote panel asset facade", close: () => facade.close() },
      ]),
      hubProcessManager: null,
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
