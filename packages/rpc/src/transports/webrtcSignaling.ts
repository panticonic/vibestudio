/**
 * Signaling client contract — the seam between the transport (workstream A) and
 * the Cloudflare signaling Durable Object (workstream B, `apps/signaling`). The
 * signaling box is deliberately dumb: a UUID-addressed rendezvous that
 * blind-relays SDP/ICE between two peers (security lives in the QR pin, not the
 * relay). The room PERSISTS for the connection's lifetime (WebSocket
 * Hibernation API) so it can carry ICE-restart, not just first connect.
 */

import type { RtcIceCandidate, RtcIceServer, RtcSessionDescription } from "./webrtcPeer.js";

export interface SignalingClient {
  /** Relay our local SDP (offer/answer) to the peer via the room. */
  sendDescription(desc: RtcSessionDescription): Promise<void>;
  /** Relay one local ICE candidate to the peer. */
  sendCandidate(candidate: RtcIceCandidate): Promise<void>;
  /** Inbound SDP from the peer. Returns an unsubscribe. */
  onDescription(handler: (desc: RtcSessionDescription) => void): () => void;
  /** Inbound ICE candidate from the peer. Returns an unsubscribe. */
  onCandidate(handler: (candidate: RtcIceCandidate) => void): () => void;
  /**
   * Short-lived TURN credentials minted per session and handed to both peers
   * through the room (Cloudflare Realtime TURN). When present the transport
   * prefers these over any static `iceServers` in the pairing payload.
   */
  fetchIceServers?(): Promise<RtcIceServer[]>;
  /**
   * Proven-live seam: fired once the room WebSocket has actually OPENED (the
   * relay is reachable), and immediately if it already opened before the
   * handler subscribed. The answerer's rejoin supervisor resets its backoff
   * ONLY on this — never on mere client construction, which the WS-eager
   * `createSignalingClient` performs without ever throwing for an unreachable
   * host (a down worker would otherwise be hammered ~1 socket/sec forever).
   * Optional so in-memory fakes/adapters that cannot open async may omit it.
   */
  onOpen?(handler: () => void): () => void;
  /**
   * Fired when the peer joins the room (`peer-joined`). The offerer re-sends its
   * current offer on this so a late-arriving server — or one that recovered
   * after a signaling-buffer overflow — receives an offer instead of waiting
   * out the connect deadline. Optional (fakes/adapters may omit it).
   */
  onPeerJoined?(handler: () => void): () => void;
  /** Signal that the room dropped/closed (so the transport can fail loud). */
  onClosed(handler: (reason?: string) => void): () => void;
  close(): void;
}
