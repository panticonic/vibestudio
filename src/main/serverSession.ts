/**
 * ServerSession — server connection establishment.
 *
 * Subsumes local attach-or-spawn vs remote connect and workspace info fetch.
 * Returns a single SessionConnection with everything needed to continue
 * startup. There is ONE auth model in all topologies: device pairing +
 * refresh credentials. Locally the desktop is a paired device of a detached
 * workspace server over loopback WS; remotely it is a paired device over the
 * WebRTC pipe.
 */

import { app, Notification } from "electron";
import * as path from "node:path";
import { createDevLogger } from "@vibestudio/dev-log";
import { getAppRoot } from "./paths.js";
import { LocalServerManager } from "./localServerManager.js";
import { createServerClient, type ServerClient, type ConnectionStatus } from "./serverClient.js";
import { createWebRtcServerClient } from "./webrtcServerClient.js";
import type { ReconnectProgress } from "@vibestudio/rpc/transports/webrtcClient";
import { startPanelAssetFacade } from "./panelAssetFacade.js";
import { relaunchApp } from "./relaunchApp.js";
import {
  loadDeviceCredentialByWorkspaceId,
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
  serverRpcWsUrl,
  normalizeFingerprint,
  type ConnectPairing,
} from "@vibestudio/shared/connect";

const log = createDevLogger("ServerSession");

export interface SessionConnection {
  connectionMode: "local" | "remote";
  /**
   * Who controls the server process: "desktop-local" means this app manages a
   * detached local workspace server (quit policy applies); "external" means
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
  localServerManager: LocalServerManager | null;
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
  onServerEvent: (event: string, payload: unknown) => void;
  onConnectionStatusChanged?: (status: ConnectionStatus) => void;
  onReconnectProgress?: (progress: ReconnectProgress) => void;
  onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>;
  onMainSessionTerminalClose?: (error: Error) => void;
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

  const localServerManager = new LocalServerManager({
    wsDir: mode.wsDir,
    workspaceName: mode.workspaceName,
    workspaceId: mode.workspaceId,
    appRoot: getAppRoot(),
    appVersion: app.getVersion(),
    isEphemeral: mode.isEphemeral,
    autoApproveStartupUnits: mode.autoApproveStartupUnits,
    centralData: args.centralData,
    onCrash: (code) => {
      console.error(`[App] Local server died and could not be recovered (code ${code ?? "?"})`);
      const now = Date.now();
      let previous = { count: 0, firstAt: now };
      try {
        const parsed = JSON.parse(process.env["VIBESTUDIO_LOCAL_CRASH_RELAUNCH_STATE"] ?? "{}") as {
          count?: number;
          firstAt?: number;
          workspaceName?: string;
        };
        if (
          typeof parsed.count === "number" &&
          typeof parsed.firstAt === "number" &&
          parsed.workspaceName === mode.workspaceName &&
          now - parsed.firstAt < 5 * 60_000
        ) {
          previous = { count: parsed.count, firstAt: parsed.firstAt };
        }
      } catch {
        // A malformed inherited marker simply starts a fresh recovery window.
      }
      const recovery = {
        count: previous.count + 1,
        firstAt: previous.firstAt,
        workspaceName: mode.workspaceName,
      };
      process.env["VIBESTUDIO_LOCAL_CRASH_RELAUNCH_STATE"] = JSON.stringify(recovery);
      if (recovery.count >= 3) {
        const message =
          "The local workspace server stopped repeatedly. Automatic restart was stopped to avoid a relaunch loop.";
        if (Notification.isSupported()) {
          new Notification({ title: "Workspace server keeps stopping", body: message }).show();
        }
        relaunchApp({
          args: [
            "--choose-connection",
            `--local-server-crash-loop=${code ?? "unknown"}`,
            `--local-server-crash-workspace=${mode.workspaceName}`,
          ],
          exitCode: 1,
        });
        return;
      }
      const message = "The local workspace server stopped. Vibestudio is restarting it now.";
      if (Notification.isSupported()) {
        new Notification({ title: "Workspace server stopped", body: message }).show();
      }
      const relaunchArgs = process.argv
        .slice(1)
        .filter((arg) => !arg.startsWith("--recovered-local-server-crash="));
      relaunchArgs.push(`--recovered-local-server-crash=${code ?? "unknown"}`);
      relaunchApp({ args: relaunchArgs, exitCode: 1 });
    },
  });

  const target = await localServerManager.attachOrSpawn();
  log.info(
    `[Server] ${target.attached ? "Attached to" : "Spawned"} local server (Gateway: ${target.gatewayPort}, boot ${target.serverBootId})`
  );
  const gatewayConfig = { serverUrl: `http://127.0.0.1:${target.gatewayPort}` };

  // Shell bearer for the CDP host socket, exchanged from the persisted refresh
  // credential over loopback. Re-fetched on every transition into "connected"
  // (a server restart invalidates the previous in-memory bearer).
  let cdpAuthToken = "";
  const refreshCdpAuthToken = async (): Promise<void> => {
    const credential = loadDeviceCredentialByWorkspaceId(mode.workspaceId);
    const port = localServerManager.getGatewayPort() ?? target.gatewayPort;
    if (!credential) return;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/refresh-shell`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: credential.deviceId,
          refreshToken: credential.refreshToken,
        }),
      });
      if (!response.ok) {
        log.warn(`[Server] /refresh-shell failed with ${response.status}`);
        return;
      }
      const payload = (await response.json()) as { shellToken?: string };
      if (payload.shellToken) cdpAuthToken = payload.shellToken;
    } catch (error) {
      log.warn(
        `[Server] /refresh-shell error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const serverClient = await createServerClient(target.gatewayPort, target.authToken, {
    reconnect: true,
    getWsUrl: () =>
      localServerManager.getCurrentGatewayUrl() ??
      serverRpcWsUrl(`http://127.0.0.1:${target.gatewayPort}`),
    refreshAuthToken: async () => localServerManager.getAuthToken(),
    // A fresh spawn pairs with the startup pairing code; the issued device
    // credential is persisted so reconnects and future launches use
    // refresh:<deviceId>:<token> — identical to the remote path.
    onPaired: (credential) => {
      localServerManager.persistPairedCredential(credential);
      void refreshCdpAuthToken();
    },
    onConnectionStatusChanged: (status) => {
      if (status === "connecting") {
        // Supervision: probe the process behind a dropped socket; respawn if dead.
        localServerManager.handleDisconnect();
      }
      if (status === "connected") {
        void refreshCdpAuthToken();
      }
      args.onConnectionStatusChanged?.(status);
    },
    onRecovery: args.onRecovery,
    onDisconnect: () => {
      console.error("[App] Local server connection closed");
    },
    onServerEvent,
  });
  await refreshCdpAuthToken();

  log.info("[Server] Shell client connected");

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
    localServerManager,
    panelHttpServer,
    serverInfo,
    getCdpAuthToken: () => cdpAuthToken,
  };
}

/** The connect-callback subset both remote-session paths forward to the pipe. */
type RemoteConnectArgs = {
  onServerEvent: (event: string, payload: unknown) => void;
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
  args: RemoteConnectArgs
): Promise<SessionConnection> {
  const serverClient = await connectRemoteViaWebRtc(
    { ...stored.pairing, code: "" },
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
      onReconnectProgress: args.onReconnectProgress,
      onRecovery: args.onRecovery,
      onMainSessionTerminalClose: args.onMainSessionTerminalClose,
    }
  );
  log.info("[Server] Shell client connected over WebRTC remote pipe (returning device)");
  return buildRemoteSessionConnection(serverClient);
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
  const issuedCredential: { current: { deviceId: string; refreshToken: string } | null } = {
    current: null,
  };
  const serverClient = await connectRemoteViaWebRtc(pairing, {
    // The server assigns the real `shell:<deviceId>` principal when it redeems the
    // one-time code; we don't know that id yet, so dial with a stable selfId. (If
    // the resolved id is ever threaded back, swap it in here.)
    callerId: "shell:pairing",
    getShellToken: () => {
      const credential = issuedCredential.current;
      return credential
        ? `refresh:${credential.deviceId}:${credential.refreshToken}`
        : pairing.code;
    },
    // Persist the issued device credential against the pairing material (minus the
    // one-time code) so the NEXT launch reconnects via refresh:<deviceId>:<token>.
    onPaired: (credential) => {
      issuedCredential.current = credential;
    },
    onServerEvent: args.onServerEvent,
    onConnectionStatusChanged: args.onConnectionStatusChanged,
    onReconnectProgress: args.onReconnectProgress,
    onRecovery: args.onRecovery,
    onMainSessionTerminalClose: args.onMainSessionTerminalClose,
  });
  if (!issuedCredential.current) {
    // The one-time code did not yield a credential — nothing to persist, but the
    // pipe is up. Close it so we don't leak the connection, then fail loud.
    await serverClient.close().catch(() => {});
    throw new Error(
      "Fresh WebRTC pairing completed without an issued device credential — mint a new invite and try again."
    );
  }
  const credential = issuedCredential.current;
  const authClient = createTypedServiceClient("auth", authMethods, (svc, m, a) =>
    serverClient.call(svc, m, a)
  );

  // The one-time code is ALREADY consumed server-side; the invite is spent. So we
  // must persist the issued credential no matter what — losing it here orphans the
  // pairing (the server thinks this device is paired; we can never reconnect) and
  // forces the user to mint a fresh invite. `getConnectionInfo` gives the canonical
  // serverId key; if it fails (transient RPC error) we fall back to a stable
  // fingerprint-derived key so the next launch can still reconnect via refresh.
  let serverId: string;
  try {
    serverId = (await authClient.getConnectionInfo()).serverId;
  } catch (error) {
    serverId = `webrtc:${normalizeFingerprint(pairing.fp)}`;
    log.warn(
      `[Server] getConnectionInfo failed after pairing; persisting under fingerprint-derived id (${serverId}): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  saveDeviceCredential({
    serverId,
    transport: "webrtc",
    pairing: {
      room: pairing.room,
      fp: pairing.fp,
      sig: pairing.sig,
      ice: pairing.ice,
      srv: pairing.srv,
    },
    deviceId: credential.deviceId,
    refreshToken: credential.refreshToken,
    ...(label ? { label } : {}),
    pairedAt: Date.now(),
  });
  log.info("[Server] Shell client connected over WebRTC remote pipe (fresh pairing)");
  try {
    return await buildRemoteSessionConnection(serverClient);
  } catch (error) {
    // The credential is persisted (above), so the next launch reconnects; here the
    // pipe is unusable, so close it rather than leaking the connection.
    await serverClient.close().catch(() => {});
    throw error;
  }
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
    localServerManager: null,
    panelHttpServer,
    serverInfo,
    // CDP over the pipe uses the RPC-channel socket, not a bearer.
    getCdpAuthToken: () => "",
  };
}
