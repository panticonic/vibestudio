/**
 * Shared React Native WebRTC shell-connection helper, used by BOTH the native
 * host bootstrap (`apps/mobile/index.js`) and the workspace app
 * (`workspace/apps/mobile`, after the RN reload). Both bundle through the same
 * `apps/mobile/metro.config.js`, which resolves `@vibestudio/<name>` to its `src/`.
 *
 * It builds the WebRTC pipe + a `shell` session and wraps it in an RPC client.
 * The pipe FAILS CLOSED if the observed DTLS fingerprint does not match the
 * paired `fp` (the transport rejects before any session token is sent). The
 * signaling room persists across an RN reload and the server answerer waits for
 * a new offer, so `reconnectViaWebRtc` re-pairs to the SAME room with the stored
 * refresh credential.
 */

// MUST be first: installs TextDecoder/ReadableStream on Hermes before any
// `@vibestudio/rpc` module (the streamCodec) loads, or it throws on init.
import "./polyfills.js";
import { AppState, type AppStateStatus } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import * as Keychain from "react-native-keychain";
import { createRpcClient } from "@vibestudio/rpc";
import type { RpcClient } from "@vibestudio/rpc";
import type { WebRtcTransport, WebRtcSession } from "@vibestudio/rpc/transports/webrtcClient";
import { createPairedConnection } from "@vibestudio/rpc/transports/pairedConnection";
import { DEFAULT_CHUNK_SIZE } from "@vibestudio/rpc/transports/webrtcPeer";
import {
  createStoredShellCredential,
  parseStoredShellCredential,
  type ShellCredential,
  type ShellPairing,
  type StoredShellCredential,
} from "./storedCredential.js";
import { createReactNativeWebRtcProvider } from "./reactNativeWebRtcPeer.js";

export type {
  ShellCredential,
  ShellPairing,
  StoredShellCredential,
  StoredShellPairing,
} from "./storedCredential.js";

/** OS Keychain/Keystore service the durable shell credential is stored under. */
const KEYCHAIN_SERVICE = "vibestudio:webrtc:shell-credential";

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

async function closeAfterFailure(
  close: () => Promise<void>,
  failure: unknown,
  context: string
): Promise<void> {
  try {
    await close();
  } catch (closeError) {
    const failureMessage = failure instanceof Error ? failure.message : String(failure);
    const closeMessage = closeError instanceof Error ? closeError.message : String(closeError);
    throw new Error(`${context} (${failureMessage}) and cleanup failed (${closeMessage})`);
  }
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
  controlPairing: ShellPairing,
  workspacePairing: ShellPairing,
  pairedAt = Date.now()
): Promise<void> {
  await persistStoredShellCredential(
    createStoredShellCredential(credential, controlPairing, workspacePairing, pairedAt)
  );
}

/**
 * Atomically replace the one current mobile credential in the OS secure store.
 * Keychain/Keystore updates a generic-password item as one transaction; there is
 * deliberately no second plaintext marker or previous-schema fallback to drift
 * out of sync with it.
 */
export async function persistStoredShellCredential(stored: StoredShellCredential): Promise<void> {
  const payload = JSON.stringify(stored);
  if (parseStoredShellCredential(payload) === null) {
    throw new Error("Cannot persist an invalid current WebRTC shell credential");
  }
  // The refresh secret is the device's durable secret — store it in the OS
  // Keychain/Keystore, NEVER plaintext AsyncStorage (the desktop store fails loud
  // rather than persist this unencrypted; mobile must match). setGenericPassword
  // rejects when the secure store is unavailable, so this fails loud too.
  const result = await Keychain.setGenericPassword("shell", payload, {
    service: KEYCHAIN_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  if (result === false) {
    throw new Error("The OS secure store refused the WebRTC shell credential update");
  }
}

export async function loadShellCredential(): Promise<StoredShellCredential | null> {
  const result = await Keychain.getGenericPassword({ service: KEYCHAIN_SERVICE });
  return result ? parseStoredShellCredential(result.password) : null;
}

export async function clearShellCredential(): Promise<void> {
  const cleared = await Keychain.resetGenericPassword({ service: KEYCHAIN_SERVICE });
  if (!cleared) {
    throw new Error("The OS secure store refused to clear the WebRTC shell credential");
  }
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
        // PairedConnection.close is idempotent. A real transport-close failure
        // must remain observable to callers; treating every rejection as
        // "already closed" hid leaked keepalive/session cleanup failures.
        await paired.close();
      },
    };
  } catch (error) {
    // Any post-connect setup failure closes the (connected) pipe too — no leaked
    // keepalive/reconnect loop (createPairedConnection already guards connect/auth).
    await closeAfterFailure(() => paired.close(), error, "Mobile WebRTC setup failed");
    throw error;
  }
}

/** Returning device: reconnect with the stored refresh secret over the same room. */
export async function reconnectViaWebRtc(
  stored: StoredShellCredential,
  onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>
): Promise<WebRtcConnection> {
  const pairing = stored.workspacePairing;
  const tokenProvider = makeShellTokenProvider(pairing, {
    deviceId: stored.deviceId,
    refreshToken: stored.refreshToken,
  });
  const persistFailure: { current: Error | null } = { current: null };
  const connection = await establishWebRtcConnection(pairing, tokenProvider, {
    onPaired: async (credential) => {
      // The server may rotate the refresh secret on reconnect; persist the latest.
      // RETURNED (not void'd) so the shared bootstrap AWAITS it with retry — a
      // dropped rotation would otherwise leave the device unable to reconnect.
      tokenProvider.setCredential(credential);
      await persistShellCredential(
        credential,
        stored.controlPairing,
        stored.workspacePairing,
        stored.pairedAt
      );
    },
    onPersistError: (error) => {
      persistFailure.current = error;
    },
    onRecovery,
  });
  if (persistFailure.current) {
    const error = new Error(
      `Failed to persist the rotated mobile device credential: ${persistFailure.current.message}`
    );
    await closeAfterFailure(() => connection.close(), error, "Mobile reconnect failed");
    throw error;
  }
  connection.deviceId = stored.deviceId;
  return connection;
}
