/**
 * Server-side WebRTC answerer pipe — v2 redesign (plan §1 wire protocol,
 * §2.1–2.2 server). The complement of the offerer (`webrtcClient`): the home
 * server answers a paired device's offer and exposes the control/bulk channels
 * as the pipe surface `rpcServer.attachWebRtcPipe` demultiplexes into N
 * logical sessions.
 *
 * Shape of one pipe (§2.1):
 * - **Lazy peer.** `connect()` arms signaling only. The `RTCPeerConnection` is
 *   created on the first inbound offer, so N idle paired devices cost N
 *   websockets and zero native peers.
 * - **Supervised signaling rejoin.** One owned loop joins the room and rejoins
 *   after every drop with 1s·2ⁿ + jitter backoff (cap 30 s) — the exact
 *   `wsClient` policy. Same-role joins evict our own ghost server-side, so a
 *   rejoin always wins. A close that lands during a join attempt is observed
 *   by the post-attempt `onClosed` registration — never swallowed.
 * - **Hello preamble (§1.1).** The FIRST control message each direction is a
 *   `hello`; ours goes out directly on control-channel open (bypassing the
 *   scheduler). Effective chunk = min(both maxMsg, 256 KiB); effective
 *   keepalive = min of both ends' parameters. A session frame before the
 *   remote hello, a `proto !== 2`, or 10 s of hello silence drops the pipe.
 * - **Liveness (§2.2).** ICE `failed`/`closed` → down immediately; ICE
 *   `disconnected` → 20 s grace, cancelled when ICE returns to `connected`
 *   (instant-fatal `disconnected` was the split-brain bug —
 *   `webrtc-rpc-remediation-plan.md` #2). Both channels' `onClose`/`onError`
 *   → down. Inbound `ping` silence for 2× the negotiated timeout → down.
 * - **Schedulers (§1.3/§1.4).** Control frames fan out over per-lane FIFO
 *   queues, bulk frames over per-stream queues; both drain round-robin at
 *   message granularity through `frameScheduler` against a 256 KiB high-water.
 *   `ping` is answered with a direct `pong` that bypasses the queues.
 * - **On down:** notify, tear the peer down, reset codec/demux, settle queued
 *   scheduler work, and return to the lazy-armed state awaiting the next
 *   offer. Signaling stays joined (the rejoin loop guards it).
 *
 * The answerer does NOT fingerprint-pin: the pin is one-directional (the
 * CLIENT pins the SERVER's persistent DTLS cert via the QR `fp`). The server
 * presents that cert (`certificatePemFile`/`keyPemFile`) and authenticates
 * each principal per-session inside `attachWebRtcPipe`.
 *
 * Written against the platform-agnostic `webrtcPeer`/`webrtcSignaling`
 * interfaces, so it is unit-testable with an in-memory fabric and carries no
 * native dependency.
 */

import type { RpcConnectionStatus } from "../types.js";
import type {
  PeerConnectionProvider,
  RtcCandidateType,
  RtcConnectionState,
  RtcDataChannelLike,
  RtcIceCandidate,
  RtcPeerConnectionLike,
  RtcSessionDescription,
  WebRtcPairing,
} from "./webrtcPeer.js";
import type { SignalingClient } from "./webrtcSignaling.js";
import {
  BULK_CHANNEL_ID,
  BULK_LABEL,
  CONTROL_CHANNEL_ID,
  CONTROL_LABEL,
  DEFAULT_CHUNK_SIZE,
} from "./webrtcPeer.js";
import { createControlCodec } from "./controlFraming.js";
import { createFrameScheduler } from "./frameScheduler.js";
import {
  BULK_MUX_HEADER_BYTES,
  createBulkDemux,
  encodeBulkMessage,
  type StreamFrameType,
} from "../protocol/bulkMux.js";
import { FRAME_DATA, FRAME_END } from "../protocol/streamCodec.js";
import {
  SESSION_HELLO,
  SESSION_PING,
  SESSION_PONG,
  SESSION_PROTOCOL_VERSION,
  decodeControlFrame,
  encodeControlFrame,
  isSessionHello,
  type SessionHelloFrame,
} from "../protocol/sessionNegotiation.js";

export type { StreamFrameType } from "../protocol/bulkMux.js";

// --- Wire/liveness constants (§1.1, §2.2) -----------------------------------

/** Drain high-water for BOTH channels (§1.3/§1.4 — 256 KiB, symmetric). */
const BUFFER_HIGH_WATER = 256 * 1024;
/** Hard ceiling on the negotiated chunk size (§1.1). */
const MAX_CHUNK_SIZE = 256 * 1024;
/** Keepalive parameters this end advertises in its hello (§1.1). */
const LOCAL_KEEPALIVE = { intervalMs: 15_000, timeoutMs: 45_000 } as const;
/** The remote hello must arrive within this of control-channel open (§1.1). */
const HELLO_TIMEOUT_MS = 10_000;
/** ICE `disconnected` grace before teardown (§2.2 — split-brain fix). */
const ICE_DISCONNECTED_GRACE_MS = 20_000;
/** Signaling rejoin backoff — the exact `wsClient` policy. */
const REJOIN_BASE_DELAY_MS = 1_000;
const REJOIN_MAX_DELAY_MS = 30_000;
const REJOIN_JITTER_MS = 500;
/** Control frames at most this big are sniffed for pipe-level ping/pong. A
 * ping is ~30 bytes; session frames that small are decoded twice, harmlessly. */
const PING_SNIFF_MAX_BYTES = 512;
/** Session control bytes accepted after hello but before bulk opens. This window
 * should be tiny; the cap is a protocol tripwire against a peer flooding before
 * the pipe is usable. */
const PRE_PIPE_UP_CONTROL_CAP_BYTES = 4 * 1024 * 1024;
/** Default control lane for pipe-level writes that belong to no session. */
export const DEFAULT_CONTROL_LANE = "__pipe";

export interface WebRtcAnswererPipe {
  /**
   * Write a serialized control frame to the client. `lane` is the session sid
   * (default `"__pipe"`): per-lane FIFO order is preserved while the scheduler
   * round-robins across lanes at fragment granularity, so one session's huge
   * frame no longer stalls every other session. Resolves when this frame's
   * fragments have been sent (backpressure metering); settles silently when
   * the pipe is down (pipe-down is the failure signal, not per-write errors).
   */
  writeControl(data: Uint8Array, lane?: string): Promise<void>;
  /**
   * Write one bulk frame: mux-encoded (§1.2) and chunked under the negotiated
   * size — DATA payloads split into independent DATA messages, oversized
   * HEAD/ERROR JSON continues via MORE. Scheduled round-robin per stream.
   * Resolves when accepted under the queue caps AND sent.
   */
  writeBulkFrame(streamId: number, type: StreamFrameType, payload: Uint8Array): Promise<void>;
  /** Discard everything still queued for a cancelled stream. */
  dropBulkStream(streamId: number): void;
  /** Queued-but-unsent bulk bytes — total, or for one stream (metering). */
  bulkPendingBytes(streamId?: number): number;
  /** Un-drained control bytes (channel buffer + scheduler queues). */
  controlBufferedAmount(): number;
  /** Register the inbound control-frame handler. Frames arrive reassembled
   * and post-hello only; hello/ping/pong are handled inside the pipe. */
  onControl(handler: (data: Uint8Array) => void): void;
  /** Register the inbound bulk-frame handler (demuxed §1.2 frames). The
   * payload may be a view into the receive buffer — copy to retain. */
  onBulkFrame(
    handler: (streamId: number, type: StreamFrameType, payload: Uint8Array) => void
  ): void;
  /** Register a handler fired when the pipe is lost or closed. */
  onDown(handler: (reason: string) => void): () => void;
  /** Selected ICE candidate-pair type of the live peer — `'relay'` means TURN
   * engaged (the §9.8 relay alarm). Null when no peer is up. */
  candidateType(): RtcCandidateType | null;
  /** Candidate-type feed for the relay alarm (§9.8), mirroring the offerer's
   * `WebRtcTransport.onCandidateType`: fired with the selected type when the
   * pipe comes up (hello complete) and `null` when it goes down. */
  onCandidateType(handler: (type: RtcCandidateType | null) => void): () => void;
  /**
   * Arm signaling (lazy — no peer until the first offer) and wait. Resolves
   * when the hello exchange is complete AND both channels are open; rejects
   * only on `close()` (signaling failures retry forever under backoff).
   */
  connect(): Promise<void>;
  status(): RpcConnectionStatus;
  close(): Promise<void>;
}

type SignalingFactory = () => SignalingClient | Promise<SignalingClient>;

export interface WebRtcAnswererOptions {
  provider: PeerConnectionProvider;
  /**
   * Create a signaling client joined to this pipe's room with
   * `role: "answerer"`. Owned by the supervised rejoin loop: called once on
   * `connect()` and again after every signaling drop or failed attempt, under
   * 1s·2ⁿ + jitter backoff (cap 30 s).
   */
  createSignaling: SignalingFactory;
  pairing: Pick<WebRtcPairing, "iceServers" | "iceTransportPolicy"> & {
    certificatePemFile?: string;
    keyPemFile?: string;
  };
  logPrefix?: string;
}

interface ConnectWaiter {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

type AnyTimer = ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;

/** Timers must never hold the Node event loop open for an idle pipe. */
function unrefTimer(timer: AnyTimer): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}

export function createWebRtcAnswererPipe(options: WebRtcAnswererOptions): WebRtcAnswererPipe {
  const { provider, pairing, createSignaling } = options;
  const log = options.logPrefix ?? "[webrtc-answerer]";
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let closed = false;
  let status: RpcConnectionStatus = "disconnected";

  // --- signaling (owned by the rejoin loop) ---------------------------------
  let signaling: SignalingClient | null = null;
  let signalingLoopStarted = false;
  let rejoinTimer: ReturnType<typeof setTimeout> | null = null;
  /** Settles a parked backoff sleep so close() exits the loop immediately. */
  let wakeRejoin: (() => void) | null = null;

  // --- peer generation ------------------------------------------------------
  let peer: RtcPeerConnectionLike | null = null;
  let control: RtcDataChannelLike | null = null;
  let bulk: RtcDataChannelLike | null = null;
  const peerUnsubs: Array<() => void> = [];
  let peerHasRemote = false;
  let appliedRemoteOfferSdp: string | null = null;
  let controlOpen = false;
  let bulkOpen = false;

  // --- hello negotiation (§1.1) ---------------------------------------------
  let localMaxMsg = DEFAULT_CHUNK_SIZE;
  let localHelloSent = false;
  let remoteHello: SessionHelloFrame | null = null;
  let effectiveChunk = DEFAULT_CHUNK_SIZE;
  let keepaliveTimeoutMs: number = LOCAL_KEEPALIVE.timeoutMs;
  /** Hello exchange complete AND both channels open — the pipe is usable. */
  let pipeUp = false;
  let prePipeUpControlBytes = 0;
  const prePipeUpControlFrames: Uint8Array[] = [];

  // --- timers ---------------------------------------------------------------
  let helloTimer: ReturnType<typeof setTimeout> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let livenessTimer: ReturnType<typeof setInterval> | null = null;
  let lastPingAt = 0;

  // --- establish serialization + signaling buffers (§3.2 discipline) --------
  let establishInFlight: Promise<void> | null = null;
  const pendingDescriptions: RtcSessionDescription[] = [];
  const pendingCandidates: RtcIceCandidate[] = [];

  // --- codecs / handlers ----------------------------------------------------
  const controlCodec = createControlCodec();
  let controlHandler: ((data: Uint8Array) => void) | null = null;
  let bulkFrameHandler:
    | ((streamId: number, type: StreamFrameType, payload: Uint8Array) => void)
    | null = null;
  const demux = createBulkDemux((streamId, type, payload) => {
    bulkFrameHandler?.(streamId, type, payload);
  });
  const downHandlers = new Set<(reason: string) => void>();
  const candidateTypeListeners = new Set<(type: RtcCandidateType | null) => void>();
  /** Last value handed to the candidate-type feed — de-dupes re-emits so the
   * relay alarm only sees genuine transitions (§9.8, bug #4). `undefined` =
   * nothing emitted yet this pipe generation. */
  let lastCandidateType: RtcCandidateType | null | undefined = undefined;
  let connectWaiter: ConnectWaiter | null = null;

  // One scheduler per channel for the pipe's LIFETIME: `getChannel` gates on
  // `pipeUp`, so on down the pump settles everything queued (and writes issued
  // while down settle silently), while the next generation's enqueues send.
  const controlScheduler = createFrameScheduler({
    getChannel: () => (pipeUp ? control : null),
  });
  const bulkScheduler = createFrameScheduler({
    getChannel: () => (pipeUp ? bulk : null),
  });

  // ---------------------------------------------------------------------------
  // Signaling: supervised rejoin loop (§2.1)
  // ---------------------------------------------------------------------------

  function startSignalingLoop(): void {
    if (signalingLoopStarted || closed) return;
    signalingLoopStarted = true;
    void runSignalingLoop().catch((error) => {
      // The loop catches everything it expects; this is a genuine bug path.
      console.error(`${log} signaling supervisor crashed`, error);
    });
  }

  async function runSignalingLoop(): Promise<void> {
    let attempt = 0;
    while (!closed) {
      let client: SignalingClient | null = null;
      try {
        client = await createSignaling();
      } catch (error) {
        console.warn(`${log} signaling join failed`, error);
      }
      if (closed) {
        try {
          client?.close();
        } catch {
          /* ignore */
        }
        return;
      }
      if (client) {
        signaling = client;
        appliedRemoteOfferSdp = null;
        // Reset backoff ONLY when the join proves LIVE — an `onOpen` (the WS
        // actually upgraded) or the first inbound description/candidate (the
        // peer reached us through the room). NEVER on mere construction:
        // `createSignalingClient` builds the socket eagerly and never throws
        // for an unreachable host (failures surface async via `onClosed`), so
        // resetting on the returned object made an unreachable worker get
        // hammered ~1 socket/sec/room forever with no backoff growth (bug #1).
        // Resolves when THIS client closes. onClosed fires immediately for a
        // close that already landed (during the join attempt) — re-checked
        // here, never swallowed.
        const reason = await watchSignaling(client, () => {
          attempt = 0;
        });
        if (signaling === client) signaling = null;
        if (closed) return;
        console.warn(`${log} signaling closed (${reason ?? "?"}); rejoining`);
      }
      const delay = Math.min(
        REJOIN_BASE_DELAY_MS * 2 ** attempt + Math.random() * REJOIN_JITTER_MS,
        REJOIN_MAX_DELAY_MS
      );
      attempt += 1;
      await rejoinSleep(delay);
    }
  }

  /**
   * Register the transport handlers on a joined client; resolve on its close.
   * `onProvenLive` fires exactly once, the first time the join is proven live
   * (WS open, or an inbound description/candidate), so the supervisor resets
   * its rejoin backoff only for a genuinely-reachable room (bug #1).
   */
  function watchSignaling(
    client: SignalingClient,
    onProvenLive: () => void
  ): Promise<string | undefined> {
    return new Promise((resolve) => {
      let done = false;
      let liveMarked = false;
      const offs: Array<() => void> = [];
      const markLive = (): void => {
        if (liveMarked) return;
        liveMarked = true;
        onProvenLive();
      };
      const finish = (reason?: string): void => {
        if (done) return;
        done = true;
        for (const off of offs) {
          try {
            off();
          } catch {
            /* ignore */
          }
        }
        resolve(reason);
      };
      offs.push(
        client.onDescription((desc) => {
          markLive();
          onSignalDescription(desc);
        }),
        client.onCandidate((cand) => {
          markLive();
          onSignalCandidate(cand);
        }),
        client.onClosed((reason) => finish(reason ?? "signaling closed"))
      );
      // Prefer the explicit open seam when the client exposes it (the real
      // `createSignalingClient` does); fakes/adapters without it fall back to
      // the first inbound frame above.
      if (client.onOpen) offs.push(client.onOpen(() => markLive()));
    });
  }

  function rejoinSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        if (rejoinTimer !== null) {
          clearTimeout(rejoinTimer);
          rejoinTimer = null;
        }
        wakeRejoin = null;
        resolve();
      };
      wakeRejoin = done;
      rejoinTimer = setTimeout(done, ms);
      unrefTimer(rejoinTimer);
    });
  }

  // ---------------------------------------------------------------------------
  // Descriptions & candidates: serialized, offer-driven establish (§2.1, §3.2)
  // ---------------------------------------------------------------------------

  function onSignalDescription(desc: RtcSessionDescription): void {
    if (closed) return;
    pendingDescriptions.push(desc);
    pumpDescriptions();
  }

  function onSignalCandidate(cand: RtcIceCandidate): void {
    if (closed) return;
    const pc = peer;
    // Buffer until a remote description has been applied to the CURRENT peer
    // and no newer description is queued or being applied: a candidate that
    // follows a queued offer belongs to that offer's generation and must land
    // AFTER it (the old flow applied queued candidates before the triggering
    // offer — the re-pair ordering inversion).
    if (!pc || !peerHasRemote || establishInFlight !== null || pendingDescriptions.length > 0) {
      pendingCandidates.push(cand);
      return;
    }
    void pc.addRemoteCandidate(cand).catch((e) => console.warn(`${log} addRemoteCandidate`, e));
  }

  function flushCandidates(): void {
    const pc = peer;
    if (!pc || !peerHasRemote) return;
    for (const cand of pendingCandidates.splice(0)) {
      // A stale candidate from a torn-down generation fails here — warned,
      // never masked, never applied out of order.
      void pc.addRemoteCandidate(cand).catch((e) => console.warn(`${log} addRemoteCandidate`, e));
    }
  }

  /** One in-flight establish, always; new descriptions queue behind it. */
  function pumpDescriptions(): void {
    if (closed || establishInFlight !== null || pendingDescriptions.length === 0) return;
    establishInFlight = processDescriptions()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        pipeDown(`establish failed: ${message}`);
      })
      .finally(() => {
        establishInFlight = null;
        if (closed) return;
        if (pendingDescriptions.length > 0) {
          pumpDescriptions();
          return;
        }
        // Candidates that arrived while the establish was in flight.
        flushCandidates();
      });
  }

  async function processDescriptions(): Promise<void> {
    while (!closed && pendingDescriptions.length > 0) {
      const desc = pendingDescriptions.shift()!;
      if (desc.type === "answer") {
        // The offerer speaks first; the answerer never receives an answer.
        console.warn(`${log} dropping unexpected remote answer`);
        continue;
      }
      // The offerer deliberately re-sends its current offer when it observes a
      // peer-joined event. That lifecycle hint can race the original relay, so
      // receiving the exact same SDP twice is normal and must be idempotent.
      // A genuinely new SDP still takes the re-pair path below.
      if (peer && peerHasRemote && desc.sdp === appliedRemoteOfferSdp) {
        console.log(`${log} duplicate offer — keeping current peer`);
        continue;
      }
      if (peer && peerHasRemote) {
        // Re-pair: the same device re-established (new PeerConnection + DTLS).
        // A second offer cannot apply to a used peer — tear down and re-answer.
        // Candidates that arrived after this offer stay buffered and flush
        // only after the new description is applied.
        console.warn(`${log} re-pairing: new offer on a used peer — resetting`);
        pipeDown("re-pairing offer");
      }
      if (!peer) {
        // Recovery-path visibility (§9.8): together with the "re-pairing" warn
        // above and the rejoin loop's "signaling closed … rejoining", every
        // (re-)establish names the path that fired it.
        console.log(`${log} inbound offer — establishing peer`);
        await establishPeer();
      }
      const pc = peer;
      if (!pc) return; // closed under us
      await pc.setRemoteDescription(desc);
      if (peer !== pc || closed) return;
      peerHasRemote = true;
      appliedRemoteOfferSdp = desc.sdp;
      flushCandidates();
      const answer = await pc.createAnswer();
      if (peer !== pc || closed) return;
      await pc.setLocalDescription(answer);
    }
  }

  /** Create the lazy peer + pre-negotiated channels for an inbound offer. */
  async function establishPeer(): Promise<void> {
    status = "connecting";
    const client = signaling;
    const iceServers = client?.fetchIceServers
      ? await client.fetchIceServers()
      : (pairing.iceServers ?? []);
    const pc = await provider.create({
      iceServers,
      iceTransportPolicy: pairing.iceTransportPolicy,
      certificatePemFile: pairing.certificatePemFile,
      keyPemFile: pairing.keyPemFile,
    });
    if (closed) {
      try {
        pc.close();
      } catch {
        /* ignore */
      }
      throw new Error("Answerer pipe closed");
    }
    peer = pc;
    peerHasRemote = false;
    appliedRemoteOfferSdp = null;
    // Pre-negotiated channels with the SAME ids the offerer opens.
    const ctl = pc.createDataChannel(CONTROL_LABEL, {
      ordered: true,
      negotiated: true,
      id: CONTROL_CHANNEL_ID,
    });
    const blk = pc.createDataChannel(BULK_LABEL, {
      ordered: true,
      negotiated: true,
      id: BULK_CHANNEL_ID,
    });
    control = ctl;
    bulk = blk;
    ctl.bufferedAmountLowThreshold = BUFFER_HIGH_WATER;
    blk.bufferedAmountLowThreshold = BUFFER_HIGH_WATER;

    let pendingLocalDescription: { type: "offer" | "answer"; sdp: string } | null = null;
    let localDescriptionSent = false;
    const sendLocalDescription = (
      desc: { type: "offer" | "answer"; sdp: string },
      candidate?: { candidate: string; sdpMid?: string | null }
    ): void => {
      if (localDescriptionSent || peer !== pc || closed) return;
      localDescriptionSent = true;
      const current = signaling;
      if (!current) return;
      let outbound = desc;
      if (candidate) {
        const lines = desc.sdp.trimEnd().split(/\r?\n/);
        const candidateLine = candidate.candidate.startsWith("a=")
          ? candidate.candidate
          : `a=${candidate.candidate}`;
        const midIndex = candidate.sdpMid
          ? lines.findIndex((line) => line === `a=mid:${candidate.sdpMid}`)
          : -1;
        const mediaIndex = lines.findIndex((line) => line.startsWith("m="));
        const insertAfter = midIndex >= 0 ? midIndex : mediaIndex;
        lines.splice(insertAfter >= 0 ? insertAfter + 1 : lines.length, 0, candidateLine);
        outbound = { ...desc, sdp: `${lines.join("\r\n")}\r\n` };
      }
      void current
        .sendDescription(outbound)
        .catch((e) => console.warn(`${log} sendDescription`, e));
    };

    peerUnsubs.push(
      ctl.onOpen(() => onControlChannelOpen()),
      ctl.onClose(() => pipeDown("control channel closed")),
      ctl.onError((error) => pipeDown(`control channel error: ${error.message}`)),
      ctl.onMessage((data) => handleControlMessage(data)),
      blk.onOpen(() => {
        bulkOpen = true;
        maybePipeUp();
      }),
      blk.onClose(() => pipeDown("bulk channel closed")),
      blk.onError((error) => pipeDown(`bulk channel error: ${error.message}`)),
      blk.onMessage((data) => handleBulkMessage(data)),
      pc.onConnectionStateChange((state) => onConnectionState(state)),
      pc.onLocalDescription((desc) => {
        pendingLocalDescription = desc;
        // Publish the answer immediately. Candidates trickle independently;
        // holding SDP here consumes the transport hello deadline and can make a
        // healthy mobile peer look unreachable on slower networks.
        sendLocalDescription(desc);
      }),
      pc.onLocalCandidate((cand) => {
        if (pendingLocalDescription && !localDescriptionSent) {
          sendLocalDescription(pendingLocalDescription, cand);
          return;
        }
        const current = signaling;
        if (!current) return;
        void current.sendCandidate(cand).catch((e) => console.warn(`${log} sendCandidate`, e));
      })
    );
    // Re-emit the candidate type whenever the selected pair changes: the
    // one-shot read at pipe-up (§9.8) misses a still-null nomination and every
    // later switch to relay (a NAT rebind / TURN cred refresh). De-duped by
    // emitCandidateType, and gated on the live peer + pipeUp (bug #4).
    if (pc.onSelectedCandidateChange) {
      peerUnsubs.push(
        pc.onSelectedCandidateChange((type) => {
          if (peer !== pc || closed || !pipeUp) return;
          emitCandidateType(type);
        })
      );
    }
    // Some adapters open negotiated channels synchronously.
    if (ctl.readyState === "open") onControlChannelOpen();
    if (blk.readyState === "open") {
      bulkOpen = true;
      maybePipeUp();
    }
  }

  // ---------------------------------------------------------------------------
  // Hello preamble (§1.1)
  // ---------------------------------------------------------------------------

  function onControlChannelOpen(): void {
    if (controlOpen) return; // idempotent (adapter races)
    const channel = control;
    if (!channel) return;
    controlOpen = true;
    localMaxMsg = channel.maxMessageSize || DEFAULT_CHUNK_SIZE;
    const hello: SessionHelloFrame = {
      t: SESSION_HELLO,
      proto: SESSION_PROTOCOL_VERSION,
      maxMsg: localMaxMsg,
      platform: "server",
      keepalive: { ...LOCAL_KEEPALIVE },
    };
    // DIRECT send — the hello must be the FIRST control message and cannot sit
    // behind the scheduler (which only opens once the pipe is up). A hello is
    // tiny, so this is one whole-tagged codec message.
    const parts = controlCodec.frame(encoder.encode(encodeControlFrame(hello)), localMaxMsg);
    try {
      for (const part of parts) channel.send(part);
    } catch (error) {
      pipeDown(`hello send failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    localHelloSent = true;
    armHelloTimeout();
    maybePipeUp();
  }

  function armHelloTimeout(): void {
    clearHelloTimeout();
    helloTimer = setTimeout(() => {
      helloTimer = null;
      if (!remoteHello) {
        pipeDown(`hello timeout (no remote hello within ${HELLO_TIMEOUT_MS}ms)`);
      }
    }, HELLO_TIMEOUT_MS);
    unrefTimer(helloTimer);
  }

  function clearHelloTimeout(): void {
    if (helloTimer !== null) {
      clearTimeout(helloTimer);
      helloTimer = null;
    }
  }

  function handleRemoteHello(frameBytes: Uint8Array): void {
    let frame;
    try {
      frame = decodeControlFrame(decoder.decode(frameBytes));
    } catch (error) {
      pipeDown(
        `malformed first control frame: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    if (!isSessionHello(frame)) {
      // Any session frame before the hello is a protocol violation (§1.1).
      pipeDown(`protocol violation: '${frame.t}' frame before hello`);
      return;
    }
    if (frame.proto !== SESSION_PROTOCOL_VERSION) {
      pipeDown(`protocol violation: hello proto ${frame.proto} (want ${SESSION_PROTOCOL_VERSION})`);
      return;
    }
    if (!Number.isFinite(frame.maxMsg) || frame.maxMsg <= 0) {
      pipeDown(`protocol violation: hello maxMsg ${frame.maxMsg}`);
      return;
    }
    remoteHello = frame;
    clearHelloTimeout();
    maybePipeUp();
  }

  /** Relay-alarm feed (§9.8), mirroring the offerer's `emitCandidateType`.
   * De-duped: a repeated value (e.g. a re-emit of the same pair after a state
   * blip) is suppressed so listeners only observe genuine transitions. */
  function emitCandidateType(type: RtcCandidateType | null): void {
    if (type === lastCandidateType) return;
    lastCandidateType = type;
    for (const listener of [...candidateTypeListeners]) {
      try {
        listener(type);
      } catch (error) {
        console.warn(`${log} candidate-type listener threw`, error);
      }
    }
  }

  function maybePipeUp(): void {
    if (pipeUp || closed) return;
    if (!remoteHello || !localHelloSent || !controlOpen || !bulkOpen) return;
    effectiveChunk = Math.min(localMaxMsg, remoteHello.maxMsg, MAX_CHUNK_SIZE);
    keepaliveTimeoutMs = Math.min(
      LOCAL_KEEPALIVE.timeoutMs,
      remoteHello.keepalive?.timeoutMs ?? Number.POSITIVE_INFINITY
    );
    pipeUp = true;
    status = "connected";
    lastPingAt = Date.now();
    startLivenessTimer();
    connectWaiter?.resolve();
    connectWaiter = null;
    console.log(
      `${log} pipe up (chunk=${effectiveChunk}B keepaliveTimeout=${keepaliveTimeoutMs}ms platform=${remoteHello.platform ?? "?"})`
    );
    emitCandidateType(peer?.selectedCandidateType() ?? null);
    flushPrePipeUpControlFrames();
  }

  // ---------------------------------------------------------------------------
  // Liveness (§2.2)
  // ---------------------------------------------------------------------------

  function startLivenessTimer(): void {
    stopLivenessTimer();
    const deadlineMs = 2 * keepaliveTimeoutMs;
    if (!Number.isFinite(deadlineMs)) return;
    const cadence = Math.max(1, Math.floor(keepaliveTimeoutMs / 2));
    livenessTimer = setInterval(() => {
      if (!pipeUp) return;
      if (Date.now() - lastPingAt > deadlineMs) pipeDown("client keepalive lost");
    }, cadence);
    unrefTimer(livenessTimer);
  }

  function stopLivenessTimer(): void {
    if (livenessTimer !== null) {
      clearInterval(livenessTimer);
      livenessTimer = null;
    }
  }

  function onConnectionState(state: RtcConnectionState): void {
    if (closed) return;
    switch (state) {
      case "connected":
        // ICE recovered within the grace window — cancel the pending teardown
        // (sessions survive; the instant-fatal path was the split-brain bug).
        clearGraceTimer();
        return;
      case "disconnected":
        armGraceTimer();
        return;
      case "failed":
        pipeDown("ICE failed");
        return;
      case "closed":
        pipeDown("ICE closed");
        return;
      default:
        return;
    }
  }

  function armGraceTimer(): void {
    if (graceTimer !== null) return;
    console.warn(`${log} ICE disconnected — ${ICE_DISCONNECTED_GRACE_MS}ms grace before teardown`);
    graceTimer = setTimeout(() => {
      graceTimer = null;
      pipeDown("ICE disconnected (grace elapsed)");
    }, ICE_DISCONNECTED_GRACE_MS);
    unrefTimer(graceTimer);
  }

  function clearGraceTimer(): void {
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Inbound frames
  // ---------------------------------------------------------------------------

  function handleControlMessage(message: Uint8Array): void {
    let full: Uint8Array | null;
    try {
      full = controlCodec.accept(message);
    } catch (error) {
      // ControlProtocolViolation (defrag budget breach) — fail loud (§2.5).
      pipeDown(
        `control protocol violation: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    if (!full) return;
    if (!remoteHello) {
      handleRemoteHello(full);
      return;
    }
    // A duplicate hello must fail LOUD regardless of size (bug #11): the ≤512B
    // ping/pong sniff below would let a padded (>512B) duplicate hello slip
    // silently to the session demux. The tag peek is cheap and size-independent
    // — our encoder always writes `t` first, so a conforming peer's hello is
    // caught no matter how large.
    if (peekControlTag(full) === SESSION_HELLO) {
      pipeDown("protocol violation: duplicate hello");
      return;
    }
    if (full.byteLength <= PING_SNIFF_MAX_BYTES && consumePipeFrame(full)) return;
    if (!pipeUp) {
      prePipeUpControlBytes += full.byteLength;
      if (prePipeUpControlBytes > PRE_PIPE_UP_CONTROL_CAP_BYTES) {
        pipeDown(`pre-pipe-up control backlog exceeded ${PRE_PIPE_UP_CONTROL_CAP_BYTES} bytes`);
        return;
      }
      prePipeUpControlFrames.push(full.slice());
      return;
    }
    controlHandler?.(full);
  }

  function flushPrePipeUpControlFrames(): void {
    if (prePipeUpControlFrames.length === 0) return;
    const frames = prePipeUpControlFrames.splice(0);
    prePipeUpControlBytes = 0;
    for (const frame of frames) {
      if (closed || !pipeUp) return;
      controlHandler?.(frame);
    }
  }

  /** Cheaply read a control frame's `t` tag without a full JSON parse — our
   * encoder (`JSON.stringify`) always writes `t` first, so this matches the
   * leading `{"t":"<tag>"` regardless of the frame's total size. Used for the
   * size-independent duplicate-hello guard (bug #11). Returns null if the
   * prefix doesn't look like a tagged control frame. */
  function peekControlTag(frameBytes: Uint8Array): string | null {
    // A hello is tiny; decode only the prefix needed to see the tag.
    const prefix = decoder.decode(frameBytes.subarray(0, Math.min(frameBytes.byteLength, 64)));
    const match = prefix.match(/^\s*\{\s*"t"\s*:\s*"([^"]+)"/);
    return match?.[1] ?? null;
  }

  /** Handle pipe-level ping/pong inside the pipe; true = consumed. (A duplicate
   * hello is caught size-independently before this runs — see handleControlMessage.) */
  function consumePipeFrame(frameBytes: Uint8Array): boolean {
    let parsed: { t?: unknown; ts?: unknown };
    try {
      parsed = JSON.parse(decoder.decode(frameBytes)) as { t?: unknown; ts?: unknown };
    } catch {
      // Control frames are whole JSON documents; a non-JSON frame is corrupt.
      pipeDown("malformed control frame");
      return true;
    }
    if (parsed?.t === SESSION_PING) {
      lastPingAt = Date.now();
      sendPongDirect(typeof parsed.ts === "number" ? parsed.ts : Date.now());
      return true;
    }
    if (parsed?.t === SESSION_PONG) return true; // we never ping — ignore strays
    return false;
  }

  /** Answer a ping DIRECTLY — bypassing the scheduler, so a saturated link can
   * never starve its own keepalive into a spurious teardown (§1.4). A direct
   * whole-tagged message between fragment sets is protocol-safe. */
  function sendPongDirect(ts: number): void {
    const channel = control;
    if (!channel || channel.readyState !== "open") return;
    const parts = controlCodec.frame(
      encoder.encode(encodeControlFrame({ t: SESSION_PONG, ts })),
      effectiveChunk
    );
    try {
      for (const part of parts) channel.send(part);
    } catch (error) {
      pipeDown(`pong send failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function handleBulkMessage(message: Uint8Array): void {
    if (!remoteHello) {
      pipeDown("protocol violation: bulk message before hello");
      return;
    }
    try {
      demux.push(message);
    } catch (error) {
      // BulkProtocolViolation — a peer speaking a different dialect fails
      // loud instead of corrupting streams silently (§1.2).
      pipeDown(
        `bulk protocol violation: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Outbound encoding
  // ---------------------------------------------------------------------------

  /** Encode one logical bulk frame into ≤effectiveChunk mux messages (§1.2). */
  function encodeBulkFrameParts(
    streamId: number,
    type: StreamFrameType,
    payload: Uint8Array
  ): Uint8Array[] {
    const budget = Math.max(1, effectiveChunk - BULK_MUX_HEADER_BYTES);
    if (payload.byteLength <= budget) {
      return [encodeBulkMessage(streamId, type, payload)];
    }
    if (type === FRAME_DATA) {
      // DATA has no wire-level frame: each message's bytes simply append to
      // the stream, so an oversized payload becomes independent DATA messages.
      const parts: Uint8Array[] = [];
      for (let offset = 0; offset < payload.byteLength; offset += budget) {
        parts.push(
          encodeBulkMessage(
            streamId,
            type,
            payload.subarray(offset, Math.min(offset + budget, payload.byteLength))
          )
        );
      }
      return parts;
    }
    if (type === FRAME_END) {
      // END carries a tiny JSON payload and cannot continue (MORE is invalid
      // on END) — an oversized one is a programming error, not a wire state.
      throw new Error(
        `END payload (${payload.byteLength}B) exceeds the negotiated chunk (${budget}B)`
      );
    }
    // Oversized HEAD/ERROR JSON continues via MORE messages (§1.2).
    const parts: Uint8Array[] = [];
    for (let offset = 0; offset < payload.byteLength; offset += budget) {
      const end = Math.min(offset + budget, payload.byteLength);
      parts.push(
        encodeBulkMessage(streamId, type, payload.subarray(offset, end), end < payload.byteLength)
      );
    }
    return parts;
  }

  // ---------------------------------------------------------------------------
  // Down / teardown
  // ---------------------------------------------------------------------------

  function notifyDown(reason: string): void {
    for (const handler of [...downHandlers]) {
      try {
        handler(reason);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * The single down path: tear the peer down, settle queued work, notify, and
   * return to the lazy-armed state awaiting the next offer. Signaling stays
   * joined (the rejoin loop guards it); connect() waiters keep waiting.
   */
  function pipeDown(reason: string): void {
    if (closed) return;
    if (!peer && status === "disconnected") return; // nothing up, nothing to drop
    // A DataChannel close is a transport lifecycle transition, not evidence of
    // a fault: short-lived CLI clients intentionally close it after their RPC
    // batch. Errors, protocol violations, liveness loss, and failed ICE remain
    // warnings. Down handlers still receive every reason in either case.
    const report = reason.endsWith("channel closed") ? console.log : console.warn;
    report(`${log} pipe down: ${reason}`);
    teardownPeer();
    status = "disconnected";
    notifyDown(reason);
    emitCandidateType(null);
  }

  function teardownPeer(): void {
    clearHelloTimeout();
    clearGraceTimer();
    stopLivenessTimer();
    pipeUp = false; // schedulers' getChannel now yields null → queued work settles
    // A fresh pipe must never reassemble against a dead pipe's fragments or
    // continue a dead pipe's partial HEAD/ERROR accumulations.
    controlCodec.reset();
    demux.reset();
    prePipeUpControlFrames.length = 0;
    prePipeUpControlBytes = 0;
    remoteHello = null;
    localHelloSent = false;
    controlOpen = false;
    bulkOpen = false;
    peerHasRemote = false;
    appliedRemoteOfferSdp = null;
    effectiveChunk = DEFAULT_CHUNK_SIZE;
    localMaxMsg = DEFAULT_CHUNK_SIZE;
    // Unsubscribe BEFORE closing so the close/error handlers don't re-enter.
    for (const off of peerUnsubs.splice(0)) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    try {
      control?.close();
    } catch {
      /* ignore */
    }
    try {
      bulk?.close();
    } catch {
      /* ignore */
    }
    try {
      peer?.close();
    } catch {
      /* ignore */
    }
    control = null;
    bulk = null;
    peer = null;
  }

  // ---------------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------------

  return {
    async writeControl(data: Uint8Array, lane: string = DEFAULT_CONTROL_LANE): Promise<void> {
      const parts = controlCodec.frame(data, effectiveChunk);
      // Outcome discarded: the answerer's failure signal is session/pipe
      // teardown, not per-write results (settle-never-rejects).
      await controlScheduler.enqueue(lane, parts);
    },

    async writeBulkFrame(
      streamId: number,
      type: StreamFrameType,
      payload: Uint8Array
    ): Promise<void> {
      await bulkScheduler.enqueue(streamId, encodeBulkFrameParts(streamId, type, payload));
    },

    dropBulkStream(streamId: number): void {
      bulkScheduler.dropKey(streamId);
    },

    bulkPendingBytes(streamId?: number): number {
      return bulkScheduler.pendingBytes(streamId);
    },

    controlBufferedAmount(): number {
      return (control?.bufferedAmount ?? 0) + controlScheduler.pendingBytes();
    },

    onControl(handler: (data: Uint8Array) => void): void {
      controlHandler = handler;
    },

    onBulkFrame(
      handler: (streamId: number, type: StreamFrameType, payload: Uint8Array) => void
    ): void {
      bulkFrameHandler = handler;
    },

    onDown(handler: (reason: string) => void): () => void {
      downHandlers.add(handler);
      return () => downHandlers.delete(handler);
    },

    candidateType(): RtcCandidateType | null {
      return peer?.selectedCandidateType() ?? null;
    },

    onCandidateType(handler: (type: RtcCandidateType | null) => void): () => void {
      candidateTypeListeners.add(handler);
      return () => candidateTypeListeners.delete(handler);
    },

    async connect(): Promise<void> {
      if (closed) throw new Error("Answerer pipe closed");
      startSignalingLoop();
      if (pipeUp) return;
      if (!connectWaiter) {
        let resolve!: () => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<void>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        // Mark handled so a close() with no awaiting caller never surfaces an
        // unhandled rejection; real awaiters still observe the rejection.
        void promise.catch(() => {});
        connectWaiter = { promise, resolve, reject };
      }
      return connectWaiter.promise;
    },

    status(): RpcConnectionStatus {
      return status;
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      teardownPeer();
      status = "disconnected";
      notifyDown("answerer pipe closed");
      emitCandidateType(null);
      connectWaiter?.reject(new Error("Answerer pipe closed"));
      connectWaiter = null;
      // Stop the rejoin loop: settle a parked backoff sleep and close the
      // joined client (its onClosed resolves the loop's watch).
      if (rejoinTimer !== null) {
        clearTimeout(rejoinTimer);
        rejoinTimer = null;
      }
      wakeRejoin?.();
      const client = signaling;
      signaling = null;
      try {
        client?.close();
      } catch {
        /* ignore */
      }
      controlScheduler.close();
      bulkScheduler.close();
      pendingDescriptions.length = 0;
      pendingCandidates.length = 0;
    },
  };
}
