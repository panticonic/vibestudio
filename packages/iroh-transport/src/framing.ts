export const LENGTH_PREFIX_BYTES = 4;

export interface FrameSendStream {
  writeAll(bytes: number[]): Promise<void>;
}

export interface FrameReceiveStream {
  readExact(length: number): Promise<number[]>;
}

export interface ChunkReceiveStream {
  read(maximumBytes: number): Promise<number[]>;
}

export class FrameLimitError extends Error {
  constructor(
    readonly declaredBytes: number,
    readonly maximumBytes: number
  ) {
    super(`Iroh frame declares ${declaredBytes} bytes; maximum is ${maximumBytes}`);
    this.name = "FrameLimitError";
  }
}

export function encodeLengthPrefix(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0xffff_ffff) {
    throw new Error("Iroh frame length must be an unsigned 32-bit integer");
  }
  const prefix = new Uint8Array(LENGTH_PREFIX_BYTES);
  new DataView(prefix.buffer).setUint32(0, length, false);
  return prefix;
}

export async function writeFrame(
  stream: FrameSendStream,
  payload: Uint8Array,
  maximumBytes: number
): Promise<void> {
  if (payload.byteLength > maximumBytes) {
    throw new FrameLimitError(payload.byteLength, maximumBytes);
  }
  await stream.writeAll([...encodeLengthPrefix(payload.byteLength)]);
  if (payload.byteLength > 0) await stream.writeAll([...payload]);
}

export async function readFrame(
  stream: FrameReceiveStream,
  maximumBytes: number
): Promise<Uint8Array> {
  const prefix = Uint8Array.from(await stream.readExact(LENGTH_PREFIX_BYTES));
  const declaredBytes = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(
    0,
    false
  );
  if (declaredBytes > maximumBytes) throw new FrameLimitError(declaredBytes, maximumBytes);
  if (declaredBytes === 0) return new Uint8Array();
  return Uint8Array.from(await stream.readExact(declaredBytes));
}

/**
 * Read one payload whose boundary is the QUIC send-stream FIN. Unlike a
 * length-prefixed control/header frame, this deliberately has no total-size
 * ceiling: flow control and the consumer's request lifetime provide
 * backpressure while the sender remains free to return a large result.
 */
export async function readToEnd(
  stream: ChunkReceiveStream,
  chunkBytes: number
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new Error("Iroh read chunk size must be a positive safe integer");
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const chunk = Uint8Array.from(await stream.read(chunkBytes));
    if (chunk.byteLength === 0) break;
    totalBytes += chunk.byteLength;
    if (!Number.isSafeInteger(totalBytes))
      throw new Error("Iroh payload exceeds addressable memory");
    chunks.push(chunk);
  }
  const payload = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return payload;
}

/** Write without manufacturing one payload-sized JavaScript number array. */
export async function writeChunked(
  stream: FrameSendStream,
  payload: Uint8Array,
  chunkBytes: number
): Promise<void> {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new Error("Iroh write chunk size must be a positive safe integer");
  }
  for (let offset = 0; offset < payload.byteLength; offset += chunkBytes) {
    await stream.writeAll([
      ...payload.subarray(offset, Math.min(payload.byteLength, offset + chunkBytes)),
    ]);
  }
}
