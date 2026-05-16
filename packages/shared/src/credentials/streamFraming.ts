/**
 * Binary frame codec for streaming proxy fetches.
 *
 * Wire format: length-prefixed frames, each
 *
 *   [1 byte: type] [4 bytes: payload length, big-endian uint32] [payload]
 *
 * Frame types:
 *   - 0x01 HEAD   payload = utf-8 JSON `{ status, statusText, headerPairs, finalUrl }`
 *   - 0x02 DATA   payload = raw response body bytes (binary-safe)
 *   - 0x03 END    payload = utf-8 JSON `{ bytesIn }` (or empty)
 *   - 0x04 ERROR  payload = utf-8 JSON `{ status, message, code? }`
 *
 * The framing is length-prefixed (rather than newline-delimited like
 * NDJSON) so binary DATA frames carry raw bytes — no base64 overhead.
 * Length is a uint32, capping individual frames at 4 GiB which is more
 * than enough for any sane HTTP chunk size.
 */

export const FRAME_HEAD = 0x01 as const;
export const FRAME_DATA = 0x02 as const;
export const FRAME_END = 0x03 as const;
export const FRAME_ERROR = 0x04 as const;

export type FrameType =
  | typeof FRAME_HEAD
  | typeof FRAME_DATA
  | typeof FRAME_END
  | typeof FRAME_ERROR;

export interface HeadFramePayload {
  status: number;
  statusText: string;
  headerPairs: Array<[string, string]>;
  finalUrl: string;
}

export interface EndFramePayload {
  bytesIn: number;
}

export interface ErrorFramePayload {
  status: number;
  message: string;
  code?: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Encode a single frame to a Uint8Array. */
export function encodeFrame(type: FrameType, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.byteLength);
  frame[0] = type;
  const len = payload.byteLength;
  // Big-endian uint32 length.
  frame[1] = (len >>> 24) & 0xff;
  frame[2] = (len >>> 16) & 0xff;
  frame[3] = (len >>> 8) & 0xff;
  frame[4] = len & 0xff;
  frame.set(payload, 5);
  return frame;
}

export function encodeHeadFrame(payload: HeadFramePayload): Uint8Array {
  return encodeFrame(FRAME_HEAD, textEncoder.encode(JSON.stringify(payload)));
}

export function encodeDataFrame(bytes: Uint8Array): Uint8Array {
  return encodeFrame(FRAME_DATA, bytes);
}

export function encodeEndFrame(payload: EndFramePayload): Uint8Array {
  return encodeFrame(FRAME_END, textEncoder.encode(JSON.stringify(payload)));
}

export function encodeErrorFrame(payload: ErrorFramePayload): Uint8Array {
  return encodeFrame(FRAME_ERROR, textEncoder.encode(JSON.stringify(payload)));
}

/**
 * Streaming frame decoder. Feed chunks via `push`; receive completed
 * frames via the `onFrame` callback. Partial frames are buffered
 * internally across `push` calls so the caller can pass arbitrary HTTP
 * chunk boundaries through without thinking about frame alignment.
 */
export class FrameDecoder {
  private buf = new Uint8Array(0);

  constructor(
    private readonly onFrame: (type: FrameType, payload: Uint8Array) => void | Promise<void>,
  ) {}

  async push(chunk: Uint8Array): Promise<void> {
    if (chunk.byteLength === 0) return;
    // Append the new chunk to whatever's left from the previous push.
    const next = new Uint8Array(this.buf.byteLength + chunk.byteLength);
    next.set(this.buf, 0);
    next.set(chunk, this.buf.byteLength);
    this.buf = next;
    await this.drain();
  }

  /** Returns true if all received bytes have been consumed as whole frames. */
  finished(): boolean {
    return this.buf.byteLength === 0;
  }

  private async drain(): Promise<void> {
    while (this.buf.byteLength >= 5) {
      const type = this.buf[0] as FrameType;
      const len =
        ((this.buf[1] ?? 0) << 24) |
        ((this.buf[2] ?? 0) << 16) |
        ((this.buf[3] ?? 0) << 8) |
        (this.buf[4] ?? 0);
      const total = 5 + len;
      if (this.buf.byteLength < total) {
        // Not enough bytes yet for the full payload; wait for next push.
        return;
      }
      const payload = this.buf.slice(5, total);
      this.buf = this.buf.slice(total);
      await this.onFrame(type, payload);
    }
  }
}

export function parseHeadFrame(payload: Uint8Array): HeadFramePayload {
  return JSON.parse(textDecoder.decode(payload)) as HeadFramePayload;
}

export function parseEndFrame(payload: Uint8Array): EndFramePayload {
  if (payload.byteLength === 0) return { bytesIn: 0 };
  return JSON.parse(textDecoder.decode(payload)) as EndFramePayload;
}

export function parseErrorFrame(payload: Uint8Array): ErrorFramePayload {
  return JSON.parse(textDecoder.decode(payload)) as ErrorFramePayload;
}
