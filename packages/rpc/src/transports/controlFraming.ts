/**
 * Control-channel message framing for the WebRTC pipe.
 *
 * react-native-webrtc corrupts data-channel messages larger than ~16 KiB
 * (RFC 8831 §6.6 leaves >16 KiB fragmentation implementation-defined, and RN's
 * SCTP layer truncates/garbles them). The BULK channel already chunks via the v2
 * stream codec, but the CONTROL channel sent each `SessionControlFrame` as one
 * message — so any RPC envelope larger than the cap (a big `ls`, a large JSON
 * result, an event with a fat payload) was silently corrupted on mobile.
 *
 * This adds size-bounded fragmentation to the control channel. Every message
 * carries a 1-byte tag: a frame that fits is sent WHOLE; a larger frame splits
 * into ordered FRAGMENTs the peer reassembles by frame id. The channel is SCTP
 * ordered+reliable, so fragments arrive in order and none are dropped — no
 * retransmit/timeout machinery is needed (and per [[fail-loud-no-masking]] none
 * is added to paper over a lost fragment that the reliable channel cannot lose).
 *
 * Symmetric: both pipe ends (offerer `webrtcClient`, answerer `webrtcAnswerer`)
 * frame on send and defragment on receive.
 *
 * Eviction is still deliberately ABSENT: an incomplete fragment set is held until
 * it completes (a reliable ordered channel cannot half-deliver one), and reset()
 * drops all in-flight sets on reconnect. The `maxPendingSets`/`maxBufferedBytes`
 * caps below are NOT eviction — they are a protocol-violation tripwire that bounds
 * a broken/hostile peer's memory damage. A conforming peer never approaches them;
 * a peer that breaches one throws {@link ControlProtocolViolation}, which the
 * transport catches to drop the pipe.
 */

const TAG_WHOLE = 0x00;
const TAG_FRAGMENT = 0x01;
/**
 * A whole frame carrying the sender's monotonic frame id: `[tag:1][seq:u32][payload]`.
 *
 * The module header below asserts that the ordered+reliable control channel
 * cannot lose a message. That is true of SCTP and false of the layer above it:
 * react-native-webrtc drops whole messages out of a burst, which is already
 * documented on the bulk path (webrtcAnswerer's MOBILE_BULK_LOW_WATER) and was
 * then measured here — a `stream-open` vanished, the server never saw the
 * request at all, and the client sat out its 20s head budget with nothing
 * logged anywhere near the transport.
 *
 * Fragments already carry a monotonic frame id, so only WHOLE messages were
 * unaccounted for. This tag closes that gap so a lost control message is
 * detected at the receiver instead of surfacing as an unexplained timeout.
 *
 * Negotiated (hello `ctrlSeq`): an un-upgraded peer's defragmenter returns null
 * for an unknown tag — silently dropping the frame — so this must never be sent
 * to one.
 */
const TAG_WHOLE_SEQ = 0x02;
/** [tag:1][frameId:u32][index:u16][total:u16] */
const FRAGMENT_HEADER = 9;
/** [tag:1][seq:u32] */
const WHOLE_SEQ_HEADER = 5;

/** Default cap on concurrently-pending (incomplete) fragment sets per pipe. */
const DEFAULT_MAX_PENDING_SETS = 32;
/** Default cap on total buffered fragment bytes across all pending sets (64 MiB). */
const DEFAULT_MAX_BUFFERED_BYTES = 64 * 1024 * 1024;

export interface ControlDefragmenterOptions {
  /** Max concurrently-pending fragment sets before a protocol violation (default 32). */
  maxPendingSets?: number;
  /** Max total buffered fragment bytes across all pending sets (default 64 MiB). */
  maxBufferedBytes?: number;
  /**
   * A sequenced control message did not follow its predecessor: `missing`
   * messages were lost between the sender and here.
   *
   * The control channel carries `stream-open`, so losing one message means a
   * request the peer believes it made was never received — which surfaces only
   * as that request's timeout, far from the transport, with both ends looking
   * healthy. Reported rather than thrown so the owner decides; the frames are
   * gone either way.
   */
  onSequenceGap?: (expected: number, received: number, missing: number) => void;
}

/**
 * A peer sent a control-channel stream that a conforming peer cannot produce:
 * more pending fragment sets, or more total buffered fragment bytes, than the
 * defragmenter's caps allow. This is not eviction — it is a fail-loud tripwire
 * on a broken/hostile peer. The transport catches it and drops the pipe.
 */
export class ControlProtocolViolation extends Error {
  readonly code = "CONTROL_PROTOCOL_VIOLATION" as const;
  constructor(message: string) {
    super(message);
    this.name = "ControlProtocolViolation";
  }
}

/**
 * Split an encoded control frame into one or more channel messages, each within
 * `maxMessageSize`. A frame that fits is sent whole (1-byte tag overhead);
 * larger frames become `ceil(len / chunkMax)` ordered fragments tagged with
 * `frameId` so interleaved fragment sets stay distinct on the ordered channel.
 */
export function frameControlMessage(
  frameBytes: Uint8Array,
  maxMessageSize: number,
  frameId: number,
  withSequence = false
): Uint8Array[] {
  if (withSequence && frameBytes.byteLength + WHOLE_SEQ_HEADER <= maxMessageSize) {
    const whole = new Uint8Array(WHOLE_SEQ_HEADER + frameBytes.byteLength);
    whole[0] = TAG_WHOLE_SEQ;
    // Left zero here and written by `stampControlSequence` at send. The control
    // scheduler round-robins across lanes, so the order frames are BUILT in is
    // not the order they reach the wire — numbering at encode time would make a
    // healthy pipe look like it was dropping messages.
    whole.set(frameBytes, WHOLE_SEQ_HEADER);
    return [whole];
  }
  if (!withSequence && frameBytes.byteLength + 1 <= maxMessageSize) {
    const whole = new Uint8Array(frameBytes.byteLength + 1);
    whole[0] = TAG_WHOLE;
    whole.set(frameBytes, 1);
    return [whole];
  }
  const chunkMax = Math.max(1, maxMessageSize - FRAGMENT_HEADER);
  const total = Math.ceil(frameBytes.byteLength / chunkMax);
  if (total > 0xffff) {
    throw new Error(
      `control frame too large to fragment (${frameBytes.byteLength} bytes at chunk ${chunkMax})`
    );
  }
  const id = frameId >>> 0;
  const parts: Uint8Array[] = [];
  for (let index = 0; index < total; index++) {
    const start = index * chunkMax;
    const chunk = frameBytes.subarray(start, Math.min(start + chunkMax, frameBytes.byteLength));
    const part = new Uint8Array(FRAGMENT_HEADER + chunk.byteLength);
    const view = new DataView(part.buffer);
    part[0] = TAG_FRAGMENT;
    view.setUint32(1, id);
    view.setUint16(5, index);
    view.setUint16(7, total);
    part.set(chunk, FRAGMENT_HEADER);
    parts.push(part);
  }
  return parts;
}

/**
 * Write the wire sequence into an encoded whole control message immediately
 * before it is handed to the channel. No-op for any other message shape —
 * fragments keep their own frame id for reassembly and consume no sequence, so
 * the whole-message sequence stays contiguous whether or not large frames are
 * interleaved with small ones.
 */
export function stampControlSequence(message: Uint8Array, sequence: number): void {
  if (message.byteLength < WHOLE_SEQ_HEADER) return;
  if (message[0] !== TAG_WHOLE_SEQ) return;
  new DataView(message.buffer, message.byteOffset, message.byteLength).setUint32(
    1,
    sequence >>> 0
  );
}

/** True when this encoded control message carries a wire sequence. */
export function isSequencedControlMessage(message: Uint8Array): boolean {
  return message.byteLength >= WHOLE_SEQ_HEADER && message[0] === TAG_WHOLE_SEQ;
}

export interface ControlDefragmenter {
  /**
   * Returns the complete frame bytes for a whole message or for the final
   * fragment of a set; returns `null` while a fragment set is still incomplete
   * (or the message is malformed and dropped).
   */
  accept(message: Uint8Array): Uint8Array | null;
  /** Drop all in-flight fragment sets (call on reconnect — a new pipe's first
   * fragments must never reassemble against a dead pipe's leftovers). */
  reset(): void;
}

export function createControlDefragmenter(
  options?: ControlDefragmenterOptions
): ControlDefragmenter {
  // Incomplete fragment sets are retained here until they complete. On the SCTP
  // ordered+reliable control channel a set never half-arrives, and reset() drops
  // all in-flight sets on reconnect — so there is deliberately no eviction/timeout
  // (adding one would mask a "lost" fragment the reliable channel cannot lose; see
  // the module header). The caps below are a protocol-violation tripwire, NOT
  // eviction: they bound a broken/hostile peer's memory damage, and a conforming
  // peer never hits them.
  const maxPendingSets = options?.maxPendingSets ?? DEFAULT_MAX_PENDING_SETS;
  const maxBufferedBytes = options?.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  let pending = new Map<number, { chunks: Uint8Array[]; received: number; total: number }>();
  // Frame id of the last sequenced message accepted, for gap detection. Only
  // set by peers that negotiated `ctrlSeq`; unsequenced traffic leaves it null.
  let lastSequence: number | null = null;
  const observeSequence = (seq: number): void => {
    if (lastSequence !== null && seq !== ((lastSequence + 1) >>> 0)) {
      // Unsigned so the check survives the u32 wrap.
      options?.onSequenceGap?.((lastSequence + 1) >>> 0, seq, (seq - lastSequence - 1) >>> 0);
    }
    lastSequence = seq;
  };
  // Total buffered fragment bytes across every pending set (whole messages and
  // completed sets do not count — their bytes leave the buffer immediately).
  let bufferedBytes = 0;
  return {
    accept(message) {
      if (message.byteLength < 1) return null;
      const tag = message[0];
      if (tag === TAG_WHOLE_SEQ) {
        if (message.byteLength < WHOLE_SEQ_HEADER) return null;
        const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
        observeSequence(view.getUint32(1));
        // Copy, for the same ownership reason as TAG_WHOLE below.
        return message.slice(WHOLE_SEQ_HEADER);
      }
      if (tag === TAG_WHOLE) {
        // Copy (not a view): reassembled fragment sets are already copies (below),
        // so every accept() result is owned by the caller — safe even if a transport
        // reuses its receive buffer or a caller defers the decode past this tick.
        return message.slice(1);
      }
      if (tag !== TAG_FRAGMENT || message.byteLength < FRAGMENT_HEADER) return null;
      const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
      const id = view.getUint32(1);
      const index = view.getUint16(5);
      const total = view.getUint16(7);
      if (total === 0 || index >= total) return null;
      let entry = pending.get(id);
      if (!entry) {
        // A new fragment set: fail loud if we already hold the max concurrent sets.
        if (pending.size >= maxPendingSets) {
          throw new ControlProtocolViolation(
            `control defragmenter exceeded max pending fragment sets (${maxPendingSets})`
          );
        }
        entry = { chunks: new Array(total), received: 0, total };
        pending.set(id, entry);
      }
      if (entry.total !== total || entry.chunks[index]) return null; // malformed / duplicate
      // Copy: this chunk is held across messages until the set completes.
      const incoming = message.slice(FRAGMENT_HEADER);
      // Fail loud if accepting this fragment would breach the total-bytes budget.
      if (bufferedBytes + incoming.byteLength > maxBufferedBytes) {
        throw new ControlProtocolViolation(
          `control defragmenter exceeded max buffered fragment bytes (${maxBufferedBytes})`
        );
      }
      entry.chunks[index] = incoming;
      entry.received++;
      bufferedBytes += incoming.byteLength;
      if (entry.received < entry.total) return null;
      pending.delete(id);
      let size = 0;
      for (const chunk of entry.chunks) size += chunk.byteLength;
      // The set completed and leaves the buffer — release its bytes from the budget.
      bufferedBytes -= size;
      const out = new Uint8Array(size);
      let offset = 0;
      for (const chunk of entry.chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    },
    reset() {
      pending = new Map();
      bufferedBytes = 0;
      // A new pipe numbers from the start; carrying the old high-water over
      // would report the restart itself as a gap and drop the fresh pipe.
      lastSequence = null;
    },
  };
}

export interface ControlCodec {
  /** Fragment an encoded control frame under `maxMessageSize` into one or more
   * channel messages (auto-incrementing the frame id so interleaved sets stay
   * distinct). */
  frame(bytes: Uint8Array, maxMessageSize: number): Uint8Array[];
  /** Reassemble an inbound control message; null while a fragment set is incomplete. */
  accept(message: Uint8Array): Uint8Array | null;
  /** Drop in-flight fragments (call on reconnect / re-pair). */
  reset(): void;
}

/**
 * Bundles the per-pipe control-framing state both roles carry identically: the
 * monotonic frame-id counter (for send-side fragmentation) and the reassembler (for
 * receive). Create one per pipe generation; `reset()` it (or recreate it) on
 * reconnect so a fresh pipe never reassembles against a dead pipe's fragments.
 */
export function createControlCodec(
  options?: ControlDefragmenterOptions & {
    /**
     * Emit whole messages with a wire-sequence slot (stamped at send). Read as
     * a function so the transport can flip it when the hello negotiates
     * `ctrlSeq`, without rebuilding the codec.
     */
    sequenceWholeMessages?: () => boolean;
  }
): ControlCodec {
  let seq = 0;
  const defrag = createControlDefragmenter(options);
  return {
    frame(bytes, maxMessageSize) {
      seq = (seq + 1) >>> 0;
      return frameControlMessage(
        bytes,
        maxMessageSize,
        seq,
        options?.sequenceWholeMessages?.() === true
      );
    },
    accept: (message) => defrag.accept(message),
    reset: () => defrag.reset(),
  };
}
