export const LENGTH_PREFIX_BYTES = 4;

export interface FrameSendStream {
  writeAll(bytes: number[]): Promise<void>;
}

export interface FrameReceiveStream {
  readExact(length: number): Promise<number[]>;
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
