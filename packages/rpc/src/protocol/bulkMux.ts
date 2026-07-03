/**
 * Bulk-channel message mux (wire protocol v2, plan §1.2) — replaces the v1
 * byte-stream codec outright.
 *
 * The old design framed a byte stream (`[streamId:4][type:1][len:4][payload]`)
 * and chunked it blindly, so a frame's chunks had to stay contiguous on the
 * wire and the decoder reassembled by offset with an O(n)-concat residual
 * buffer — which is why every stream serialized through one FIFO write chain.
 * v2 exploits that SCTP DataChannels are **message-oriented**: every channel
 * message is one complete, self-describing mux unit, so DATA needs no
 * reassembly at all and messages from different streams interleave freely
 * (the round-robin scheduler in `transports/frameScheduler.ts` relies on this).
 *
 * Wire shape of one channel message:
 *
 * ```
 * [streamId: u32 BE][flags: u8][payload …]
 *    flags & 0x07 : frame type — FRAME_HEAD(1) / FRAME_DATA(2) / FRAME_END(3)
 *                   / FRAME_ERROR(4), the existing streamCodec constants
 *    flags & 0x08 : MORE — continuation, valid ONLY on HEAD and ERROR (their
 *                   JSON can exceed one message); a frame is complete when a
 *                   message with MORE unset arrives
 *    flags & ~0x0F: must be zero — unknown bits are a protocol violation
 * ```
 *
 * Violations THROW `BulkProtocolViolation` (fail-loud rule): the transport
 * turns it into pipe-down rather than best-effort tolerance — a peer speaking
 * a different dialect must fail loud, not corrupt streams silently.
 */

import {
  FRAME_DATA,
  FRAME_END,
  FRAME_ERROR,
  FRAME_HEAD,
  type FrameType,
} from "./streamCodec.js";

/** The frame-type vocabulary is the existing streamCodec one — no second set. */
export type StreamFrameType = FrameType;

/** `[streamId: u32 BE][flags: u8]` */
export const BULK_MUX_HEADER_BYTES = 5;

/** Continuation flag — the frame's payload continues in the next message. */
export const MUX_FLAG_MORE = 0x08;

const MUX_TYPE_MASK = 0x07;
const MUX_KNOWN_BITS = 0x0f;

/**
 * Cap on the bytes a single continued HEAD/ERROR may accumulate before the
 * final (MORE unset) message. A conforming peer sends a few KB of JSON; a
 * broken or hostile one must fail loud instead of ballooning the receiver.
 */
export const BULK_MUX_ACCUMULATION_CAP_BYTES = 4 * 1024 * 1024;

/**
 * A peer violated the bulk mux protocol. The transport treats this as
 * pipe-down (plan §1.2: "unknown flag bits: protocol violation → pipe down").
 */
export class BulkProtocolViolation extends Error {
  readonly code = "BULK_PROTOCOL_VIOLATION";
  constructor(message: string) {
    super(message);
    this.name = "BulkProtocolViolation";
  }
}

function isValidFrameType(type: number): type is StreamFrameType {
  return type >= FRAME_HEAD && type <= FRAME_ERROR;
}

/**
 * Encode one complete bulk-channel message. `payload` must already be sized
 * under the negotiated chunk limit minus `BULK_MUX_HEADER_BYTES` — the mux
 * does not split; oversized HEAD/ERROR JSON is the *caller's* job to continue
 * via `more` messages. Encoding MORE on DATA/END throws (never put an
 * unparseable message on the wire).
 */
export function encodeBulkMessage(
  streamId: number,
  type: StreamFrameType,
  payload: Uint8Array,
  more = false,
): Uint8Array {
  if (more && (type === FRAME_DATA || type === FRAME_END)) {
    throw new BulkProtocolViolation(
      `MORE flag is only valid on HEAD/ERROR frames (got type 0x${type.toString(16)})`,
    );
  }
  const message = new Uint8Array(BULK_MUX_HEADER_BYTES + payload.byteLength);
  const id = streamId >>> 0;
  message[0] = (id >>> 24) & 0xff;
  message[1] = (id >>> 16) & 0xff;
  message[2] = (id >>> 8) & 0xff;
  message[3] = id & 0xff;
  message[4] = type | (more ? MUX_FLAG_MORE : 0);
  message.set(payload, BULK_MUX_HEADER_BYTES);
  return message;
}

export interface DecodedBulkMessage {
  streamId: number;
  type: StreamFrameType;
  more: boolean;
  /**
   * A subarray VIEW into `message` (zero-copy) — valid only as long as the
   * caller's buffer is; copy (`payload.slice()`) before retaining it past the
   * current message (transports may reuse receive buffers).
   */
  payload: Uint8Array;
}

/**
 * Decode one channel message. Throws `BulkProtocolViolation` on any malformed
 * input: short message, type bits outside 1..4, unknown flag bits, or MORE on
 * a DATA/END frame.
 */
export function decodeBulkMessage(message: Uint8Array): DecodedBulkMessage {
  if (message.byteLength < BULK_MUX_HEADER_BYTES) {
    throw new BulkProtocolViolation(
      `bulk message shorter than the ${BULK_MUX_HEADER_BYTES}-byte header (${message.byteLength} bytes)`,
    );
  }
  const streamId =
    (((message[0] ?? 0) << 24) |
      ((message[1] ?? 0) << 16) |
      ((message[2] ?? 0) << 8) |
      (message[3] ?? 0)) >>>
    0;
  const flags = message[4] ?? 0;
  if ((flags & ~MUX_KNOWN_BITS) !== 0) {
    throw new BulkProtocolViolation(
      `unknown bulk flag bits 0x${(flags & ~MUX_KNOWN_BITS).toString(16)} (flags 0x${flags.toString(16)})`,
    );
  }
  const type = flags & MUX_TYPE_MASK;
  if (!isValidFrameType(type)) {
    throw new BulkProtocolViolation(`invalid bulk frame type 0x${type.toString(16)}`);
  }
  const more = (flags & MUX_FLAG_MORE) !== 0;
  if (more && (type === FRAME_DATA || type === FRAME_END)) {
    throw new BulkProtocolViolation(
      `MORE flag set on ${type === FRAME_DATA ? "DATA" : "END"} frame (stream ${streamId})`,
    );
  }
  return { streamId, type, more, payload: message.subarray(BULK_MUX_HEADER_BYTES) };
}

export interface BulkDemux {
  /**
   * Feed one inbound channel message. Emits `onFrame` zero or more times
   * synchronously. Throws `BulkProtocolViolation` to the caller on any
   * malformed message — the transport turns that into pipe-down (fail loud).
   */
  push(message: Uint8Array): void;
  /** Drop all partial HEAD/ERROR accumulations (call on reconnect — a fresh
   * pipe's continuations must never concatenate onto a dead pipe's partials). */
  reset(): void;
}

/**
 * Receive-side demux for the bulk channel.
 *
 * - DATA and END emit immediately per message. DATA payloads are raw stream
 *   bytes — there is no "frame" to reassemble by design (§1.2); END's payload
 *   passes through (typically empty).
 * - HEAD and ERROR with MORE accumulate per streamId until the final (MORE
 *   unset) message, then emit the concatenated JSON payload once. Accumulation
 *   is capped at `BULK_MUX_ACCUMULATION_CAP_BYTES` per stream.
 * - While a stream has a partial HEAD/ERROR, any message for that stream of a
 *   *different* type is a protocol violation (the sender interleaved inside
 *   its own continuation — its frame can never complete).
 *
 * Payloads handed to `onFrame` from single-message frames are subarray views
 * into the pushed message (valid during the callback; copy to retain);
 * reassembled payloads are freshly allocated and caller-owned.
 */
export function createBulkDemux(
  onFrame: (streamId: number, type: StreamFrameType, payload: Uint8Array) => void,
): BulkDemux {
  // Partial HEAD/ERROR continuations, keyed by streamId.
  let pending = new Map<number, { type: StreamFrameType; chunks: Uint8Array[]; bytes: number }>();
  return {
    push(message: Uint8Array): void {
      const { streamId, type, more, payload } = decodeBulkMessage(message);
      const partial = pending.get(streamId);
      if (partial && partial.type !== type) {
        pending.delete(streamId);
        throw new BulkProtocolViolation(
          `frame type 0x${type.toString(16)} interleaved inside a continued 0x${partial.type.toString(16)} (stream ${streamId})`,
        );
      }
      if (!partial && !more) {
        // Whole frame in one message — the common case for every type.
        onFrame(streamId, type, payload);
        return;
      }
      const entry = partial ?? { type, chunks: [], bytes: 0 };
      entry.bytes += payload.byteLength;
      if (entry.bytes > BULK_MUX_ACCUMULATION_CAP_BYTES) {
        pending.delete(streamId);
        throw new BulkProtocolViolation(
          `continued ${type === FRAME_HEAD ? "HEAD" : "ERROR"} exceeds ${BULK_MUX_ACCUMULATION_CAP_BYTES} bytes (stream ${streamId})`,
        );
      }
      // Copy: continuation chunks are held across messages until the set completes.
      entry.chunks.push(payload.slice());
      if (more) {
        pending.set(streamId, entry);
        return;
      }
      pending.delete(streamId);
      const out = new Uint8Array(entry.bytes);
      let offset = 0;
      for (const chunk of entry.chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      onFrame(streamId, type, out);
    },
    reset(): void {
      pending = new Map();
    },
  };
}
