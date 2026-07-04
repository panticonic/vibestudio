/**
 * Shared React Native WebRTC shell-connection helper, used by BOTH the native
 * host bootstrap (`apps/mobile/index.js`) and the workspace app
 * (`workspace/apps/mobile`, after the RN reload). Both bundle through the same
 * `apps/mobile/metro.config.js`, which resolves `@vibez1/<name>` to its `src/`.
 *
 * It builds the WebRTC pipe + a `shell` session and wraps it in an RPC client.
 * The pipe FAILS CLOSED if the observed DTLS fingerprint does not match the
 * paired `fp` (the transport rejects before any session token is sent). The
 * signaling room persists across an RN reload and the server answerer waits for
 * a new offer, so `reconnectViaWebRtc` re-pairs to the SAME room with the stored
 * refresh credential.
 */

// MUST be first: installs TextDecoder/ReadableStream on Hermes before any
// `@vibez1/rpc` module (the streamCodec) loads, or it throws on init.
import "./polyfills.js";
import { AppState, type AppStateStatus } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Keychain from "react-native-keychain";
import { createRpcClient } from "@vibez1/rpc";
import type { RpcClient } from "@vibez1/rpc";
import type { WebRtcTransport, WebRtcSession } from "@vibez1/rpc/transports/webrtcClient";
import { createPairedConnection } from "@vibez1/rpc/transports/pairedConnection";
import { DEFAULT_CHUNK_SIZE } from "@vibez1/rpc/transports/webrtcPeer";
import { createReactNativeWebRtcProvider } from "./reactNativeWebRtcPeer.js";

/** Legacy AsyncStorage key (plaintext) — kept only to migrate off it on load. */
export const SHELL_CREDENTIAL_KEY = "vibez1:webrtc:shell-credential";
/** OS Keychain/Keystore service the durable shell credential is stored under. */
const KEYCHAIN_SERVICE = "vibez1:webrtc:shell-credential";

function parseStoredCredential(raw: string | null | undefined): StoredShellCredential | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredShellCredential;
    if (
      parsed?.deviceId &&
      parsed?.refreshToken &&
      parsed?.pairing?.room &&
      parsed?.pairing?.fp &&
      parsed?.pairing?.sig
    ) {
      return parsed;
    }
  } catch {
    // fall through
  }
  return null;
}

export interface ShellPairing {
  /** Signaling room UUID. */
  room: string;
  /** Server DTLS SHA-256 fingerprint (uppercase colon-hex) — pinned, fail-closed. */
  fp: string;
  /** Signaling endpoint URL (ws/wss). */
  sig: string;
  /** ICE transport policy ("all" | "relay"). */
  ice?: string;
  /** Optional server label/origin. */
  srv?: string | null;
  /** One-time pairing code (fresh pairing only). */
  code?: string;
}

export interface ShellCredential {
  deviceId: string;
  refreshToken: string;
}

export interface StoredShellCredential extends ShellCredential {
  pairing: ShellPairing;
  pairedAt: number;
}

export interface ShellTokenProvider {
  getToken(): string;
  setCredential(next: ShellCredential | null): void;
}

export interface WebRtcConnectionHandlers {
  /** Persist the freshly issued device credential. AWAITED with retry by the
   * shared bootstrap; a persistent failure surfaces via {@link onPersistError},
   * never a void'd rejection. */
  onPaired?: (credential: ShellCredential) => void | Promise<void>;
  /** The credential persist exhausted its retries — surface it (log/telemetry),
   * never swallow it. */
  onPersistError?: (error: Error) => void;
  onServerEvent?: (event: string, payload: unknown) => void;
  /**
   * Post-auth recovery signal raised by the session on (re)open: `"resubscribe"`
   * for a normal reconnect, `"cold-recover"` when the server restarted
   * (serverBootId changed) / the session was dirty. Without this wired, the app
   * only ever does the lighter resubscribe and shows stale server-derived state
   * after a remote restart.
   */
  onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>;
}

export interface WebRtcConnection {
  rpc: RpcClient;
  session: WebRtcSession;
  transport: WebRtcTransport;
  callerId: string;
  deviceId?: string | null;
  close(): Promise<void>;
}

export function randomRequestId(prefix = "mobile-shell"): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Stateful shell-token provider. A fresh device redeems the one-time pairing
 * `code`; once the server hands back a durable device credential (`onPaired`),
 * every (re)open switches to `refresh:<deviceId>:<refreshToken>`. The transport
 * re-invokes `getToken` on each session (re)open, so this is read live.
 */
export function makeShellTokenProvider(
  pairing: ShellPairing,
  initialCredential: ShellCredential | null
): ShellTokenProvider {
  let credential = initialCredential;
  return {
    getToken() {
      if (credential) return `refresh:${credential.deviceId}:${credential.refreshToken}`;
      return pairing.code ?? "";
    },
    setCredential(next) {
      credential = next;
    },
  };
}

export async function persistShellCredential(
  credential: ShellCredential,
  pairing: ShellPairing
): Promise<void> {
  const payload = JSON.stringify({
    deviceId: credential.deviceId,
    refreshToken: credential.refreshToken,
    // The signaling room persists for reconnects, so re-store the pairing.
    pairing: {
      room: pairing.room,
      fp: pairing.fp,
      sig: pairing.sig,
      ice: pairing.ice ?? "all",
      srv: pairing.srv ?? null,
    },
    pairedAt: Date.now(),
  });
  // The refresh secret is the device's durable secret — store it in the OS
  // Keychain/Keystore, NEVER plaintext AsyncStorage (the desktop store fails loud
  // rather than persist this unencrypted; mobile must match). setGenericPassword
  // rejects when the secure store is unavailable, so this fails loud too.
  await Keychain.setGenericPassword("shell", payload, { service: KEYCHAIN_SERVICE });
}

export async function loadShellCredential(): Promise<StoredShellCredential | null> {
  const result = await Keychain.getGenericPassword({ service: KEYCHAIN_SERVICE });
  if (result) {
    const parsed = parseStoredCredential(result.password);
    if (parsed) return parsed;
  }
  // One-time migration off the legacy plaintext AsyncStorage store: move it into
  // the Keychain and ERASE the cleartext copy, so the refresh secret never lingers
  // recoverable (adb / Android backup / rooted device) after the first launch.
  const legacy = await AsyncStorage.getItem(SHELL_CREDENTIAL_KEY);
  if (legacy) {
    const parsed = parseStoredCredential(legacy);
    await AsyncStorage.removeItem(SHELL_CREDENTIAL_KEY);
    if (parsed) {
      await Keychain.setGenericPassword("shell", legacy, { service: KEYCHAIN_SERVICE });
      return parsed;
    }
  }
  return null;
}

export async function clearShellCredential(): Promise<void> {
  await Keychain.resetGenericPassword({ service: KEYCHAIN_SERVICE });
  // Also drop any legacy plaintext copy (pre-Keychain installs).
  await AsyncStorage.removeItem(SHELL_CREDENTIAL_KEY);
}

export function deviceIdFromCallerId(callerId: string | undefined): string | null {
  return typeof callerId === "string" && callerId.startsWith("shell:")
    ? callerId.slice("shell:".length)
    : null;
}

/**
 * Register the mobile event-driven reconnect triggers on a live transport:
 * `nudge()` on active-foreground and on network-type change, so a drop is
 * detected in SECONDS instead of waiting out the ~45 s keepalive (RN suspends JS
 * timers in the background, so the keepalive alone can't notice a resume). Both
 * are guarded — `nudge()` is a no-op unless the pipe is up and no recovery is in
 * flight — and each listener is optional (NetInfo degrades to AppState-only if
 * unavailable). Returns a cleanup that removes every listener.
 */
function registerReconnectTriggers(transport: WebRtcTransport): () => void {
  const cleanups: Array<() => void> = [];
  // Foreground resume: probe liveness immediately (the background may have
  // silently killed the pipe while timers were frozen).
  try {
    let last: AppStateStatus = AppState.currentState;
    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      const cameToForeground = next === "active" && last !== "active";
      last = next;
      if (cameToForeground) transport.nudge();
    });
    cleanups.push(() => sub.remove());
  } catch (error) {
    console.warn("[mobile-rtc] AppState reconnect trigger unavailable", error);
  }
  // Network-type change (wifi↔cellular / new IP): the old ICE path is almost
  // certainly dead — nudge to fail fast and re-establish over the new interface.
  try {
    let lastType: string | null = null;
    const unsub = NetInfo.addEventListener((state) => {
      const type = state.type ?? null;
      // The first event is the current state on subscribe — record it, no nudge.
      if (lastType !== null && type !== lastType) transport.nudge();
      lastType = type;
    });
    cleanups.push(() => unsub());
  } catch (error) {
    console.warn("[mobile-rtc] NetInfo reconnect trigger unavailable (AppState-only)", error);
  }
  return () => {
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        /* ignore */
      }
    }
  };
}

/**
 * Build the WebRTC pipe + a `shell` session and wrap it in an RPC client — over
 * the ONE shared client bootstrap (`createPairedConnection`, plan §3.1): it owns
 * connect-with-timeout, main-session auth, close-on-ANY-failure (incl. a
 * session-auth rejection), and the onPaired await-retry. This file adds only the
 * mobile-specific concerns: the RN peer provider and the AppState/NetInfo
 * reconnect triggers.
 */
export async function establishWebRtcConnection(
  pairing: ShellPairing,
  tokenProvider: ShellTokenProvider,
  handlers: WebRtcConnectionHandlers = {}
): Promise<WebRtcConnection> {
  const connectionId = randomRequestId("mobile-shell");
  // No webSocketImpl/fetchImpl → the signaling client uses the RN WebSocket +
  // fetch globals.
  const paired = await createPairedConnection({
    provider: createReactNativeWebRtcProvider({ logPrefix: "[mobile-rtc]" }),
    pairing: {
      room: pairing.room,
      fingerprint: pairing.fp,
      iceTransportPolicy: pairing.ice as "all" | "relay" | undefined,
    },
    sig: pairing.sig,
    getShellToken: () => tokenProvider.getToken(),
    connectionId,
    callerKind: "shell",
    clientLabel: "Mobile device",
    clientPlatform: "mobile",
    platform: "mobile",
    chunkSize: DEFAULT_CHUNK_SIZE,
    logPrefix: "[mobile-rtc]",
    ...(handlers.onPaired ? { onPaired: handlers.onPaired } : {}),
    ...(handlers.onPersistError ? { onPersistError: handlers.onPersistError } : {}),
    ...(handlers.onRecovery
      ? {
          onRecovery: (kind) => {
            void handlers.onRecovery!(kind);
          },
        }
      : {}),
  });
  const { transport, mainSession: session } = paired;
  try {
    const callerId = session.callerId() || "shell:pending";
    if (handlers.onServerEvent) {
      session.onMessage((envelope) => {
        const message = (
          envelope as { message?: { type?: string; event?: string; payload?: unknown } }
        )?.message;
        if (message && message.type === "event") {
          handlers.onServerEvent?.(message.event ?? "", message.payload);
        }
      });
    }
    const client = createRpcClient({
      selfId: callerId,
      callerKind: "shell",
      transport: session,
      // §3.4 pending-call policy: reject routed pendings on a cold-recover.
      onRecovery: (handler) => paired.onRecovery(handler),
    });
    const removeTriggers = registerReconnectTriggers(transport);
    return {
      rpc: client,
      session,
      transport,
      callerId,
      async close() {
        removeTriggers();
        try {
          await paired.close();
        } catch {
          // already closed
        }
      },
    };
  } catch (error) {
    // Any post-connect setup failure closes the (connected) pipe too — no leaked
    // keepalive/reconnect loop (createPairedConnection already guards connect/auth).
    await paired.close().catch(() => undefined);
    throw error;
  }
}

/** Returning device: reconnect with the stored refresh secret over the same room. */
export async function reconnectViaWebRtc(
  stored: StoredShellCredential,
  onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>
): Promise<WebRtcConnection> {
  const pairing = stored.pairing;
  const tokenProvider = makeShellTokenProvider(pairing, {
    deviceId: stored.deviceId,
    refreshToken: stored.refreshToken,
  });
  const connection = await establishWebRtcConnection(pairing, tokenProvider, {
    onPaired: async (credential) => {
      // The server may rotate the refresh secret on reconnect; persist the latest.
      // RETURNED (not void'd) so the shared bootstrap AWAITS it with retry — a
      // dropped rotation would otherwise leave the device unable to reconnect.
      tokenProvider.setCredential(credential);
      await persistShellCredential(credential, pairing);
    },
    onPersistError: (error) => {
      // Surfaced, never swallowed: the rotated secret did not reach the Keychain.
      console.warn("[mobile-rtc] failed to persist rotated shell credential", error);
    },
    onRecovery,
  });
  connection.deviceId = stored.deviceId;
  return connection;
}
