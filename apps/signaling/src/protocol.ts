/**
 * Signaling wire protocol — the JSON message shapes shared by the SignalingRoom
 * Durable Object and the `createSignalingClient` transport
 * (`packages/rpc/src/transports/webrtcSignalingClient.ts`).
 *
 * The room is deliberately DUMB: it blind-relays `description`/`candidate`
 * between the two peers and emits room-lifecycle events (`peer-joined`,
 * `peer-left`). It NEVER inspects SDP/ICE content — security lives in the QR
 * DTLS-fingerprint pin, not in this box (plan §2/§6).
 *
 * These structural types are duplicated (not imported from `@vibestudio/rpc`)
 * because `apps/signaling` is a standalone Cloudflare Worker with its own build
 * boundary. The wire contract IS the JSON shape; it matches
 * `RtcSessionDescription`/`RtcIceCandidate`/`RtcIceServer` in
 * `packages/rpc/src/transports/webrtcPeer.ts` field-for-field.
 *
 * TURN credentials are delivered out-of-band over HTTP (`GET
 * /room/:roomId/ice-servers`, see `IceServersResponse`), NOT as a WebSocket
 * frame: minting is a request/response that maps cleanly onto an HTTP GET and
 * fails loud on a non-200, whereas a push frame would need a racy "what if it
 * never arrives" waiter. Keeping creds off the relay socket also keeps the
 * socket purely a blind SDP/ICE pipe.
 */

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

/** SDP (offer/answer) relayed verbatim to the other peer. */
export interface DescriptionMessage {
  t: "description";
  desc: RtcSessionDescription;
}

/** One ICE candidate relayed verbatim to the other peer. */
export interface CandidateMessage {
  t: "candidate";
  cand: RtcIceCandidate;
}

/** The room now holds another peer (sent to the peer(s) already present). */
export interface PeerJoinedMessage {
  t: "peer-joined";
  /** Total peers in the room after the join (1 or 2). */
  peers: number;
}

/**
 * A peer dropped its signaling socket. The room is NOT torn down — the slot is
 * freed so that peer can rejoin the same room id to drive an ICE-restart
 * (plan §1/§2: the room persists for the connection's lifetime).
 */
export interface PeerLeftMessage {
  t: "peer-left";
  /** Total peers remaining in the room (0 or 1). */
  peers: number;
}

/**
 * The two rendezvous slots. A join must declare which one it fills via the
 * required `?role=` query param; a same-role rejoin EVICTS the incumbent (plan
 * §4 — with one room per paired device a same-role joiner is, by construction,
 * the same party reconnecting).
 */
export type SignalingRole = "offerer" | "answerer";

/** Frames a peer may send to the room over the WebSocket. */
export type SignalingClientMessage = DescriptionMessage | CandidateMessage;

/** Frames the room may send to a peer over the WebSocket. */
export type SignalingServerMessage =
  | DescriptionMessage
  | CandidateMessage
  | PeerJoinedMessage
  | PeerLeftMessage;

/** The only message types the room relays peer-to-peer (everything else dropped). */
export const RELAYED_TYPES: ReadonlySet<string> = new Set(["description", "candidate"]);

/** Body of `GET /room/:roomId/ice-servers` — the per-session TURN/STUN config. */
export interface IceServersResponse {
  iceServers: RtcIceServer[];
}
