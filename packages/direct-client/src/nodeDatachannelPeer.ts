/**
 * Shared Node WebRTC peer adapter — `node-datachannel` (libdatachannel) implementing
 * the platform-agnostic `PeerConnectionProvider` contract (workstream C; plan
 * §5/§11). This is the desktop+server side of the seam that
 * `packages/rpc/.../webrtcClient.ts` (workstream A) codes against; the transport
 * never imports a native module, so it stays fully unit-testable with fakes and
 * the native dependency lives only here.
 *
 * Three impedance mismatches are handled at this boundary:
 *
 *  1. **Callback fan-out.** `node-datachannel` exposes *single-handler* setters
 *     (`pc.onStateChange(cb)` replaces the previous handler). The contract is
 *     WHATWG-ish — `onConnectionStateChange(h) => unsubscribe`, many listeners.
 *     Each native setter is registered ONCE and dispatched through a `Fanout`
 *     so multiple listeners compose and each gets an unsubscribe.
 *
 *  2. **Bytes.** libdatachannel speaks `Buffer`; the contract speaks
 *     `Uint8Array`. We convert at every send/receive (`toNodeBuffer` /
 *     `fromNodeMessage`), copying on receive so pooled `Buffer` memory can never
 *     alias retained stream slices.
 *
 *  3. **Negotiation shape.** libdatachannel fuses offer/answer *creation* with
 *     `setLocalDescription` and delivers the real SDP asynchronously via
 *     `onLocalDescription`. We run with `disableAutoNegotiation: true` for
 *     explicit control: `createOffer`/`createAnswer` return a typed marker (the
 *     transport never reads its `.sdp`), and `setLocalDescription` is what
 *     triggers libdatachannel to gather and emit the actual local description.
 *
 * The native module is loaded LAZILY (only when a peer is actually created) and
 * through `createRequire` so bundled ESM CLIs never hit esbuild's unsupported
 * dynamic-require shim. If the prebuilt addon is absent, `create()` fails loud
 * with an actionable message;
 * importing this module (and the pure helpers below) never touches it, so the
 * test suite runs without the binary.
 */

import { createRequire } from "node:module";
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
import { parseSdpFingerprint } from "@vibestudio/rpc/transports/webrtcPeer";
import { certFileFingerprint } from "./cert.js";

export { pemFingerprint } from "./cert.js";
export type { PersistentCert } from "./cert.js";

export interface NodeDatachannelProviderDefaults {
  /**
   * Persistent DTLS cert used when a `create()` config does not supply its own.
   * The SERVER side binds these so every peer it opens presents the pinned
   * fingerprint; the client side leaves them unset (ephemeral cert is fine — only
   * the server's fingerprint is pinned).
   */
  certificatePemFile?: string;
  keyPemFile?: string;
  /** Label prefix passed to `node-datachannel`'s `PeerConnection` ctor (logging). */
  peerName?: string;
}

/**
 * Create the `node-datachannel`-backed provider. `defaults` lets the server bind
 * its persistent cert once; otherwise the provider is config-driven and carries
 * no state. Construction does NOT load the native module.
 */
export function createNodeDatachannelProvider(
  defaults: NodeDatachannelProviderDefaults = {}
): PeerConnectionProvider {
  let counter = 0;
  return {
    create(config: RtcPeerConfig): RtcPeerConnectionLike {
      const nd = loadNodeDatachannel();
      const pc = new nd.PeerConnection(`${defaults.peerName ?? "vibestudio"}-${++counter}`, {
        iceServers: toNodeIceServers(config.iceServers),
        iceTransportPolicy: config.iceTransportPolicy,
        certificatePemFile: config.certificatePemFile ?? defaults.certificatePemFile,
        keyPemFile: config.keyPemFile ?? defaults.keyPemFile,
        // Explicit negotiation — see the offer/answer mapping in WrappedPeerConnection.
        disableAutoNegotiation: true,
      });
      return new WrappedPeerConnection(pc);
    },
    localFingerprint(cfg): string | null {
      const certificatePemFile = cfg.certificatePemFile ?? defaults.certificatePemFile;
      // No persistent cert ⇒ no stable fingerprint to publish. A *configured* but
      // unreadable/malformed cert must NOT be masked as null — let it throw so the
      // QR-publishing path fails loud instead of emitting an empty pin.
      if (!certificatePemFile) return null;
      return certFileFingerprint(certificatePemFile);
    },
  };
}

export function assertNodeDatachannelAvailable(): void {
  void loadNodeDatachannel();
}

// ===========================================================================
// Pure helpers — no native dependency, individually unit-tested.
// ===========================================================================

/**
 * Multi-listener fan-out over a single underlying handler slot. The native peer
 * exposes one handler per event; we register one dispatcher into it and let many
 * contract-level listeners subscribe/unsubscribe independently. A throwing
 * listener is isolated so it cannot starve the others or break the native callback.
 */
export class Fanout<Args extends unknown[]> {
  private readonly handlers = new Set<(...args: Args) => void>();

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
        console.warn("[webrtc] data/peer listener threw", error);
      }
    }
  }

  get size(): number {
    return this.handlers.size;
  }
}

/**
 * `Uint8Array` → Node `Buffer` for a libdatachannel send. Copies (rather than a
 * zero-copy view) so the native layer can never observe later mutation/reuse of
 * the caller's backing buffer — correctness over a negligible per-message copy.
 */
export function toNodeBuffer(data: Uint8Array): Buffer {
  return Buffer.from(data);
}

/**
 * A libdatachannel inbound message (`Buffer` for binary, `string` for text) →
 * `Uint8Array`. Binary is COPIED out of the (possibly pooled) `Buffer` so
 * retained stream slices never alias reused native memory; text is UTF-8 encoded.
 */
export function fromNodeMessage(message: Buffer | string): Uint8Array {
  if (typeof message === "string") return new TextEncoder().encode(message);
  return new Uint8Array(message); // copies the logical bytes (respects offset/length)
}

/** node-datachannel connection states already match the contract; normalize defensively. */
export function normalizeConnectionState(raw: string): RtcConnectionState {
  switch (raw.toLowerCase()) {
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
      console.warn(`[webrtc] unknown connection state '${raw}' → treating as 'failed'`);
      return "failed";
  }
}

/**
 * Map a candidate-pair entry's type to the contract's `RtcCandidateType`,
 * tolerating both the SDP short forms (`host`/`srflx`/`prflx`/`relay`) and
 * libdatachannel's long forms (`ServerReflexive`/`PeerReflexive`/`Relayed`).
 * Returns null for anything unrecognized so the relay alarm reads "unknown",
 * never a wrong "host".
 */
export function normalizeCandidateType(raw: string): RtcCandidateType | null {
  switch (raw) {
    case "host":
      return "host";
    case "srflx":
      return "srflx";
    case "prflx":
      return "prflx";
    case "relay":
      return "relay";
    default:
      return null;
  }
}

/**
 * Pull the local candidate's type out of node-datachannel 0.32's selected-pair
 * shape. A null pair means ICE has not selected one yet. Any other shape/value
 * is an API-contract violation and fails loudly instead of being interpreted as
 * an unknown candidate.
 */
export function candidateTypeFromPair(
  pair: { local: { type: string } } | null
): RtcCandidateType | null {
  if (pair === null) return null;
  if (!pair.local || typeof pair.local.type !== "string") {
    throw new Error("node-datachannel returned an invalid selected-candidate-pair shape");
  }
  const type = normalizeCandidateType(pair.local.type);
  if (!type) {
    throw new Error(`node-datachannel returned an unknown candidate type: ${pair.local.type}`);
  }
  return type;
}

// `parseSdpFingerprint` is the shared fail-closed pin parse (imported above from
// webrtcPeer.ts); re-exported here so the node adapter's tests keep their import
// site. The SDP-fallback at the bottom of this file uses the imported binding.
export { parseSdpFingerprint };

/**
 * Canonicalize node-datachannel 0.32's SHA-256 fingerprint value to the
 * uppercase colon-hex form the QR pin uses. The binding must return exactly 32
 * bytes; anything else is an API-contract violation.
 */
export function canonicalizeFingerprint(raw: string): string | null {
  const value = raw.trim();
  return /^(?:[0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2}$/.test(value) ? value.toUpperCase() : null;
}

/** node-datachannel ICE-server entry (object form carries TURN creds safely). */
export interface NodeIceServer {
  hostname: string;
  port: number;
  username?: string;
  password?: string;
  relayType?: "TurnUdp" | "TurnTcp" | "TurnTls";
}

const ICE_URL_RE =
  /^(stun|stuns|turn|turns):(\[[0-9a-fA-F:]+\]|[^:?\s]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/i;

/**
 * Convert WHATWG `RtcIceServer[]` (urls + username/credential) to the form
 * libdatachannel accepts: STUN as a `scheme:host:port` string, TURN as an object
 * (so credentials are not URL-escaped into an authority). An unparseable url
 * THROWS — a silently dropped TURN server is exactly the "P2P quietly broken,
 * no relay" failure the plan forbids (§ fail-loud).
 */
export function toNodeIceServers(servers: RtcIceServer[]): Array<string | NodeIceServer> {
  const out: Array<string | NodeIceServer> = [];
  for (const server of servers) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    for (const url of urls) {
      const m = ICE_URL_RE.exec(url.trim());
      if (!m) {
        throw new Error(`Unparseable ICE server url: ${JSON.stringify(url)}`);
      }
      const scheme = (m[1] ?? "").toLowerCase();
      const hostname = (m[2] ?? "").replace(/^\[|\]$/g, ""); // strip IPv6 brackets
      const secure = scheme === "stuns" || scheme === "turns";
      const port = m[3] ? Number.parseInt(m[3], 10) : secure ? 5349 : 3478;
      const transport = m[4]?.toLowerCase();

      if (scheme === "stun" || scheme === "stuns") {
        out.push(`${scheme}:${hostname}:${port}`);
      } else {
        out.push({
          hostname,
          port,
          username: server.username,
          password: server.credential,
          relayType: secure ? "TurnTls" : transport === "tcp" ? "TurnTcp" : "TurnUdp",
        });
      }
    }
  }
  return out;
}

// ===========================================================================
// node-datachannel surface — minimal local typing of the parts we use.
// ===========================================================================

type NativeDescriptionType = "offer" | "answer" | "pranswer" | "rollback";

interface NativeDataChannelInit {
  protocol?: string;
  negotiated?: boolean;
  id?: number;
  ordered?: boolean;
}

interface NativeDataChannel {
  getLabel(): string;
  isOpen(): boolean;
  close(): void;
  sendMessageBinary(buffer: Buffer): boolean;
  bufferedAmount(): number;
  setBufferedAmountLowThreshold(newSize: number): void;
  maxMessageSize(): number;
  onOpen(cb: () => void): void;
  onClosed(cb: () => void): void;
  onError(cb: (error: string) => void): void;
  onMessage(cb: (message: Buffer | string) => void): void;
  onBufferedAmountLow(cb: () => void): void;
}

interface NativeCandidateInfo {
  type: string;
}

interface NativeCertificateFingerprint {
  value: string;
  algorithm: "sha-1" | "sha-224" | "sha-256" | "sha-384" | "sha-512" | "md5" | "md2";
}

interface NativePeerConnection {
  close(): void;
  setLocalDescription(type?: NativeDescriptionType): void;
  setRemoteDescription(sdp: string, type: NativeDescriptionType): void;
  addRemoteCandidate(candidate: string, mid: string): void;
  createDataChannel(label: string, config?: NativeDataChannelInit): NativeDataChannel;
  onLocalDescription(cb: (sdp: string, type: string) => void): void;
  onLocalCandidate(cb: (candidate: string, mid: string) => void): void;
  onStateChange(cb: (state: string) => void): void;
  // ICE-transport state transitions (checking → connected → completed, and a
  // disconnected → connected cycle on a NAT rebind). libdatachannel has no
  // dedicated "selected candidate pair changed" event, so we poll the selected
  // pair on these transitions to surface a late nomination or a host→relay switch.
  onIceStateChange?(cb: (state: string) => void): void;
  state(): string;
  getSelectedCandidatePair(): { local: NativeCandidateInfo; remote: NativeCandidateInfo } | null;
  remoteFingerprint(): NativeCertificateFingerprint;
}

interface NativePeerConnectionCtor {
  new (peerName: string, config: Record<string, unknown>): NativePeerConnection;
}

interface NodeDatachannelModule {
  PeerConnection: NativePeerConnectionCtor;
  cleanup?: () => void;
}

let cachedModule: NodeDatachannelModule | null = null;

/**
 * Tear down libdatachannel's process-global callback/runtime state before the
 * Electron Node environment exits. Closing individual peers is not sufficient:
 * the addon otherwise tries to release N-API callback handles during teardown.
 */
export function cleanupNodeDatachannel(): void {
  const mod = cachedModule;
  cachedModule = null;
  mod?.cleanup?.();
}

/**
 * Load the native addon lazily and fail loud if absent. The `require` is reached
 * through `createRequire`. Bundled entrypoints inject `__filename`; unbundled
 * ESM tests use this module's URL. This keeps the native addon lazy without
 * relying on esbuild's dynamic-require compatibility shim.
 */
function loadNodeDatachannel(): NodeDatachannelModule {
  if (cachedModule) return cachedModule;
  try {
    const runtimeRequire = createRequire(
      typeof __filename === "string" && __filename ? __filename : import.meta.url
    );
    const mod = runtimeRequire("node-datachannel") as Partial<NodeDatachannelModule>;
    if (typeof mod?.PeerConnection !== "function") {
      throw new Error("module did not export a PeerConnection constructor");
    }
    cachedModule = mod as NodeDatachannelModule;
    return cachedModule;
  } catch (cause) {
    throw new Error(
      "node-datachannel native module is unavailable. Add 'node-datachannel' to " +
        "dependencies + pnpm.onlyBuiltDependencies and ensure its prebuilt .node is " +
        "unpacked from the asar (see docs/webrtc-native-packaging.md). Cause: " +
        ((cause as Error)?.message ?? String(cause))
    );
  }
}

// ===========================================================================
// Wrappers — map the native single-handler surface onto the contract.
// ===========================================================================

class WrappedDataChannel implements RtcDataChannelLike {
  readonly label: string;
  private state: RtcDataChannelState;
  private lowThreshold = 0;
  private readonly openFanout = new Fanout<[]>();
  private readonly closeFanout = new Fanout<[]>();
  private readonly errorFanout = new Fanout<[Error]>();
  private readonly messageFanout = new Fanout<[Uint8Array]>();
  private readonly lowFanout = new Fanout<[]>();

  constructor(
    private readonly dc: NativeDataChannel,
    knownLabel: string
  ) {
    this.label = knownLabel;
    this.state = dc.isOpen() ? "open" : "connecting";
    // Register exactly one native handler per event; fan out to N listeners.
    dc.onOpen(() => {
      this.state = "open";
      this.openFanout.emit();
    });
    dc.onClosed(() => {
      this.state = "closed";
      this.closeFanout.emit();
    });
    dc.onError((error) => this.errorFanout.emit(new Error(error)));
    dc.onMessage((message) => this.messageFanout.emit(fromNodeMessage(message)));
    dc.onBufferedAmountLow(() => this.lowFanout.emit());
  }

  get readyState(): RtcDataChannelState {
    return this.state;
  }

  get bufferedAmount(): number {
    return this.dc.bufferedAmount();
  }

  get bufferedAmountLowThreshold(): number {
    return this.lowThreshold;
  }

  set bufferedAmountLowThreshold(value: number) {
    this.lowThreshold = value;
    this.dc.setBufferedAmountLowThreshold(value);
  }

  get maxMessageSize(): number {
    // libdatachannel reports 262144 (256 KB) — the chunk cap the bulk channel honors.
    return this.dc.maxMessageSize();
  }

  send(data: Uint8Array): void {
    const sent = this.dc.sendMessageBinary(toNodeBuffer(data));
    if (!sent) throw new Error(`data channel '${this.label}' rejected ${data.byteLength} bytes`);
  }

  close(): void {
    if (this.state !== "closed") this.state = "closing";
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
  private readonly stateFanout = new Fanout<[RtcConnectionState]>();
  private readonly localDescFanout = new Fanout<[RtcSessionDescription]>();
  private readonly localCandFanout = new Fanout<[RtcIceCandidate]>();
  private readonly candidateTypeFanout = new Fanout<[RtcCandidateType | null]>();
  // Last SDP passed to setRemoteDescription — cached so remoteFingerprint() can
  // parse the a=fingerprint line even when this binding exposes neither a native
  // remoteFingerprint() nor a remoteDescription() accessor (node-datachannel 0.32).
  private remoteSdp: string | null = null;
  // Last candidate type handed to candidateTypeFanout — de-dupes the poll so only
  // genuine transitions surface (`undefined` = nothing emitted yet, distinct from
  // an emitted `null`).
  private lastEmittedCandidateType: RtcCandidateType | null | undefined = undefined;

  constructor(private readonly pc: NativePeerConnection) {
    pc.onStateChange((raw) => {
      this.stateFanout.emit(normalizeConnectionState(raw));
      // The aggregate connection state reaching 'connected' is the latest a pair
      // can be nominated, so poll here too (covers bindings without onIceStateChange).
      this.pollSelectedCandidate();
    });
    // libdatachannel exposes no candidate-pair-changed event; the ICE-state
    // transitions are the closest signal. Poll the selected pair on each so a late
    // nomination or a mid-connection host→relay switch actually surfaces (§9.8).
    pc.onIceStateChange?.(() => this.pollSelectedCandidate());
    pc.onLocalDescription((sdp, type) =>
      this.localDescFanout.emit({ sdp, type: type === "answer" ? "answer" : "offer" })
    );
    pc.onLocalCandidate((candidate, mid) =>
      this.localCandFanout.emit({ candidate, sdpMid: mid, sdpMLineIndex: null })
    );
  }

  /** Read the current selected-pair type and emit it iff it changed (de-duped).
   * Skipped when nobody is listening so it never touches the native accessor for
   * no reason. */
  private pollSelectedCandidate(): void {
    if (this.candidateTypeFanout.size === 0) return;
    const type = this.selectedCandidateType();
    if (type === this.lastEmittedCandidateType) return;
    this.lastEmittedCandidateType = type;
    this.candidateTypeFanout.emit(type);
  }

  createDataChannel(label: string, init?: RtcDataChannelInit): RtcDataChannelLike {
    const dc = this.pc.createDataChannel(label, {
      ordered: init?.ordered ?? true,
      negotiated: init?.negotiated ?? false,
      id: init?.id,
    });
    return new WrappedDataChannel(dc, label);
  }

  // libdatachannel fuses creation with setLocalDescription and delivers the real
  // SDP via onLocalDescription; createOffer/createAnswer only declare intent. The
  // transport forwards this marker straight to setLocalDescription and never reads
  // `.sdp`, so a degenerate body is correct.
  createOffer(): Promise<RtcSessionDescription> {
    return Promise.resolve({ type: "offer", sdp: "" });
  }

  createAnswer(): Promise<RtcSessionDescription> {
    return Promise.resolve({ type: "answer", sdp: "" });
  }

  setLocalDescription(desc?: RtcSessionDescription): Promise<void> {
    // This is the call that makes libdatachannel gather + emit the local SDP.
    this.pc.setLocalDescription(desc?.type as NativeDescriptionType | undefined);
    return Promise.resolve();
  }

  setRemoteDescription(desc: RtcSessionDescription): Promise<void> {
    // Cache before handing to the native peer so remoteFingerprint() can read the
    // a=fingerprint line back regardless of which accessors this binding exposes.
    this.remoteSdp = desc.sdp;
    this.pc.setRemoteDescription(desc.sdp, desc.type);
    return Promise.resolve();
  }

  addRemoteCandidate(candidate: RtcIceCandidate): Promise<void> {
    // Single data-channel m-line ⇒ mid defaults to "0" when signaling omits it.
    this.pc.addRemoteCandidate(candidate.candidate, candidate.sdpMid ?? "0");
    return Promise.resolve();
  }

  remoteFingerprint(): string | null {
    try {
      const raw = this.pc.remoteFingerprint();
      if (
        !raw ||
        typeof raw !== "object" ||
        raw.algorithm !== "sha-256" ||
        typeof raw.value !== "string"
      ) {
        throw new Error("node-datachannel returned an invalid remote-fingerprint shape");
      }
      const canonical = canonicalizeFingerprint(raw.value);
      if (!canonical) {
        throw new Error("node-datachannel returned an invalid SHA-256 remote fingerprint");
      }
      return canonical;
    } catch (error) {
      // A native accessor can throw before/while DTLS settles. The SDP cached
      // through this same wrapper is still authenticated by libdatachannel once
      // connected, so it is the safe runtime-error fallback. Contract-shape
      // errors raised above must remain loud.
      if (error instanceof Error && error.message.startsWith("node-datachannel returned")) {
        throw error;
      }
    }
    // Parse the a=fingerprint:sha-256 line from the remote SDP cached at
    // setRemoteDescription. Sound because by the time DTLS is 'connected'
    //    libdatachannel has verified the live cert matches that line, so the
    //    value still detects a signaling-MITM cert swap against the pin (§6.1).
    //    Null (no SDP / no fingerprint line) makes the transport wait — it never
    //    completes an unpinned pipe — which is the correct fail-closed default.
    return this.remoteSdp ? parseSdpFingerprint(this.remoteSdp) : null;
  }

  selectedCandidateType(): RtcCandidateType | null {
    try {
      return candidateTypeFromPair(this.pc.getSelectedCandidatePair());
    } catch (error) {
      // The native accessor can throw transiently while ICE state changes. Do
      // not crash the connected-state callback, but never mask API-shape drift.
      if (error instanceof Error && error.message.startsWith("node-datachannel returned")) {
        throw error;
      }
      return null;
    }
  }

  onSelectedCandidateChange(handler: (type: RtcCandidateType | null) => void): () => void {
    return this.candidateTypeFanout.add(handler);
  }

  get connectionState(): RtcConnectionState {
    return normalizeConnectionState(this.pc.state());
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
    this.pc.close();
  }
}
