/**
 * Server-side WebRTC ingress pool (plan §2.1). Replaces the v1 single-pipe
 * bootstrap: instead of ONE persistent room per server, the
 * pool arms one answerer pipe per signaling room — one room per paired device
 * plus one per outstanding pairing invite. Rooms are minted per-invite
 * (`auth.createPairingInvite`), persisted onto the device record at
 * redemption, and torn down on invite expiry / device revocation.
 *
 * Each armed room gets its own `createWebRtcAnswererPipe` attached to the live
 * `RpcServer` via `attachWebRtcPipe` (per-pipe closures — N pipes attach
 * safely). The pipes are LAZY: arming joins the signaling room only; no
 * `RTCPeerConnection` exists until an offer arrives, so N idle rooms cost N
 * WebSockets and zero native peers. Signaling rejoin/backoff is owned by the
 * pipe itself (supervised loop, cap 30 s) — the pool does not babysit it.
 *
 * The native `node-datachannel` provider is created ONCE and shared across
 * pipes, imported lazily so a build without the native module still boots
 * (arming then fails loud per room instead of crashing the server).
 */

import type { RpcConnectionStatus } from "@vibestudio/rpc";
import {
  createWebRtcAnswererPipe,
  type WebRtcAnswererPipe,
} from "@vibestudio/rpc/transports/webrtcAnswerer";
import type {
  PeerConnectionProvider,
  RtcCandidateType,
} from "@vibestudio/rpc/transports/webrtcPeer";
import { createSignalingClient } from "@vibestudio/rpc/transports/webrtcSignalingClient";
import type { TurnPolicy } from "@vibestudio/shared/connect";

/** Minimal surface of RpcServer the pool needs (avoids a hard type dep). */
export interface WebRtcAttachable {
  attachWebRtcPipe(pipe: WebRtcAnswererPipe): void;
}

/** Why a room is armed: an outstanding invite, or an already-paired device. */
export interface WebRtcRoomMeta {
  deviceId?: string;
  inviteCode?: string;
}

export interface WebRtcRoomStatus {
  room: string;
  status: RpcConnectionStatus;
  deviceId?: string;
  /** Selected ICE candidate-pair type of the live pipe — `'relay'` means TURN
   * engaged (the §9.8 relay alarm); null while no peer is up. */
  candidateType: RtcCandidateType | null;
}

/** Per-pool connect counters feeding the §9.8 "relay rate exceeds baseline" alarm. */
export interface WebRtcIngressStats {
  /** Completed pipe connects (hello done) since the pool started. */
  connects: number;
  /** Connects whose selected candidate pair was a TURN relay. */
  relayConnects: number;
}

export interface WebRtcIngress {
  /**
   * Arm an answerer pipe for `room` (idempotent). Re-arming an armed room only
   * merges `meta` — redemption re-tags an invite room with its `deviceId`
   * without touching the live pipe.
   */
  armRoom(room: string, meta: WebRtcRoomMeta): void;
  /** Tear the room's pipe down (device revoked / invite expired). */
  disarmRoom(room: string): Promise<void>;
  status(): WebRtcRoomStatus[];
  stats(): WebRtcIngressStats;
  close(): Promise<void>;
}

export interface WebRtcIngressOptions {
  rpcServer: WebRtcAttachable;
  /** Signaling endpoint base (the QR `sig=`), e.g. wss://signal.example or ws://127.0.0.1:8787. */
  signalUrl: string;
  /** Persistent cert (stable fingerprint → stable QR pin). */
  certificatePemFile: string;
  keyPemFile: string;
  /** The server's DTLS SHA-256 fingerprint (the published pin; for logging). */
  fingerprint: string;
  iceTransportPolicy?: TurnPolicy;
  log?: (message: string) => void;
  /** Loud channel for the relay alarm (§9.8); defaults to `console.warn`. */
  warn?: (message: string) => void;
  /**
   * Test seam: build one answerer pipe for a room. Defaults to the real
   * answerer pipe over the shared lazily-imported node-datachannel provider.
   */
  createPipe?: (room: string) => Promise<WebRtcAnswererPipe>;
}

interface RoomEntry {
  room: string;
  meta: WebRtcRoomMeta;
  pipe: WebRtcAnswererPipe | null;
  disarmed: boolean;
  /** The pipe-creation chain; disarm/close await it before closing the pipe. */
  ready: Promise<void>;
}

/** §9.8 relay-rate alarm: fire once when > this share of connects rode TURN… */
const RELAY_RATE_BASELINE = 0.5;
/** …with at least this many connects (a lone relay connect is not a trend). */
const RELAY_RATE_MIN_CONNECTS = 4;

/**
 * Generous ceiling on concurrently armed answerer rooms. Legitimately there is
 * one room per paired device plus one per outstanding pairing invite — a
 * personal server has at most dozens. This cap is a DoS backstop against a caller
 * that mints invites without bound (each armed room joins a signaling room / owns
 * a supervised rejoin loop); a real deployment never approaches it. Re-arming an
 * already-armed room (redemption re-tag) is never blocked.
 */
const MAX_ARMED_ROOMS = 4096;

export function startWebRtcIngress(options: WebRtcIngressOptions): WebRtcIngress {
  const log = options.log ?? ((m: string) => console.log(`[webrtc-ingress] ${m}`));
  const warn = options.warn ?? ((m: string) => console.warn(`[webrtc-ingress] ${m}`));
  const rooms = new Map<string, RoomEntry>();
  let closed = false;

  // --- relay alarm (§9.8): per-pool connect counters + one aggregated warning.
  let connects = 0;
  let relayConnects = 0;
  let relayRateWarned = false;

  /** Per-connect path telemetry: fired by each pipe on hello-complete. */
  const onPipeCandidateType = (entry: RoomEntry, type: RtcCandidateType | null): void => {
    if (type === null) return; // pipe down — nothing to count
    connects += 1;
    if (type === "relay") relayConnects += 1;
    const device = entry.meta.deviceId ? ` device=${entry.meta.deviceId}` : "";
    log(`room=${entry.room}${device} path=${type}`);
    if (type === "relay") {
      warn(`room=${entry.room}${device}: TURN relay engaged — P2P failed or forced`);
    }
    if (
      !relayRateWarned &&
      connects >= RELAY_RATE_MIN_CONNECTS &&
      relayConnects / connects > RELAY_RATE_BASELINE
    ) {
      relayRateWarned = true; // one aggregated alarm, not one per connect
      warn(
        `relay rate exceeds baseline: ${relayConnects}/${connects} connects rode TURN ` +
          `(> ${RELAY_RATE_BASELINE * 100}% with >= ${RELAY_RATE_MIN_CONNECTS} connects) — ` +
          `check STUN reachability / NAT posture`
      );
    }
  };

  // The native provider is created once and shared by every pipe. Lazy import:
  // a build without node-datachannel still boots; arming fails loud per room.
  let providerPromise: Promise<PeerConnectionProvider> | null = null;
  const getProvider = () =>
    (providerPromise ??= (async () => {
      const { createNodeDatachannelProvider } =
        await import("../main/webrtc/nodeDatachannelPeer.js");
      return createNodeDatachannelProvider({ peerName: "vibestudio-server" });
    })());

  const defaultCreatePipe = async (room: string): Promise<WebRtcAnswererPipe> => {
    const provider = await getProvider();
    const { default: WS } = (await import("ws")) as unknown as {
      default: new (url: string) => unknown;
    };
    return createWebRtcAnswererPipe({
      provider,
      // The pipe owns its supervised signaling rejoin loop (backoff cap 30 s);
      // this factory is called by the pipe on connect() and after every drop.
      createSignaling: () =>
        createSignalingClient({
          room,
          role: "answerer",
          sig: options.signalUrl,
          WebSocketImpl: WS as never,
          fetchImpl: fetch,
        }),
      pairing: {
        iceServers: [],
        iceTransportPolicy: options.iceTransportPolicy,
        certificatePemFile: options.certificatePemFile,
        keyPemFile: options.keyPemFile,
      },
      logPrefix: `[webrtc-ingress ${room.slice(0, 8)}]`,
    });
  };
  const createPipe = options.createPipe ?? defaultCreatePipe;

  const armRoom = (room: string, meta: WebRtcRoomMeta): void => {
    if (closed) {
      log(`armRoom(${room}) ignored: ingress is closed`);
      return;
    }
    const existing = rooms.get(room);
    if (existing) {
      // Idempotent re-arm: merge meta only (invite room → device room re-tag).
      existing.meta = { ...existing.meta, ...meta };
      return;
    }
    if (rooms.size >= MAX_ARMED_ROOMS) {
      // Fail loud, refuse the new room: a legitimate server never approaches this
      // ceiling, so hitting it signals runaway invite minting rather than real
      // devices. Existing armed rooms keep working.
      warn(
        `armRoom(${room}) refused: armed-room cap (${MAX_ARMED_ROOMS}) reached — ` +
          `possible runaway pairing-invite minting`
      );
      return;
    }
    const entry: RoomEntry = {
      room,
      meta: { ...meta },
      pipe: null,
      disarmed: false,
      ready: Promise.resolve(),
    };
    rooms.set(room, entry);
    entry.ready = (async () => {
      const pipe = await createPipe(room);
      if (entry.disarmed) {
        // Disarmed while the pipe was being built — never attach it.
        await pipe.close();
        return;
      }
      entry.pipe = pipe;
      // Relay alarm (§9.8): log each connect's selected path; WARN on TURN.
      pipe.onCandidateType((type) => onPipeCandidateType(entry, type));
      options.rpcServer.attachWebRtcPipe(pipe);
      // Arm signaling and wait for a client, without blocking the caller.
      // connect() resolves on the first completed hello and rejects only on
      // close(); signaling failures retry inside the pipe's supervised loop.
      void pipe
        .connect()
        .then(() => log(`room ${room}: client connected`))
        .catch((error) =>
          log(
            `room ${room}: pipe closed before a client connected: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
      log(
        `armed room ${room}${entry.meta.deviceId ? ` (device ${entry.meta.deviceId})` : " (invite)"}`
      );
    })().catch((error) => {
      // Provider/bootstrap failure (e.g. node-datachannel missing). Fail loud
      // and drop the entry so status() doesn't advertise a ghost room.
      if (rooms.get(room) === entry) rooms.delete(room);
      log(`failed to arm room ${room}: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const disarmRoom = async (room: string): Promise<void> => {
    const entry = rooms.get(room);
    if (!entry) return;
    entry.disarmed = true;
    rooms.delete(room);
    await entry.ready.catch(() => undefined);
    if (entry.pipe) {
      await entry.pipe
        .close()
        .catch((error) =>
          log(
            `error closing pipe for room ${room}: ${error instanceof Error ? error.message : String(error)}`
          )
        );
    }
    log(`disarmed room ${room}`);
  };

  return {
    armRoom,
    disarmRoom,
    status: (): WebRtcRoomStatus[] =>
      [...rooms.values()].map((entry) => ({
        room: entry.room,
        // A room whose pipe is still being built reports "connecting".
        status: entry.pipe?.status() ?? "connecting",
        candidateType: entry.pipe?.candidateType() ?? null,
        ...(entry.meta.deviceId ? { deviceId: entry.meta.deviceId } : {}),
      })),
    stats: (): WebRtcIngressStats => ({ connects, relayConnects }),
    close: async (): Promise<void> => {
      closed = true;
      await Promise.all([...rooms.keys()].map((room) => disarmRoom(room)));
    },
  };
}
