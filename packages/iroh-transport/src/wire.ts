import { readFrame, writeFrame, type FrameReceiveStream, type FrameSendStream } from "./framing.js";

export const IROH_WIRE_VERSION = 5 as const;
export const MAX_CONTROL_FRAME_BYTES = 64 * 1024;
export const MAX_ENVELOPE_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_STREAM_CHUNK_BYTES = 256 * 1024;
export const MAX_SESSION_ID_BYTES = 128;
export const MAX_REQUEST_ID_BYTES = 128;

/**
 * Per-connection work that is still parsing its bounded preamble and envelope.
 * Completed admission no longer occupies this budget, even when the response
 * is a long-lived watch. This is the memory/slowloris bound; the QUIC stream
 * window is deliberately a separate transport-headroom concern.
 */
export const MAX_PENDING_STREAM_ADMISSIONS = 128;

export type IrohStreamKind = "control" | "envelope" | "message" | "stream";

export type IrohStreamPreamble =
  | { k: "control"; v: typeof IROH_WIRE_VERSION }
  | { k: "envelope"; sid: string; v: typeof IROH_WIRE_VERSION }
  | { k: "message"; sid: string; v: typeof IROH_WIRE_VERSION }
  | {
      body: boolean;
      k: "stream";
      requestId: string;
      sid: string;
      v: typeof IROH_WIRE_VERSION;
    };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function utf8Length(value: string): number {
  return encoder.encode(value).byteLength;
}

function assertBoundedId(
  value: unknown,
  label: string,
  maximumBytes: number
): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || utf8Length(value) > maximumBytes) {
    throw new Error(`${label} must contain 1-${maximumBytes} UTF-8 bytes`);
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

export function encodeIrohStreamPreamble(preamble: IrohStreamPreamble): Uint8Array {
  assertIrohStreamPreamble(preamble);
  switch (preamble.k) {
    case "control":
      return encoder.encode(JSON.stringify({ k: "control", v: IROH_WIRE_VERSION }));
    case "envelope":
    case "message":
      return encoder.encode(
        JSON.stringify({ k: preamble.k, sid: preamble.sid, v: IROH_WIRE_VERSION })
      );
    case "stream":
      return encoder.encode(
        JSON.stringify({
          body: preamble.body,
          k: "stream",
          requestId: preamble.requestId,
          sid: preamble.sid,
          v: IROH_WIRE_VERSION,
        })
      );
  }
}

export function decodeIrohStreamPreamble(bytes: Uint8Array): IrohStreamPreamble {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch (error) {
    throw new Error("Invalid Iroh stream preamble JSON", { cause: error });
  }
  assertIrohStreamPreamble(value);
  return value;
}

export function assertIrohStreamPreamble(value: unknown): asserts value is IrohStreamPreamble {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Iroh stream preamble must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record["v"] !== IROH_WIRE_VERSION) {
    throw new Error(`Unsupported Iroh wire version ${String(record["v"])}`);
  }
  switch (record["k"]) {
    case "control":
      if (!exactKeys(record, ["k", "v"])) throw new Error("Invalid control-stream preamble");
      return;
    case "envelope":
    case "message":
      if (!exactKeys(record, ["k", "sid", "v"])) {
        throw new Error(`Invalid ${record["k"]}-stream preamble`);
      }
      assertBoundedId(record["sid"], "Iroh session ID", MAX_SESSION_ID_BYTES);
      return;
    case "stream":
      if (!exactKeys(record, ["body", "k", "requestId", "sid", "v"])) {
        throw new Error("Invalid streaming-RPC preamble");
      }
      assertBoundedId(record["sid"], "Iroh session ID", MAX_SESSION_ID_BYTES);
      assertBoundedId(record["requestId"], "Iroh request ID", MAX_REQUEST_ID_BYTES);
      if (typeof record["body"] !== "boolean") {
        throw new Error("Iroh streaming-RPC body flag must be boolean");
      }
      return;
    default:
      throw new Error(`Unsupported Iroh stream kind ${String(record["k"])}`);
  }
}

export async function writeIrohStreamPreamble(
  stream: FrameSendStream,
  preamble: IrohStreamPreamble
): Promise<void> {
  await writeFrame(stream, encodeIrohStreamPreamble(preamble), MAX_CONTROL_FRAME_BYTES);
}

export async function readIrohStreamPreamble(
  stream: FrameReceiveStream
): Promise<IrohStreamPreamble> {
  return decodeIrohStreamPreamble(await readFrame(stream, MAX_CONTROL_FRAME_BYTES));
}

export function encodeCanonicalJson(value: unknown, maximumBytes: number): Uint8Array {
  const bytes = encoder.encode(JSON.stringify(value));
  if (bytes.byteLength > maximumBytes) {
    throw new Error(`Iroh JSON frame exceeds ${maximumBytes} bytes`);
  }
  return bytes;
}

export function decodeJsonFrame(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch (error) {
    throw new Error("Invalid Iroh JSON frame", { cause: error });
  }
}
