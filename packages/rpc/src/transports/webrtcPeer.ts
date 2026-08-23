/**
 * Platform-agnostic WebRTC primitives — the seam between the transport logic
 * (workstream A, `webrtcClient.ts`) and the native stacks (workstream C):
 * `node-datachannel`/libdatachannel on desktop+server, `react-native-webrtc`
 * on mobile. The transport codes ONLY against these interfaces, so it is fully
 * unit-testable with fakes and never imports a native module.
 *
 * The shapes mirror `node-datachannel` (callback-registration style:
 * `.onMessage(cb)`, `.onLocalDescription(cb)`, `.onLocalCandidate(cb)`,
 * `.onStateChange(cb)`) more closely than the WHATWG `onmessage =` setters,
 * because callback registration composes and the native adapter is a thin map.
 * The `react-native-webrtc` adapter wraps WHATWG events into the same shape.
 */

import type { SignalingClient } from "./webrtcSignaling.js";

export type { SignalingClient } from "./webrtcSignaling.js";

/** ICE candidate-pair type — the fail-loud relay alarm reads this (plan §6/§12). */
export type RtcCandidateType = "host" | "srflx" | "prflx" | "relay";

export type RtcConnectionState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

export type RtcDataChannelState = "connecting" | "open" | "closing" | "closed";

/**
 * Flow-control policy for the three channels sharing one SCTP association.
 *
 * Control frames are small and latency-sensitive. Interactive and bulk streams
 * use smaller adaptive native send windows; the association scheduler keeps
 * their admission and arbitration unified. Separate data channels do not imply
 * separate congestion control, so an unconstrained artifact burst could still
 * hold session opens, events, and RPC responses behind asset bytes.
 */
export const CONTROL_BUFFER_LOW_THRESHOLD = 256 * 1024;
export const INTERACTIVE_BUFFER_LOW_THRESHOLD = 64 * 1024;
export const BULK_BUFFER_LOW_THRESHOLD = 64 * 1024;
export const MAX_ASSOCIATION_STREAM_WINDOW = 512 * 1024;
export const MAX_BULK_MESSAGE_SIZE = 16 * 1024;

export interface RtcSessionDescription {
  type: "offer" | "answer";
  sdp: string;
}

export interface RtcIceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

export interface RtcIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * One reliable/ordered SCTP data channel. The transport opens three: `control`
 * (envelopes and handshake), `interactive` (subscriptions and ordinary stream
 * bodies), and `bulk` (artifacts/uploads).
 */
export interface RtcDataChannelLike {
  readonly label: string;
  readonly readyState: RtcDataChannelState;
  /**
   * Bytes handed to `send` that have not reached the wire, INCLUDING the write
   * that just returned. The frame scheduler's only backpressure signal: an
   * implementation that reports zero for bytes it is still holding tells the
   * pump there is room, and the pump keeps writing until something else breaks.
   * An adapter whose platform reports this asynchronously must count its own
   * sends and reconcile when the platform's number arrives, rather than
   * publishing a stale figure.
   */
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  /** Measured SCTP max message size (libdatachannel reports 256 KB — plan §11). */
  readonly maxMessageSize: number;
  /**
   * Maximum sender-side buffered window this receiver's native bridge can
   * safely absorb for streaming channels. Zero means one message at a time.
   */
  readonly safeReceiveWindowBytes?: number;
  send(data: Uint8Array): void;
  close(): void;
  onOpen(handler: () => void): () => void;
  onClose(handler: () => void): () => void;
  onError(handler: (error: Error) => void): () => void;
  onMessage(handler: (data: Uint8Array) => void): () => void;
  /**
   * Fire when `bufferedAmount <= bufferedAmountLowThreshold`, matching both the
   * W3C condition ("to or below") and `awaitDrain`, which parks on exactly that
   * predicate. The comparison must not be strict: a threshold of zero is legal
   * and means "wait until empty", so `bufferedAmount < 0` would make the event
   * unsatisfiable and park every writer forever.
   *
   * The event is an edge with no replay. A subscriber that samples the level
   * before subscribing must re-read it after (see `awaitDrain`), because the
   * edge it is waiting for may already have passed.
   */
  onBufferedAmountLow(handler: () => void): () => void;
}

export interface RtcDataChannelInit {
  ordered?: boolean;
  /** Pre-negotiated channel id so both peers open matching channels. */
  negotiated?: boolean;
  id?: number;
}

export interface RtcPeerConnectionLike {
  createDataChannel(label: string, init?: RtcDataChannelInit): RtcDataChannelLike;
  createOffer(): Promise<RtcSessionDescription>;
  createAnswer(): Promise<RtcSessionDescription>;
  setLocalDescription(desc?: RtcSessionDescription): Promise<void>;
  setRemoteDescription(desc: RtcSessionDescription): Promise<void>;
  addRemoteCandidate(candidate: RtcIceCandidate): Promise<void>;
  /**
   * DTLS SHA-256 fingerprint of the *remote* peer's certificate, observed on the
   * live wire — the value compared against the QR pin (`fp`). Null until DTLS is
   * established. Proven pinnable end-to-end in the §11 spike.
   */
  remoteFingerprint(): string | null;
  /** Selected ICE candidate-pair type — surfaced so over-relaying is loud (§12). */
  selectedCandidateType(): RtcCandidateType | null;
  /**
   * Fired whenever the selected ICE candidate PAIR changes — i.e. the value
   * `selectedCandidateType()` returns transitions (null → host/srflx/relay on
   * nomination, or a mid-connection switch e.g. host → relay after a NAT
   * rebind). The relay alarm (§9.8) depends on this: emitting the candidate
   * type ONCE at hello-complete misses a still-null nomination and every later
   * switch to relay. Optional — native adapters that cannot observe pair
   * changes omit it, and the transport falls back to the one-shot read.
   */
  onSelectedCandidateChange?(handler: (type: RtcCandidateType | null) => void): () => void;
  readonly connectionState: RtcConnectionState;
  onConnectionStateChange(handler: (state: RtcConnectionState) => void): () => void;
  /** A local SDP (offer/answer) is ready to send to the peer via signaling. */
  onLocalDescription(handler: (desc: RtcSessionDescription) => void): () => void;
  /** A local ICE candidate is ready to send to the peer via signaling. */
  onLocalCandidate(handler: (candidate: RtcIceCandidate) => void): () => void;
  close(): void;
}

export interface RtcPeerConfig {
  iceServers: RtcIceServer[];
  /** Force `relay` to validate TURN-over-TLS:443 reachability (plan §2). */
  iceTransportPolicy?: "all" | "relay";
  /**
   * Persistent DTLS cert (SERVER side) so the fingerprint is stable across
   * restarts → the QR pin keeps verifying. Loaded from
   * `certificatePemFile`/`keyPemFile` (plan §6.1, §11).
   */
  certificatePemFile?: string;
  keyPemFile?: string;
}

/**
 * Workstream C provides this. `create` returns a fresh peer; the transport owns
 * its lifecycle. The provider also exports the LOCAL fingerprint so the server
 * can publish it (QR) and the client can pin it.
 */
export interface PeerConnectionProvider {
  create(config: RtcPeerConfig): RtcPeerConnectionLike | Promise<RtcPeerConnectionLike>;
  /** Local cert's DTLS SHA-256 — computed offline from the PEM (no live peer needed). */
  localFingerprint?(
    config: Pick<RtcPeerConfig, "certificatePemFile" | "keyPemFile">
  ): string | null;
}

export interface WebRtcPairing {
  /** Signaling rendezvous room id (unguessable UUID). */
  room: string;
  /** Pinned remote DTLS SHA-256 (QR `fp`); the transport accepts iff observed === this. */
  fingerprint: string;
  /** Pairing secret proving the QR holder. */
  code?: string;
  /** Protocol version negotiated via the link `v`. */
  version?: number;
  /** TURN policy from the link `ice` (e.g. force relay). */
  iceTransportPolicy?: "all" | "relay";
  /** Static ICE servers if not minted per-session by signaling. */
  iceServers?: RtcIceServer[];
}

export interface SignalingClientFactory {
  (room: string): SignalingClient | Promise<SignalingClient>;
}

/**
 * Extract the `sha-256` DTLS fingerprint (uppercase colon-hex) from an SDP blob.
 *
 * This is the fail-closed DTLS pin parse — the value the transport compares
 * (colons stripped) against the QR pin to accept or reject the pipe. It lives
 * here, in the platform-agnostic seam, so EVERY native adapter (node-datachannel
 * + react-native-webrtc) parses the pin identically: a fix to the regex can't
 * silently leave one platform completing a pipe the other rejects (the exact
 * divergence [[fail-loud-no-masking]] warns about for security-critical parses).
 */
export function parseSdpFingerprint(sdp: string): string | null {
  const match = sdp.match(/^a=fingerprint:sha-256\s+([0-9a-fA-F:]+)\s*$/im);
  return match?.[1]?.toUpperCase() ?? null;
}

// --- Wire contract --------------------------------------------------------
// The offerer and answerer MUST open the three pre-negotiated channels with the
// SAME labels + ids (a mismatch silently breaks pairing) and frame under the
// SAME chunk size. Single source here so the two ends cannot drift.

/** Control channel (RPC envelopes + events + session handshake). */
export const CONTROL_LABEL = "control";
export const CONTROL_CHANNEL_ID = 0;
/** Bulk channel (binary stream v2 frames). */
export const BULK_LABEL = "bulk";
export const BULK_CHANNEL_ID = 1;
/** Interactive streaming channel (subscription readiness/replay and RPC bodies). */
export const INTERACTIVE_LABEL = "interactive";
export const INTERACTIVE_CHANNEL_ID = 2;
/** react-native-webrtc corrupts >16 KiB data-channel messages (RFC 8831 §6.6),
 * so both ends chunk/fragment under this. */
export const DEFAULT_CHUNK_SIZE = 16 * 1024;
