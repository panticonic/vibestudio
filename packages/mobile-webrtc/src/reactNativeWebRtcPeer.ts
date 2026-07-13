/**
 * Native WebRTC peer adapter — `react-native-webrtc` implementing the
 * platform-agnostic `PeerConnectionProvider` contract (plan workstream C). This
 * is the **mobile** sibling of the desktop/server adapter
 * (`src/main/webrtc/nodeDatachannelPeer.ts`): both wrap a native WebRTC stack
 * into the same `RtcPeerConnectionLike`/`RtcDataChannelLike` shape that the
 * transport (`@vibestudio/rpc/transports/webrtcClient`) codes against, so the
 * transport carries no native dependency and stays unit-testable with fakes.
 *
 * Three impedance mismatches are handled at this boundary:
 *
 *  1. **Event style.** `react-native-webrtc` is standard WHATWG — a WHATWG
 *     `EventTarget` (`addEventListener('icecandidate', …)`) with auto-negotiation.
 *     The contract is the node-datachannel-flavored callback-registration style
 *     (`onLocalDescription(cb) => unsubscribe`, many listeners). Each native
 *     event is registered ONCE and dispatched through a {@link Fanout} so many
 *     contract listeners compose and each gets an unsubscribe.
 *
 *  2. **Negotiation shape.** Unlike node-datachannel (which fuses offer/answer
 *     *creation* with `setLocalDescription` and emits the SDP asynchronously via
 *     `onLocalDescription`), react-native-webrtc does standard negotiation:
 *     `createOffer()` returns the real `{type, sdp}` and `setLocalDescription`
 *     applies it. We are the **offerer**, so after `setLocalDescription` resolves
 *     we read the finalized `pc.localDescription` and emit it through
 *     `onLocalDescription` — exactly what the transport waits on (it calls
 *     `createOffer` → `setLocalDescription`, then relies on the
 *     `onLocalDescription` callback to ship the SDP through signaling).
 *
 *  3. **No `remoteFingerprint()`.** react-native-webrtc exposes no DTLS
 *     fingerprint accessor. The pinned value is the `a=fingerprint:sha-256 …`
 *     line of the REMOTE SDP (`pc.remoteDescription.sdp`). We parse it and return
 *     the uppercase colon-hex form the QR pin uses (matches `normalizeFingerprint`
 *     in `@vibestudio/shared/connect`). Null until the remote description is set, so
 *     the transport fails closed — it never completes an unpinned pipe.
 *
 * The native surface is described by the local `NativeRtc*` interfaces below
 * (mirroring how the node adapter declares its own `NativePeerConnection`),
 * rather than leaning on `react-native-webrtc`'s shipped `event-target-shim`
 * typings, which do not surface `addEventListener` to consumers.
 */

import { RTCPeerConnection } from "react-native-webrtc";
import { NativeEventEmitter, NativeModules } from "react-native";
import type {
  PeerConnectionProvider,
  RtcCandidateType,
  RtcConnectionState,
  RtcDataChannelInit,
  RtcDataChannelLike,
  RtcDataChannelState,
  RtcIceCandidate,
  RtcIceServer,
  RtcPeerConfig,
  RtcPeerConnectionLike,
  RtcSessionDescription,
} from "@vibestudio/rpc/transports/webrtcPeer";
import { DEFAULT_CHUNK_SIZE, parseSdpFingerprint } from "@vibestudio/rpc/transports/webrtcPeer";

/**
 * React Native's data-channel stack has corrupted frames above the conservative
 * transport chunk. Report the safe cap as the channel max so both hello
 * negotiation and `sendChunked` stay below it even when callers omit chunkSize.
 */
const SCTP_MAX_MESSAGE_SIZE = DEFAULT_CHUNK_SIZE;

// ===========================================================================
// Minimal native surface — only what this adapter touches, typed locally so the
// wrapper does not depend on react-native-webrtc's event-target-shim typings.
// ===========================================================================

interface NativeSessionDescription {
  type: string | null;
  sdp: string;
}

interface NativeIceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

interface NativeMessageEvent {
  data: string | ArrayBuffer;
}

interface NativeIceCandidateEvent {
  candidate: NativeIceCandidate | null;
}

interface NativeIceCandidateErrorEvent {
  errorCode?: number;
  errorText?: string;
  url?: string;
}

interface NativeRtcDataChannel {
  readonly _reactTag?: string;
  readonly label: string;
  readonly readyState: string;
  readonly bufferedAmount: number;
  binaryType: string;
  bufferedAmountLowThreshold: number;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(): void;
  addEventListener(
    type: "open" | "close" | "closing" | "error" | "bufferedamountlow",
    listener: () => void
  ): void;
  addEventListener(type: "message", listener: (event: NativeMessageEvent) => void): void;
}

/** One WebRTC stats record (only the candidate/pair fields this adapter reads). */
interface NativeStatsReport {
  type?: string;
  id?: string;
  /** candidate-pair: selected / nominated / connection state. */
  selected?: boolean;
  nominated?: boolean;
  state?: string;
  localCandidateId?: string;
  /** local-candidate: host / srflx / prflx / relay. */
  candidateType?: string;
  foundation?: string | number;
  address?: string;
  ip?: string;
  port?: number;
  protocol?: string;
  priority?: number;
  tcpType?: string;
  relatedAddress?: string;
  relatedPort?: number;
}

interface NativeRtcPeerConnection {
  readonly _pcId?: number;
  readonly connectionState: string;
  readonly iceConnectionState: string;
  readonly localDescription: NativeSessionDescription | null;
  readonly remoteDescription: NativeSessionDescription | null;
  createDataChannel(
    label: string,
    init?: { ordered?: boolean; negotiated?: boolean; id?: number }
  ): NativeRtcDataChannel;
  createOffer(): Promise<{ type?: string; sdp?: string }>;
  createAnswer(): Promise<{ type?: string; sdp?: string }>;
  setLocalDescription(desc?: NativeSessionDescription): Promise<void>;
  setRemoteDescription(desc: NativeSessionDescription): Promise<void>;
  addIceCandidate(candidate: unknown): Promise<void>;
  /** WHATWG getStats — an `RTCStatsReport` (a `Map`) of the live transport stats. */
  getStats(): Promise<Map<string, NativeStatsReport>>;
  close(): void;
  addEventListener(
    type: "connectionstatechange" | "iceconnectionstatechange",
    listener: () => void
  ): void;
  addEventListener(type: "icecandidate", listener: (event: NativeIceCandidateEvent) => void): void;
  addEventListener(
    type: "icecandidateerror",
    listener: (event: NativeIceCandidateErrorEvent) => void
  ): void;
}

interface NativeEventSubscription {
  remove(): void;
}

interface DirectNativeEventMap {
  dataChannelStateChanged: {
    reactTag?: unknown;
    state?: unknown;
  };
  dataChannelReceiveMessage: {
    reactTag?: unknown;
    data?: unknown;
    type?: unknown;
  };
  dataChannelDidChangeBufferedAmount: {
    reactTag?: unknown;
    bufferedAmount?: unknown;
  };
  peerConnectionStateChanged: {
    pcId?: unknown;
    connectionState?: unknown;
  };
  peerConnectionIceConnectionChanged: {
    pcId?: unknown;
    iceConnectionState?: unknown;
  };
  peerConnectionGotICECandidate: {
    pcId?: unknown;
    candidate?: unknown;
  };
}

let directNativeEmitter: NativeEventEmitter | null = null;

function addDirectNativeListener<EventName extends keyof DirectNativeEventMap>(
  eventName: EventName,
  listener: (event: DirectNativeEventMap[EventName]) => void
): NativeEventSubscription | null {
  const nativeModule = NativeModules["WebRTCModule"];
  if (!nativeModule) return null;
  directNativeEmitter ??= new NativeEventEmitter(nativeModule);
  return directNativeEmitter.addListener(eventName, listener);
}

function decodeBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export interface ReactNativeWebRtcProviderOptions {
  /** Log prefix for listener-fault diagnostics (defaults to `[rn-webrtc]`). */
  logPrefix?: string;
}

/**
 * Create the `react-native-webrtc`-backed provider. The client side only ever
 * pins the SERVER's fingerprint, so it presents an ephemeral DTLS cert and never
 * needs `localFingerprint` — the optional provider method is omitted.
 */
export function createReactNativeWebRtcProvider(
  options: ReactNativeWebRtcProviderOptions = {}
): PeerConnectionProvider {
  const log = options.logPrefix ?? "[rn-webrtc]";
  return {
    create(config: RtcPeerConfig): RtcPeerConnectionLike {
      const iceServers = config.iceServers.flatMap(toNativeIceServers);
      console.log(
        `${log} create peer policy=${config.iceTransportPolicy ?? "all"} ice=${iceServers
          .map((server) => server.urls)
          .join(",")}`
      );
      const pc = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: config.iceTransportPolicy,
        // react-native-webrtc gathers ICE candidates incrementally (trickle) and
        // surfaces them via the 'icecandidate' event, which the transport relays.
      }) as unknown as NativeRtcPeerConnection;
      return new WrappedPeerConnection(pc, log);
    },
  };
}

// ===========================================================================
// Pure helpers — no native dependency.
// ===========================================================================

/**
 * Multi-listener fan-out over a single underlying native handler. The contract
 * exposes `onX(handler) => unsubscribe` with many listeners; we register one
 * native `addEventListener` per event that emits here, and let contract-level
 * listeners subscribe/unsubscribe independently. A throwing listener is isolated
 * so it cannot starve the others or break the native callback.
 */
export class Fanout<Args extends unknown[]> {
  private readonly handlers = new Set<(...args: Args) => void>();

  constructor(private readonly log = "[rn-webrtc]") {}

  add(handler: (...args: Args) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(...args: Args): void {
    // Snapshot so a handler that unsubscribes during dispatch is well-defined.
    for (const handler of [...this.handlers]) {
      try {
        handler(...args);
      } catch (error) {
        console.warn(`${this.log} data/peer listener threw`, error);
      }
    }
  }

  get size(): number {
    return this.handlers.size;
  }
}

/** Map the contract's WHATWG-shaped ICE server to react-native-webrtc's form. */
function toNativeIceServers(server: RtcIceServer): Array<{
  urls: string | string[];
  username?: string;
  credential?: string;
}> {
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
  return urls.map((url) => ({
    urls: url,
    ...(server.username !== undefined ? { username: server.username } : {}),
    ...(server.credential !== undefined ? { credential: server.credential } : {}),
  }));
}

/** react-native-webrtc connection states already match the contract; normalize
 * defensively so an unexpected value fails loud as 'failed' rather than leaking. */
export function normalizeConnectionState(raw: string): RtcConnectionState {
  switch (raw) {
    case "new":
      return "new";
    case "connecting":
      return "connecting";
    case "connected":
      return "connected";
    case "disconnected":
      return "disconnected";
    case "failed":
      return "failed";
    case "closed":
      return "closed";
    default:
      console.warn(`[rn-webrtc] unknown connection state '${raw}' → treating as 'failed'`);
      return "failed";
  }
}

/** Map a WHATWG `RTCIceCandidateType` to the contract's `RtcCandidateType`;
 * unknown/missing → null so the relay hint reads "unknown", never a wrong "host". */
export function toCandidateType(raw: string | undefined | null): RtcCandidateType | null {
  switch (raw) {
    case "host":
    case "srflx":
    case "prflx":
    case "relay":
      return raw;
    default:
      return null;
  }
}

/**
 * Pull the selected local candidate's type out of a `getStats()` report: find the
 * nominated/selected `candidate-pair` in state `succeeded`, then resolve its
 * `localCandidateId` to the `local-candidate` record's `candidateType`. Returns
 * null when no pair is settled (or the type is unrecognized) — never throws — so
 * the relay hint reads "unknown" rather than guessing. Best-effort observability
 * only; react-native-webrtc has no synchronous selected-pair accessor.
 */
export function selectedCandidateTypeFromStats(
  stats: Map<string, NativeStatsReport> | null | undefined
): RtcCandidateType | null {
  if (!stats) return null;
  const reports = [...stats.values()];
  const pair = reports.find(
    (r) => r?.type === "candidate-pair" && (r.selected || r.nominated) && r.state === "succeeded"
  );
  const localId = pair?.localCandidateId;
  if (!localId) return null;
  const local = reports.find(
    (r) => (r?.type === "local-candidate" || r?.type === "localcandidate") && r.id === localId
  );
  return toCandidateType(local?.candidateType);
}

// `parseSdpFingerprint` (the fail-closed pin parse) is imported from the shared
// webrtcPeer.ts above — no per-platform copy, so the pin parse can't drift.

// ===========================================================================
// Wrappers — map react-native-webrtc's WHATWG surface onto the contract.
// ===========================================================================

class WrappedDataChannel implements RtcDataChannelLike {
  readonly label: string;
  private readonly openFanout: Fanout<[]>;
  private readonly closeFanout: Fanout<[]>;
  private readonly errorFanout: Fanout<[Error]>;
  private readonly messageFanout: Fanout<[Uint8Array]>;
  private readonly lowFanout: Fanout<[]>;
  private readonly directSubscriptions: NativeEventSubscription[] = [];
  private usesDirectNativeEvents = false;
  private readyStateValue: RtcDataChannelState;
  private bufferedAmountValue: number;

  constructor(
    private readonly dc: NativeRtcDataChannel,
    log: string
  ) {
    this.label = dc.label;
    this.openFanout = new Fanout(log);
    this.closeFanout = new Fanout(log);
    this.errorFanout = new Fanout(log);
    this.messageFanout = new Fanout(log);
    this.lowFanout = new Fanout(log);
    this.readyStateValue = dc.readyState as RtcDataChannelState;
    this.bufferedAmountValue = dc.bufferedAmount;
    // Deliver binary as ArrayBuffer (react-native-webrtc only supports this mode).
    this.dc.binaryType = "arraybuffer";
    const reactTag = this.dc._reactTag;
    // Prefer react-native-webrtc's RTCDataChannel event bridge. It owns the
    // native subscription lifecycle and converts binary messages to
    // ArrayBuffers before dispatching them. The direct native path is only a
    // compatibility fallback for channel-like objects without EventTarget.
    if (reactTag && typeof dc.addEventListener !== "function") {
      this.usesDirectNativeEvents = true;
      const stateSubscription = addDirectNativeListener("dataChannelStateChanged", (event) => {
        if (event.reactTag !== reactTag || typeof event.state !== "string") return;
        this.setReadyState(event.state as RtcDataChannelState);
      });
      const messageSubscription = addDirectNativeListener("dataChannelReceiveMessage", (event) => {
        if (event.reactTag !== reactTag || typeof event.data !== "string") return;
        this.messageFanout.emit(
          event.type === "binary" ? decodeBase64(event.data) : new TextEncoder().encode(event.data)
        );
      });
      const bufferedSubscription = addDirectNativeListener(
        "dataChannelDidChangeBufferedAmount",
        (event) => {
          if (event.reactTag !== reactTag || typeof event.bufferedAmount !== "number") return;
          this.bufferedAmountValue = event.bufferedAmount;
          if (this.bufferedAmountValue < this.bufferedAmountLowThreshold) this.lowFanout.emit();
        }
      );
      for (const subscription of [stateSubscription, messageSubscription, bufferedSubscription]) {
        if (subscription) this.directSubscriptions.push(subscription);
      }
    } else {
      // Fallback for mocks and older react-native-webrtc releases without tags.
      this.dc.addEventListener("open", () => this.setReadyState("open"));
      this.dc.addEventListener("close", () => this.setReadyState("closed"));
      this.dc.addEventListener("error", () =>
        this.errorFanout.emit(new Error(`data channel '${this.label}' error`))
      );
      this.dc.addEventListener("message", (event) => {
        const data = event.data;
        if (data instanceof ArrayBuffer) this.messageFanout.emit(new Uint8Array(data));
        else if (typeof data === "string") this.messageFanout.emit(new TextEncoder().encode(data));
      });
      this.dc.addEventListener("bufferedamountlow", () => this.lowFanout.emit());
    }
  }

  private setReadyState(state: RtcDataChannelState): void {
    if (state === this.readyStateValue) return;
    this.readyStateValue = state;
    if (state === "open") this.openFanout.emit();
    if (state === "closed") {
      this.closeFanout.emit();
      for (const subscription of this.directSubscriptions.splice(0)) subscription.remove();
    }
  }

  get readyState(): RtcDataChannelState {
    return this.readyStateValue;
  }

  get bufferedAmount(): number {
    // react-native-webrtc keeps its public value current on the standard
    // EventTarget path. Only the direct-native fallback needs our own cache.
    return this.usesDirectNativeEvents ? this.bufferedAmountValue : this.dc.bufferedAmount;
  }

  get bufferedAmountLowThreshold(): number {
    return this.dc.bufferedAmountLowThreshold;
  }

  set bufferedAmountLowThreshold(value: number) {
    this.dc.bufferedAmountLowThreshold = value;
  }

  get maxMessageSize(): number {
    return SCTP_MAX_MESSAGE_SIZE;
  }

  send(data: Uint8Array): void {
    // react-native-webrtc's send(ArrayBufferView) re-slices with byteOffset +
    // byteLength, so the transport's `bytes.subarray(...)` views are sent exactly.
    this.dc.send(data);
  }

  close(): void {
    this.dc.close();
  }

  onOpen(handler: () => void): () => void {
    return this.openFanout.add(handler);
  }

  onClose(handler: () => void): () => void {
    return this.closeFanout.add(handler);
  }

  onError(handler: (error: Error) => void): () => void {
    return this.errorFanout.add(handler);
  }

  onMessage(handler: (data: Uint8Array) => void): () => void {
    return this.messageFanout.add(handler);
  }

  onBufferedAmountLow(handler: () => void): () => void {
    return this.lowFanout.add(handler);
  }
}

export class WrappedPeerConnection implements RtcPeerConnectionLike {
  private readonly stateFanout: Fanout<[RtcConnectionState]>;
  private readonly localDescFanout: Fanout<[RtcSessionDescription]>;
  private readonly localCandFanout: Fanout<[RtcIceCandidate]>;
  private readonly candidateTypeFanout: Fanout<[RtcCandidateType | null]>;
  private readonly directSubscriptions: NativeEventSubscription[] = [];
  private readonly gatheredLocalCandidates: RtcIceCandidate[] = [];
  // The SDP last passed to setRemoteDescription — cached so remoteFingerprint()
  // can read the a=fingerprint line back the instant sRD resolves, without
  // depending on the timing of the native remoteDescription accessor.
  private remoteSdp: string | null = null;
  // Last selected-candidate type resolved from getStats(): powers the sync
  // `selectedCandidateType()` one-shot read and de-dupes the change feed.
  // `undefined` = never polled (distinct from an emitted `null`).
  private lastCandidateType: RtcCandidateType | null | undefined = undefined;

  constructor(
    private readonly pc: NativeRtcPeerConnection,
    private readonly log: string
  ) {
    this.stateFanout = new Fanout(log);
    this.localDescFanout = new Fanout(log);
    this.localCandFanout = new Fanout(log);
    this.candidateTypeFanout = new Fanout(log);

    const emitCandidate = (candidate: NativeIceCandidate | null): void => {
      // A null candidate (or empty string) is the end-of-candidates marker — the
      // node adapter trickles real candidates only; match that.
      if (!candidate || !candidate.candidate) return;
      const normalized = {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? null,
        sdpMLineIndex: candidate.sdpMLineIndex ?? null,
      };
      if (this.rememberLocalCandidate(normalized)) this.localCandFanout.emit(normalized);
    };
    const pcId = this.pc._pcId;
    if (typeof pcId === "number") {
      const stateSubscription = addDirectNativeListener("peerConnectionStateChanged", (event) => {
        if (event.pcId !== pcId || typeof event.connectionState !== "string") return;
        this.stateFanout.emit(normalizeConnectionState(event.connectionState));
        void this.refreshSelectedCandidate();
      });
      const iceSubscription = addDirectNativeListener(
        "peerConnectionIceConnectionChanged",
        (event) => {
          if (event.pcId !== pcId || typeof event.iceConnectionState !== "string") return;
          if (event.iceConnectionState === "failed") this.stateFanout.emit("failed");
          void this.refreshSelectedCandidate();
        }
      );
      const candidateSubscription = addDirectNativeListener(
        "peerConnectionGotICECandidate",
        (event) => {
          if (event.pcId !== pcId) return;
          emitCandidate((event.candidate as NativeIceCandidate | undefined) ?? null);
        }
      );
      for (const subscription of [stateSubscription, iceSubscription, candidateSubscription]) {
        if (subscription) this.directSubscriptions.push(subscription);
      }
    } else {
      const emitState = (): void =>
        this.stateFanout.emit(normalizeConnectionState(this.pc.connectionState));
      this.pc.addEventListener("connectionstatechange", () => {
        emitState();
        void this.refreshSelectedCandidate();
      });
      this.pc.addEventListener("iceconnectionstatechange", () => {
        if (this.pc.iceConnectionState === "failed") this.stateFanout.emit("failed");
        else emitState();
        void this.refreshSelectedCandidate();
      });
      this.pc.addEventListener("icecandidate", (event) => emitCandidate(event.candidate));
    }
    this.pc.addEventListener("icecandidateerror", (event) => {
      console.warn(
        `${this.log} ICE candidate error code=${event.errorCode ?? "?"} url=${event.url ?? "?"}: ${
          event.errorText ?? "unknown error"
        }`
      );
    });
  }

  createDataChannel(label: string, init?: RtcDataChannelInit): RtcDataChannelLike {
    const dc = this.pc.createDataChannel(label, {
      ordered: init?.ordered ?? true,
      negotiated: init?.negotiated ?? false,
      id: init?.id,
    });
    return new WrappedDataChannel(dc, this.log);
  }

  async createOffer(): Promise<RtcSessionDescription> {
    const offer = await this.pc.createOffer();
    return { type: "offer", sdp: offer.sdp ?? "" };
  }

  async createAnswer(): Promise<RtcSessionDescription> {
    const answer = await this.pc.createAnswer();
    return { type: "answer", sdp: answer.sdp ?? "" };
  }

  async setLocalDescription(desc?: RtcSessionDescription): Promise<void> {
    await this.pc.setLocalDescription(desc ? { type: desc.type, sdp: desc.sdp } : undefined);
    // Some react-native-webrtc/Android combinations allocate TURN candidates but
    // fail to dispatch their JS `icecandidate` events. The native wrapper still
    // refreshes `localDescription` as gathering progresses, so include those
    // candidates in the SDP as a non-trickle fallback before publishing it.
    await this.waitForLocalCandidate();
    // Standard negotiation: the local SDP is final on `pc.localDescription` once
    // sLD resolves. Emit it so the transport ships it through signaling — the
    // transport never reads our return value; it waits on onLocalDescription.
    const local = this.pc.localDescription;
    const rawSdp = local?.sdp ?? desc?.sdp;
    const type = local?.type ?? desc?.type;
    if (rawSdp && type) {
      const sdp = this.embedGatheredLocalCandidates(rawSdp);
      const candidateCount = (sdp.match(/^a=candidate:/gm) ?? []).length;
      console.info(`${this.log} publishing local SDP candidates=${candidateCount}`);
      this.localDescFanout.emit({ type: type === "answer" ? "answer" : "offer", sdp });
    }
  }

  private async waitForLocalCandidate(timeoutMs = 4_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (
        this.gatheredLocalCandidates.length > 0 ||
        /^a=candidate:/m.test(this.pc.localDescription?.sdp ?? "")
      ) {
        return;
      }
      await this.collectLocalCandidatesFromStats();
      if (this.gatheredLocalCandidates.length > 0) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    console.warn(`${this.log} ICE candidate wait timed out; publishing partial local SDP`);
  }

  private rememberLocalCandidate(candidate: RtcIceCandidate): boolean {
    if (this.gatheredLocalCandidates.some((entry) => entry.candidate === candidate.candidate)) {
      return false;
    }
    this.gatheredLocalCandidates.push(candidate);
    return true;
  }

  private async collectLocalCandidatesFromStats(): Promise<void> {
    try {
      const stats = await this.pc.getStats();
      const sdpMid = this.pc.localDescription?.sdp.match(/^a=mid:(.+)$/m)?.[1]?.trim() ?? null;
      for (const report of stats.values()) {
        if (report.type !== "local-candidate") continue;
        const address = report.address ?? report.ip;
        const candidateType = report.candidateType;
        if (!address || !report.port || !report.protocol || !candidateType) continue;
        const parts = [
          `candidate:${report.foundation ?? "1"}`,
          "1",
          report.protocol.toUpperCase(),
          String(report.priority ?? 1),
          address,
          String(report.port),
          "typ",
          candidateType,
        ];
        if (report.relatedAddress) parts.push("raddr", report.relatedAddress);
        if (report.relatedPort) parts.push("rport", String(report.relatedPort));
        if (report.tcpType) parts.push("tcptype", report.tcpType);
        this.rememberLocalCandidate({
          candidate: parts.join(" "),
          sdpMid,
          sdpMLineIndex: 0,
        });
      }
    } catch {
      // Gathering may not have populated stats yet; the bounded caller retries.
    }
  }

  private embedGatheredLocalCandidates(sdp: string): string {
    if (this.gatheredLocalCandidates.length === 0) return sdp;
    const newline = sdp.includes("\r\n") ? "\r\n" : "\n";
    const lines = sdp.trimEnd().split(/\r?\n/);
    for (const candidate of this.gatheredLocalCandidates) {
      const line = candidate.candidate.startsWith("a=")
        ? candidate.candidate
        : `a=${candidate.candidate}`;
      if (lines.includes(line)) continue;

      let sectionStart = -1;
      if (candidate.sdpMid) {
        const midIndex = lines.findIndex((entry) => entry === `a=mid:${candidate.sdpMid}`);
        for (let index = midIndex; index >= 0; index -= 1) {
          if (lines[index]?.startsWith("m=")) {
            sectionStart = index;
            break;
          }
        }
      }
      if (sectionStart < 0 && typeof candidate.sdpMLineIndex === "number") {
        const mediaSections = lines
          .map((entry, index) => (entry.startsWith("m=") ? index : -1))
          .filter((index) => index >= 0);
        sectionStart = mediaSections[candidate.sdpMLineIndex] ?? -1;
      }
      const nextSection = lines.findIndex(
        (entry, index) => index > sectionStart && entry.startsWith("m=")
      );
      lines.splice(nextSection >= 0 ? nextSection : lines.length, 0, line);
    }
    return `${lines.join(newline)}${newline}`;
  }

  async setRemoteDescription(desc: RtcSessionDescription): Promise<void> {
    // Cache before handing to the native peer so remoteFingerprint() can read the
    // a=fingerprint line back regardless of native accessor timing.
    this.remoteSdp = desc.sdp;
    await this.pc.setRemoteDescription({ type: desc.type, sdp: desc.sdp });
  }

  async addRemoteCandidate(candidate: RtcIceCandidate): Promise<void> {
    await this.pc.addIceCandidate({
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid ?? null,
      sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    });
  }

  remoteFingerprint(): string | null {
    // The DTLS SHA-256 the QR pins is the a=fingerprint:sha-256 line of the remote
    // SDP. Sound because by the time DTLS is 'connected' the native stack has
    // verified the live cert matches that line, so the parsed value still detects
    // a signaling-MITM cert swap against the pin. Null (no remote description yet)
    // makes the transport wait — it never completes an unpinned pipe (fail-closed).
    const sdp = this.remoteSdp ?? this.pc.remoteDescription?.sdp ?? null;
    return sdp ? parseSdpFingerprint(sdp) : null;
  }

  selectedCandidateType(): RtcCandidateType | null {
    // react-native-webrtc has no synchronous selected-pair accessor; report the
    // last value the async getStats() poll resolved (null until the first poll
    // lands, and null when no pair is settled). The live change feed is
    // `onSelectedCandidateChange`; this is the best-effort one-shot read.
    return this.lastCandidateType ?? null;
  }

  onSelectedCandidateChange(handler: (type: RtcCandidateType | null) => void): () => void {
    return this.candidateTypeFanout.add(handler);
  }

  /**
   * Best-effort: read getStats(), resolve the selected candidate type, and emit
   * it iff it changed. Never throws into the ICE handler that calls it — a stats
   * failure just leaves the last value in place. Skipped when nobody is
   * listening, so it never spins up getStats() for no reason.
   */
  private async refreshSelectedCandidate(): Promise<void> {
    if (this.candidateTypeFanout.size === 0) return;
    let type: RtcCandidateType | null;
    try {
      type = selectedCandidateTypeFromStats(await this.pc.getStats());
    } catch (error) {
      // getStats can reject once the peer is closing — best-effort, so swallow it.
      console.warn(`${this.log} getStats for selected candidate failed`, error);
      return;
    }
    if (type === this.lastCandidateType) return;
    this.lastCandidateType = type;
    this.candidateTypeFanout.emit(type);
  }

  get connectionState(): RtcConnectionState {
    return normalizeConnectionState(this.pc.connectionState);
  }

  onConnectionStateChange(handler: (state: RtcConnectionState) => void): () => void {
    return this.stateFanout.add(handler);
  }

  onLocalDescription(handler: (desc: RtcSessionDescription) => void): () => void {
    return this.localDescFanout.add(handler);
  }

  onLocalCandidate(handler: (candidate: RtcIceCandidate) => void): () => void {
    return this.localCandFanout.add(handler);
  }

  close(): void {
    for (const subscription of this.directSubscriptions.splice(0)) subscription.remove();
    this.pc.close();
  }
}
