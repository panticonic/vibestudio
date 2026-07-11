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
import { startPanelAssetFacade } from "./panelAssetFacade.js";
import { relaunchApp } from "./relaunchApp.js";
import {
  loadStoredRemotePairing,
  saveDeviceCredential,
  type StoredRemote,
} from "./services/deviceCredentialStore.js";
import type { PanelHttpServerLike } from "@vibestudio/shared/panelInterfaces";
import type { ServerInfo } from "./serverInfo.js";
import type { WorkspaceConfig } from "@vibestudio/shared/workspace/types";
import type { CentralDataManager } from "@vibestudio/shared/centralData";
import type { ConnectedStartupMode } from "./startupMode.js";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { workspaceMethods } from "@vibestudio/shared/serviceSchemas/workspace";
import { authMethods } from "@vibestudio/shared/serviceSchemas/auth";
import {
  HubWorkspaceRouteSchema,
  type HubWorkspaceRoute,
} from "@vibestudio/shared/serviceSchemas/hubControl";
import {
  normalizeFingerprint,
  PAIRING_PROTOCOL_VERSION,
  PAIRING_ROOM_PATTERN,
  parseSignalingEndpoint,
  serverAuthRouteUrl,
  type ConnectPairing,
} from "@vibestudio/shared/connect";

const log = createDevLogger("ServerSession");

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
  serverClient: ServerClient;
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
    onPaired?: (credential: { deviceId: string; refreshToken: string }) => void;
    onServerEvent?: (event: string, payload: unknown) => void;
    onConnectionStatusChanged?: (status: ConnectionStatus) => void;
    onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>;
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
  onServerEvent: (event: string, payload: unknown) => void;
  onConnectionStatusChanged?: (status: ConnectionStatus) => void;
  onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>;
}): Promise<SessionConnection> {
  const { mode, pendingPairing, skipStoredRemote, onServerEvent } = args;

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
    onServerEvent,
  });
  try {
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
      serverClient,
      hubProcessManager,
      panelHttpServer,
      serverInfo,
      getCdpAuthToken: () => cdpAuthToken,
    };
  } catch (error) {
    hubProcessManager.detach();
    await serverClient.close().catch(() => undefined);
    throw error;
  }
}

/** The connect-callback subset both remote-session paths forward to the pipe. */
type RemoteConnectArgs = {
  onServerEvent: (event: string, payload: unknown) => void;
  onConnectionStatusChanged?: (status: ConnectionStatus) => void;
  onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>;
};

/**
 * Connect to a paired WebRTC remote as the RETURNING device and shape it into a
 * {@link SessionConnection}. The shell re-authenticates with its refresh token
 * (`refresh:<deviceId>:<refreshToken>`); the RPC plane rides the pipe exactly as
 * the local loopback-WS plane does.
 */
async function establishRemoteSession(
  stored: StoredRemote,
  args: RemoteConnectArgs
): Promise<SessionConnection> {
  const serverClient = await connectRemoteViaWebRtc(
    { ...stored.workspacePairing, code: "" },
    {
      callerId: `shell:${stored.deviceId}`,
      getShellToken: () => `refresh:${stored.deviceId}:${stored.refreshToken}`,
      // A returning device re-auths with its refresh token; if the server rotates
      // it (delivered via onPaired), persist the fresh secret for next launch.
      onPaired: (credential) =>
        saveDeviceCredential({
          ...stored,
          deviceId: credential.deviceId,
          refreshToken: credential.refreshToken,
          rotatedAt: Date.now(),
        }),
      onServerEvent: args.onServerEvent,
      onConnectionStatusChanged: args.onConnectionStatusChanged,
      onRecovery: args.onRecovery,
    }
  );
  try {
    const connection = await buildRemoteSessionConnection(serverClient);
    log.info("[Server] Shell client connected over WebRTC remote pipe (returning device)");
    return connection;
  } catch (error) {
    await serverClient.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Pair a FRESH device over WebRTC and KEEP the pipe as the session. The one-time
 * `code` is presented as the session token (which pairs a new device server-side
 * and delivers `{deviceId, refreshToken}` via `onPaired`); that credential is
 * persisted so the next launch reconnects as a returning device. There is no
 * throwaway redeem — this connection IS the session.
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
  const issuedCredential: { current: { deviceId: string; refreshToken: string } | null } = {
    current: null,
  };
  const serverClient = await connectRemoteViaWebRtc(pairing, {
    // The server assigns the real `shell:<deviceId>` principal when it redeems the
    // one-time code; we don't know that id yet, so dial with a stable selfId. (If
    // the resolved id is ever threaded back, swap it in here.)
    callerId: "shell:pairing",
    getShellToken: () => pairing.code,
    // Persist the issued device credential against the pairing material (minus the
    // one-time code) so the NEXT launch reconnects via refresh:<deviceId>:<token>.
    onPaired: (credential) => {
      issuedCredential.current = credential;
    },
    onServerEvent: args.onServerEvent,
    onConnectionStatusChanged: args.onConnectionStatusChanged,
    onRecovery: args.onRecovery,
  });
  try {
    if (!issuedCredential.current) {
      throw new Error(
        "Fresh WebRTC pairing completed without an issued device credential — mint a new invite and try again."
      );
    }
    const authClient = createTypedServiceClient("auth", authMethods, (svc, m, a) =>
      serverClient.call(svc, m, a)
    );
    const info = await authClient.getConnectionInfo();
    const workspaceName = await serverClient.call("workspace", "getActive", []);
    if (typeof workspaceName !== "string" || !workspaceName) {
      throw new Error("Fresh WebRTC pairing did not report an active workspace");
    }
    const route = HubWorkspaceRouteSchema.parse(
      await serverClient.call("hubControl", "routeWorkspace", [{ workspace: workspaceName }])
    );
    if (route.serverId !== info.serverId) {
      throw new Error("Workspace route changed server identity during pairing");
    }
    const controlPairing = storedReach(route.controlReach);
    const workspacePairing = storedReach(route.workspaceReach);
    saveDeviceCredential({
      serverId: info.serverId,
      transport: "webrtc",
      controlPairing,
      workspacePairing,
      workspaceName: route.workspace,
      deviceId: issuedCredential.current.deviceId,
      refreshToken: issuedCredential.current.refreshToken,
      ...(label ? { label } : {}),
      pairedAt: Date.now(),
    });
    const connection = await buildRemoteSessionConnection(serverClient);
    log.info("[Server] Shell client connected over WebRTC remote pipe (fresh pairing)");
    return connection;
  } catch (error) {
    await serverClient.close().catch(() => undefined);
    throw error;
  }
}

function storedReach(reach: HubWorkspaceRoute["controlReach"]): StoredRemote["controlPairing"] {
  const signaling = parseSignalingEndpoint(reach.sig);
  if (signaling.kind === "error") throw new Error(signaling.reason);
  return {
    room: reach.room,
    fp: normalizeFingerprint(reach.fp),
    sig: signaling.url,
    v: reach.v,
    ice: reach.ice,
    ...(reach.srv ? { srv: reach.srv } : {}),
  };
}

/**
 * Shape an already-connected remote WebRTC pipe into a {@link SessionConnection}.
 * Shared by the fresh-pair and returning-device paths — the only difference
 * between them is HOW the pipe authenticated (one-time code vs refresh token).
 */
async function buildRemoteSessionConnection(
  serverClient: ServerClient
): Promise<SessionConnection> {
  const protocol = "http" as const;
  const externalHost = "localhost";
  // There is no local gateway/workerd process in remote mode — the RPC plane
  // rides the pipe. Panel ASSETS, however, must still load from a loopback
  // origin (buildPanelUrl → http://127.0.0.1:{gatewayPort}/{source}/), so stand
  // up an assets-only façade that proxies each request to the remote server's
  // own gateway over the pipe (gateway.fetch RPC). The façade lives for the
  // whole session; there is no teardown hook on this path (the process exits
  // with the session), which is acceptable for a single loopback listener.
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
      serverClient,
      hubProcessManager: null,
      panelHttpServer,
      serverInfo,
      // CDP over the pipe uses the RPC-channel socket, not a bearer.
      getCdpAuthToken: () => "",
    };
  } catch (error) {
    await facade.close().catch(() => undefined);
    throw error;
  }
}
