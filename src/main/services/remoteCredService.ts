import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { authMethods } from "@vibestudio/shared/serviceSchemas/auth";
import type { ViewManager } from "../viewManager.js";
import { requireChromeAppCallerOrHost } from "./appCapabilities.js";
import { remoteCredMethods } from "@vibestudio/shared/serviceSchemas/remoteCred";
import type { StartupMode } from "../startupMode.js";
import { createServerClient, type ServerClient } from "../serverClient.js";
import { relaunchApp } from "../relaunchApp.js";
import { PAIR_CONFIRMED_ARG } from "../startupMode.js";
import {
  isLoopbackHost,
  selectedWorkspaceNameFromUrl,
  parseConnectLink,
  createConnectDeepLink,
} from "@vibestudio/shared/connect";
import {
  clearStoredRemotePairing as clearStoredRemotePairingInStore,
  loadDeviceCredentialByWorkspaceId,
  loadStoredRemotePairing as loadStoredRemotePairingFromStore,
  saveDeviceCredential,
  type StoredRemote,
} from "./deviceCredentialStore.js";

/**
 * Client-side persistence of a WebRTC remote pairing. A desktop client that has
 * paired with a remote server over WebRTC (DTLS-fingerprint pinned, §8c) keeps,
 * encrypted at rest under `safeStorage`:
 *   - the pairing material (`room`/`fp`/`sig`/`ice`/`srv`) MINUS the one-time
 *     `code`, so it can re-dial the same answerer, and
 *   - the durable device credential (`deviceId`/`refreshToken`) the server
 *     issued, so it can re-authenticate without re-pairing (`refresh:…`).
 *
 */
function remoteCredentialPersistenceDisabled(): boolean {
  const value = process.env["VIBESTUDIO_DISABLE_REMOTE_CRED_PERSISTENCE"];
  return value === "1" || value === "true";
}

/**
 * Relaunch-arg prefix carrying the user-entered device label across the
 * exchangePairingCode relaunch, so the freshly-paired desktop persists a label
 * instead of showing up unlabeled (bug 11). Read by {@link readPendingPairLabel}
 * at startup and threaded into the fresh-pair persistence.
 */
const PAIR_LABEL_ARG_PREFIX = "--vibestudio-pair-label=";

/** Extract the device label carried on a relaunch (see {@link PAIR_LABEL_ARG_PREFIX}). */
export function readPendingPairLabel(argv: readonly string[] = process.argv): string | undefined {
  const arg = argv.find((a) => a.startsWith(PAIR_LABEL_ARG_PREFIX));
  if (!arg) return undefined;
  try {
    const value = decodeURIComponent(arg.slice(PAIR_LABEL_ARG_PREFIX.length)).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/** Read the persisted WebRTC remote pairing, if any (consumed by serverSession). */
export function loadStoredRemotePairing(): StoredRemote | null {
  return loadStoredRemotePairingFromStore();
}

/**
 * Drop the persisted WebRTC remote pairing. Used by the startup recovery path
 * when a returning device's credential is terminally rejected (revoked/reset/cert
 * regenerated): clearing it makes the next launch fall back to the server chooser
 * instead of re-dialing a dead pairing forever (a permanent-lockout otherwise).
 */
export function clearStoredRemotePairing(): void {
  clearStoredRemotePairingInStore();
}

/**
 * Persist via the store, surfacing (loudly) a refusal to write the refresh secret
 * in plaintext (OS secure storage unavailable) rather than crashing the live
 * session. The pipe stays up; the device simply re-pairs on the next launch.
 */
function persistOrWarn(label: string, persist: () => void): void {
  try {
    persist();
  } catch (error) {
    console.error(
      `[remoteCred] ${label}: ${error instanceof Error ? error.message : String(error)} ` +
        "— the device will need to re-pair on next launch."
    );
  }
}

/**
 * Persist a rotated device credential against the existing stored pairing. Fired
 * from the reconnect path's `onPaired` if the server hands back a fresh
 * refresh token, so the next launch authenticates with the current secret.
 * No-ops when nothing is stored (there is no pairing to attach it to).
 */
export function persistRotatedRemoteCredential(cred: {
  deviceId: string;
  refreshToken: string;
}): void {
  if (remoteCredentialPersistenceDisabled()) return;
  const existing = loadStoredRemotePairingFromStore();
  if (!existing) return;
  persistOrWarn("could not persist rotated credential", () =>
    saveDeviceCredential({
      ...existing,
      deviceId: cred.deviceId,
      refreshToken: cred.refreshToken,
      rotatedAt: Date.now(),
    })
  );
}

/**
 * Persist a freshly-paired WebRTC remote — the pairing material (minus the
 * one-time `code`) plus the device credential the server issued. Called from the
 * fresh-pair session's `onPaired` (serverSession.establishFreshPairSession) so
 * the NEXT launch reconnects with the refresh token instead of re-pairing.
 */
export function saveStoredRemote(value: StoredRemote): void {
  if (remoteCredentialPersistenceDisabled()) return;
  persistOrWarn("could not persist remote pairing", () => saveDeviceCredential(value));
}

export interface RemoteCredCurrent {
  configured: boolean;
  isActive: boolean;
  /**
   * Only ever "device" (a paired WebRTC remote) or "none". The old
   * "admin-token"/"hybrid" cleartext-remote kinds were deleted (§8c); their UI
   * branches are dead. `url`/`tokenPreview`/`hubUrl` likewise no longer exist —
   * a remote is reached over WebRTC, not by URL.
   */
  bootstrap: "device" | "none";
  deviceId?: string;
  workspaceName?: string;
}

export interface TestConnectionResult {
  ok: boolean;
  error?: "invalid-url" | "unreachable" | "unauthorized" | "unknown";
  message?: string;
  serverVersion?: string;
  serverId?: string;
  workspaceId?: string;
}

export interface DeviceRecord {
  deviceId: string;
  label: string;
  platform?: string;
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
}

export interface PairingInvite {
  code: string;
  deepLink: string;
  pairUrl: string;
  room: string;
  fp: string;
  sig: string;
  ice?: "all" | "relay";
  srv?: string;
  serverUrl: string;
  expiresAt: number;
  expiresInMs: number;
  serverId: string;
  serverBootId: string;
  workspaceId?: string | null;
}

// `exchangePairingCode` (the throwaway redeem-then-relaunch) was removed: the
// bootstrap now hands a parsed pairing straight to
// `establishServerSession({ pendingPairing })`, and that single WebRTC pipe
// authenticates with the one-time code and stays as the session.

function authClientFor(client: ServerClient) {
  return createTypedServiceClient("auth", authMethods, (svc, m, a) => client.call(svc, m, a));
}

export function createRemoteCredService(deps: {
  startupMode: StartupMode;
  getServerClient?: () => ServerClient | null;
  /**
   * The current session's transport mode. `getCurrent` reports a remote as
   * ACTIVE only when the live client is genuinely the remote pipe — after a
   * `--skip-remote-pairing` fallback the live client is the LOCAL loopback one,
   * and reporting its `isConnected()` as "remote active" is a lie (the dialog
   * would show a green "connected to remote" while actually on local).
   */
  getConnectionMode?: () => "local" | "remote";
  getViewManager?: () => ViewManager;
}): ServiceDefinition {
  const liveServerClient = (): ServerClient | null => deps.getServerClient?.() ?? null;
  return {
    name: "remoteCred",
    description: "Manage the Electron-side remote-server credential store",
    // Hosted workspace chrome is an `app`; native-host `shell` also calls here.
    // App callers are gated to authorized chrome (panel-hosting) so no arbitrary
    // app can manage creds.
    policy: { allowed: ["shell", "app"] },
    methods: remoteCredMethods,
    handler: async (_ctx, method, args) => {
      if (_ctx.caller.runtime.kind === "app") {
        if (!deps.getViewManager) {
          throw new Error(`remoteCred.${method} app capability unavailable`);
        }
        requireChromeAppCallerOrHost(_ctx, deps.getViewManager(), `remoteCred.${method}`);
      }
      switch (method) {
        case "getCurrent": {
          // Reflect the persisted WebRTC pairing. "Active" requires BOTH a stored
          // remote AND that the live session is genuinely the remote pipe — not
          // the loopback client we fell back to after a failed remote connect
          // (`--skip-remote-pairing`). Reporting the loopback client's
          // `isConnected()` as remote-active would show a false green banner.
          const stored = loadStoredRemotePairing();
          const client = liveServerClient();
          const onRemotePipe = deps.getConnectionMode?.() === "remote";
          const localCredential =
            !onRemotePipe && deps.startupMode.kind === "local"
              ? loadDeviceCredentialByWorkspaceId(deps.startupMode.workspaceId)
              : null;
          return {
            configured: !!stored,
            isActive: !!stored && onRemotePipe && (client?.isConnected() ?? false),
            bootstrap: stored ? "device" : "none",
            deviceId: stored?.deviceId ?? localCredential?.deviceId,
            workspaceName: stored?.workspaceName,
          } satisfies RemoteCredCurrent;
        }
        case "save":
          // Admin-token remote persistence rode the deleted cleartext-remote
          // store (§8c). Remote servers are paired by WebRTC QR now; fail loud
          // rather than pretend to persist an admin-token remote.
          throw new Error(
            "Admin-token remote persistence was removed (§8c). Pair a server over WebRTC instead."
          );
        case "testConnection": {
          // Rewritten to drop the TLS fingerprint probe: just validate the URL
          // resolves to a loopback gateway and that the token authenticates. The
          // only cleartext origin allowed post-cutover is loopback; a remote
          // server is reached over WebRTC, not tested by URL here.
          const payload = args[0] as { url: string; token: string };
          let selected: ReturnType<typeof parseSelectedWorkspaceUrl>;
          try {
            selected = parseSelectedWorkspaceUrl(payload.url);
          } catch (error) {
            return {
              ok: false,
              error: "invalid-url",
              message: error instanceof Error ? error.message : String(error),
            } satisfies TestConnectionResult;
          }
          const parsed = new URL(selected.serverUrl);
          const gatewayPort = parseInt(parsed.port, 10) || 80;
          let client: Awaited<ReturnType<typeof createServerClient>> | null = null;
          try {
            // createServerClient dials the fixed loopback gateway for the port.
            client = await createServerClient(gatewayPort, payload.token, { reconnect: false });
          } catch (err) {
            const msg = (err as Error).message ?? "auth failed";
            const isAuth = /auth|unauthorized|401|token/i.test(msg);
            const isReach = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|timed out|timeout/i.test(msg);
            return {
              ok: false,
              error: isAuth ? "unauthorized" : isReach ? "unreachable" : "unknown",
              message: msg,
            } satisfies TestConnectionResult;
          } finally {
            try {
              await client?.close();
            } catch {
              /* ignore */
            }
          }
          return { ok: true } satisfies TestConnectionResult;
        }
        case "exchangePairingCode": {
          // New model: there is NO separate redeem step — the WebRTC pipe
          // authenticates with the one-time code on connect (establishServerSession),
          // so this can't redeem in-process. Relaunch carrying the pairing as a
          // `vibestudio://` deep-link arg; the startup's enqueueFirstArgvLink →
          // getPendingConnectLink hands it to establishServerSession, which dials it
          // and KEEPS the pipe as the session (the issued device credential persists
          // on onPaired). The shell-reachable analogue of the bootstrap pair-remote IPC.
          const { link, label } = (args[0] ?? {}) as { link?: string; label?: string };
          const parsed = parseConnectLink(typeof link === "string" ? link : "");
          if (parsed.kind === "error") {
            return {
              ok: false,
              error: "invalid-url",
              message: parsed.reason,
            } satisfies TestConnectionResult;
          }
          const { kind: _kind, ...pairing } = parsed;
          const deepLink = createConnectDeepLink(pairing);
          // Drop any prior pairing/label arg so relaunches don't accumulate stale
          // ones, then carry the fresh link (and the device label the dialog sent,
          // so the paired desktop shows a name instead of unlabeled — bug 11).
          const relaunchArgs = process.argv
            .slice(1)
            .filter(
              (a) =>
                !a.startsWith("vibestudio://") &&
                !a.startsWith(PAIR_LABEL_ARG_PREFIX) &&
                a !== PAIR_CONFIRMED_ARG
            );
          relaunchArgs.push(deepLink);
          // This link came from an explicit in-app Save/Switch action, so the
          // trust confirmation already happened. External deep links omit it.
          relaunchArgs.push(PAIR_CONFIRMED_ARG);
          if (typeof label === "string" && label.trim()) {
            relaunchArgs.push(`${PAIR_LABEL_ARG_PREFIX}${encodeURIComponent(label.trim())}`);
          }
          relaunchApp({ args: relaunchArgs });
          return { ok: true } satisfies TestConnectionResult; // unreachable; relaunchApp exits
        }
        case "createPairingInvite": {
          // Mint a pairing invite on the currently-connected server (local OR
          // remote). Available whenever a server session exists — it never
          // depended on the client-side store.
          const client = liveServerClient();
          if (!client) throw new Error("Not connected to a server");
          const payload = (args[0] ?? {}) as { ttlMs?: number };
          return await authClientFor(client).createPairingInvite({ ttlMs: payload.ttlMs });
        }
        case "listDevices": {
          const client = liveServerClient();
          if (!client) return [];
          const response = await authClientFor(client).listDevices();
          return response.devices;
        }
        case "revokeDevice": {
          const deviceId = args[0] as string;
          const client = liveServerClient();
          if (!client) throw new Error("Not connected to a server");
          return await authClientFor(client).revokeDevice(deviceId);
        }
        case "reconnectNow": {
          const client = liveServerClient();
          if (!client?.nudge) {
            throw new Error(
              "Reconnect isn't available for this connection — try relaunching Vibestudio."
            );
          }
          client.nudge();
          return;
        }
        case "clear":
          // Forget the persisted WebRTC pairing; the next launch starts unpaired
          // (local chooser) until a new server is paired.
          clearStoredRemotePairingInStore();
          return { ok: true };
        case "relaunch":
          relaunchApp();
          return { ok: true };
        default:
          throw new Error(`Unknown remoteCred method: ${method}`);
      }
    },
  };
}

function parseSelectedWorkspaceUrl(raw: string): {
  serverUrl: string;
  hubUrl: string;
  workspaceName: string;
} {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Server URL is not parseable: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Server URL must use http:// or https:// (got ${url.protocol || "no scheme"})`);
  }
  if (!url.hostname) throw new Error("Server URL is missing a hostname");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Workspace URL must not include credentials, query, or fragment");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error(
      `Cleartext HTTP is only allowed for loopback. A remote server is reached over WebRTC, not by URL. Use https:// for ${url.hostname}.`
    );
  }
  const workspaceName = selectedWorkspaceNameFromUrl(url);
  if (!workspaceName) {
    throw new Error("Remote credentials require a selected workspace URL");
  }
  const pathName = url.pathname.replace(/\/+$/, "");
  const hubUrl = `${url.protocol}//${url.host}`;
  return {
    serverUrl: `${hubUrl}${pathName}`,
    hubUrl,
    workspaceName,
  };
}
