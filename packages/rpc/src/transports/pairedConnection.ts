/**
 * `createPairedConnection()` — the ONE client bootstrap shared by every
 * platform that dials a paired server: desktop main (`webrtcServerClient.ts`),
 * mobile (`mobile-webrtc`), and the CLI. Plan §3.1.
 *
 * Before this existed, three clients (desktop main, mobile, and a since-deleted
 * CLI WebRTC client) hand-rolled the same sequence — dial the paired server's
 * signaling room as the offerer, stand up the DTLS pipe, open + auth the `shell`
 * main session — and had already DIVERGED: two of three closed the transport on
 * a failed connect, one didn't; one ran `mainSession.ready()` OUTSIDE the
 * close-on-failure guard (leaking a connected transport's keepalive/reconnect
 * loop on a session-auth failure); the CLI wasn't promise-memoized (concurrent
 * establishes leaked duplicate transports); and mobile void-swallowed its
 * credential-persist rejection. This helper owns every one of those seams so
 * they cannot drift again:
 *
 *  - **connect with timeout** — delegates to the transport's bounded initial
 *    connect (`connectTimeoutMs`); an unreachable peer fails loud, never hangs.
 *  - **close-on-ANY-failure** — a rejection from `connect()` OR from
 *    `mainSession.ready()` (session auth) closes the transport in the error path,
 *    so no connected-but-unauthenticated pipe is left running its keepalive/
 *    reconnect loops. This is the exact bug class that diverged before.
 *  - **onPaired persistence** — awaited with retry (3 attempts + backoff); a
 *    persistent failure is surfaced via `onPersistError`, NEVER a void'd
 *    rejection. `mainSession.ready()` does not resolve until the retry loop
 *    finishes, so callers cannot race ahead of durable credential storage.
 *  - **recovery fan-out** — the main session's post-auth recovery signal
 *    (`resubscribe`/`cold-recover`, fired on every open incl. the first) is
 *    delivered to the `onRecovery` option AND to every subscriber of
 *    `PairedConnection.onRecovery`. Consumers wire `createRpcClient`'s
 *    `onRecovery` seam (§3.4 pending-call policy) via that subscription:
 *
 *    ```ts
 *    const paired = await createPairedConnection({ ... });
 *    const rpc = createRpcClient({
 *      selfId, transport: paired.mainSession,
 *      onRecovery: (handler) => paired.onRecovery(handler),
 *    });
 *    ```
 *
 * Single-flight: the factory itself returns a promise; **callers memoize that
 * promise** so a concurrent second establish never opens a duplicate pipe.
 */

import type { RecoveryKind } from "../protocol/recoveryCoordinator.js";
import type { DeviceCredential, PairingContext } from "../protocol/wsProtocol.js";
import { createSignalingClient } from "./webrtcSignalingClient.js";
import type {
  PeerConnectionProvider,
  RtcCandidateType,
  RtcIceServer,
  WebRtcPairing,
} from "./webrtcPeer.js";
import type { SignalingClient } from "./webrtcSignaling.js";
import {
  createWebRtcTransport,
  type WebRtcSession,
  type WebRtcSessionOptions,
  type WebRtcTransport,
} from "./webrtcClient.js";

export type { DeviceCredential, PairingContext } from "../protocol/wsProtocol.js";

export interface CreatePairedConnectionOptions {
  /** Transport-level pairing: pinned server DTLS fingerprint + room + ICE policy. */
  pairing: WebRtcPairing;
  /** Platform peer factory (node-datachannel desktop/CLI, react-native-webrtc
   * mobile). Required unless a pre-built {@link transport} is supplied. */
  provider?: PeerConnectionProvider;
  /**
   * Signaling-room client factory (invoked once per (re)establish so a recovery
   * gets a fresh room socket). Defaults to a `createSignalingClient({ role:
   * "offerer" })` built from `pairing.room` + `sig`. The default REQUIRES `sig`.
   */
  createSignaling?: () => SignalingClient;
  /** Signaling endpoint URL (`sig=` from the link) — used by the default
   * `createSignaling`; ignored when `createSignaling` is supplied. */
  sig?: string;
  /** Node `ws` ctor + `fetch` for the default signaling client (desktop/CLI).
   * Omit on React Native — the signaling client falls back to platform globals. */
  webSocketImpl?: unknown;
  fetchImpl?: typeof fetch;

  /** Main-session grant/refresh token provider — re-invoked per (re)open. */
  getShellToken(): Promise<string> | string;
  /**
   * Fired once when the main session paired a fresh device (redeemed the QR
   * code): AWAITED with retry (3 attempts + backoff); a persistent failure is
   * surfaced via {@link onPersistError}, never a void'd rejection.
   */
  onPaired?(credential: DeviceCredential, context?: PairingContext): Promise<void> | void;
  /** Main logical session was rejected or terminally closed while the pipe may remain up. */
  onTerminalClose?(error: Error): void;
  /** Persistence hook failed after all `onPaired` retries. */
  onPersistError?(error: Error): void;
  /** Post-auth recovery passthrough (fires on every open incl. the first). */
  onRecovery?(kind: RecoveryKind): void;
  /** Relay-alarm feed passthrough (selected ICE candidate type; `null` on down). */
  onCandidateType?(type: RtcCandidateType | null): void;

  /** Upper bound (ms) on the initial connect before it rejects. */
  connectTimeoutMs?: number;
  /** Optional cap on the max data-channel message size this side advertises. */
  chunkSize?: number;
  /** Main session identity/telemetry. */
  connectionId?: string;
  sid?: string;
  clientLabel?: string;
  clientSessionId?: string;
  clientPlatform?: "desktop" | "headless" | "mobile";
  /** Advertised in the hello preamble (informational). */
  platform?: "desktop" | "mobile" | "server" | "headless";
  logPrefix?: string;

  /** Test seam: a pre-built transport (skips provider/signaling construction). */
  transport?: WebRtcTransport;
}

export interface PairedConnection {
  /** The connected, hello-negotiated pipe. */
  readonly transport: WebRtcTransport;
  /** The connected AND authenticated main (`shell`) session. */
  readonly mainSession: WebRtcSession;
  /** Open an additional logical session over the same pipe. */
  openSession(options: WebRtcSessionOptions): WebRtcSession;
  /** Liveness-probe passthrough — see {@link WebRtcTransport.nudge}. */
  nudge(): void;
  /**
   * Subscribe to the main session's post-auth recovery signal. Additive to the
   * `onRecovery` option; used to wire `createRpcClient`'s recovery seam (§3.4).
   * Returns an unsubscribe. NB: a subscription registered after the returned
   * promise resolves misses the FIRST-open recovery (there are no pending calls
   * yet, so the §3.4 consumer does not care).
   */
  onRecovery(handler: (kind: RecoveryKind) => void): () => void;
  /** Close the main session and the transport (idempotent). */
  close(): Promise<void>;
}

function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  return `pc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** onPaired retry policy: 3 attempts, 250 ms·2ⁿ backoff (cap 1 s). */
const ON_PAIRED_MAX_ATTEMPTS = 3;
function onPairedBackoffMs(attempt: number): number {
  return Math.min(250 * 2 ** (attempt - 1), 1_000);
}

function buildTransport(options: CreatePairedConnectionOptions): WebRtcTransport {
  if (!options.provider) {
    throw new Error(
      "createPairedConnection: `provider` is required when `transport` is not supplied"
    );
  }
  const provider = options.provider;
  const createSignaling =
    options.createSignaling ??
    ((): SignalingClient => {
      if (!options.sig) {
        throw new Error(
          "createPairedConnection: `sig` is required when `createSignaling` is not supplied"
        );
      }
      return createSignalingClient({
        room: options.pairing.room,
        sig: options.sig,
        role: "offerer",
        ...(options.webSocketImpl ? { WebSocketImpl: options.webSocketImpl as never } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
    });
  return createWebRtcTransport({
    provider,
    createSignaling,
    pairing: options.pairing,
    role: "offerer",
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.logPrefix ? { logPrefix: options.logPrefix } : {}),
    ...(options.connectTimeoutMs ? { connectTimeoutMs: options.connectTimeoutMs } : {}),
    ...(options.chunkSize ? { chunkSize: options.chunkSize } : {}),
    ...(options.onCandidateType ? { onCandidateType: options.onCandidateType } : {}),
  });
}

export async function createPairedConnection(
  options: CreatePairedConnectionOptions
): Promise<PairedConnection> {
  const log = options.logPrefix ?? "[paired]";
  const transport = options.transport ?? buildTransport(options);

  // Recovery fan-out. The `onRecovery` option is the FIRST subscriber, registered
  // synchronously before the session opens so it catches the first-open recovery.
  const recoveryHandlers = new Set<(kind: RecoveryKind) => void>();
  if (options.onRecovery) recoveryHandlers.add(options.onRecovery);
  const fanoutRecovery = (kind: RecoveryKind): void => {
    for (const handler of [...recoveryHandlers]) {
      try {
        handler(kind);
      } catch (error) {
        console.warn(`${log} recovery handler threw`, error);
      }
    }
  };

  // onPaired: awaited by the session before ready() resolves. A persistent
  // failure is surfaced via onPersistError, not as a void'd rejection.
  const runOnPaired = options.onPaired
    ? async (credential: DeviceCredential, context?: PairingContext): Promise<void> => {
        for (let attempt = 1; attempt <= ON_PAIRED_MAX_ATTEMPTS; attempt++) {
          try {
            await options.onPaired!(credential, context);
            return;
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            if (attempt < ON_PAIRED_MAX_ATTEMPTS) {
              console.warn(
                `${log} onPaired persist failed (attempt ${attempt}/${ON_PAIRED_MAX_ATTEMPTS})`,
                err
              );
              await sleep(onPairedBackoffMs(attempt));
              continue;
            }
            // Exhausted — surface it; NEVER let the rejection vanish.
            try {
              options.onPersistError?.(err);
            } catch (surfaceError) {
              console.warn(`${log} onPersistError threw`, surfaceError);
            }
          }
        }
      }
    : undefined;

  // connect() rejects (bounded) on an unreachable peer; close on failure so the
  // transport's background reconnect loop stops instead of re-dialing a dead pairing.
  try {
    await transport.connect();
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }

  const mainSession = transport.openSession({
    connectionId: options.connectionId ?? randomId(),
    ...(options.sid ? { sid: options.sid } : {}),
    ...(options.clientLabel ? { clientLabel: options.clientLabel } : {}),
    ...(options.clientSessionId ? { clientSessionId: options.clientSessionId } : {}),
    ...(options.clientPlatform ? { clientPlatform: options.clientPlatform } : {}),
    getToken: options.getShellToken,
    ...(runOnPaired ? { onPaired: runOnPaired } : {}),
    ...(options.onTerminalClose ? { onTerminalClose: options.onTerminalClose } : {}),
    onRecovery: fanoutRecovery,
  });

  // close-on-ANY-failure INCLUDING a session-auth (ready()) rejection: the exact
  // seam that diverged — a connected transport whose main session never
  // authenticates must not leak its keepalive/reconnect loops.
  try {
    // `ready` is optional on the transport interface but always present on a real
    // WebRtcSession; `?.()` keeps the types honest without changing behavior.
    await mainSession.ready?.();
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }

  return {
    transport,
    mainSession,
    openSession: (opts) => transport.openSession(opts),
    nudge: () => transport.nudge(),
    onRecovery(handler) {
      recoveryHandlers.add(handler);
      return () => recoveryHandlers.delete(handler);
    },
    async close() {
      mainSession.close();
      await transport.close();
    },
  };
}
