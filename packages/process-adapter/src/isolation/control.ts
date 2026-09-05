import type { Readable, Writable } from "node:stream";

// Private process-control framing, not an authority or application RPC channel.
// Every message from the workspace is untrusted, including reported child PIDs.
// Existing RPC envelopes allow 16 MiB; string encoding in the control carrier
// can double that size. Keep a bounded allowance for the envelope and framing.
const MAX_FRAME = 40 * 1024 * 1024;
const MAX_PENDING = 64 * 1024 * 1024;

export function writeControl(stream: Writable, value: unknown): void {
  const frame = Buffer.from(JSON.stringify(value) + "\n");
  if (frame.length > MAX_FRAME || stream.writableLength + frame.length > MAX_PENDING) {
    throw new Error("Workspace process control buffer limit exceeded");
  }
  if (stream.destroyed || !stream.writable) throw new Error("Workspace control channel is closed");
  stream.write(frame);
}

export function readControl(
  stream: Readable,
  receive: (message: Record<string, unknown>) => void,
  fail: (error: Error) => void
): void {
  let pending = Buffer.alloc(0);
  let length = 0;
  let failed = false;
  const reject = (error: unknown) => {
    if (failed) return;
    failed = true;
    pending = Buffer.alloc(0);
    length = 0;
    fail(error instanceof Error ? error : new Error(String(error)));
  };
  stream.on("data", (chunk: Buffer | string) => {
    if (failed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    try {
      while (offset < bytes.length) {
        const end = bytes.indexOf(10, offset);
        const part = bytes.subarray(offset, end < 0 ? bytes.length : end);
        const nextLength = length + part.length;
        if (nextLength >= MAX_FRAME) throw new Error("Oversized control frame");
        // Grow geometrically rather than copying the entire partial frame on
        // each chunk. A guest controls fragmentation as well as frame size.
        if (nextLength > pending.length) {
          const capacity = Math.min(
            MAX_FRAME,
            Math.max(nextLength, pending.length * 2, 64 * 1024)
          );
          const next = Buffer.allocUnsafe(capacity);
          pending.copy(next, 0, 0, length);
          pending = next;
        }
        part.copy(pending, length);
        length = nextLength;
        if (end < 0) break;
        const message: unknown = JSON.parse(pending.toString("utf8", 0, length));
        // Reuse the small carrier buffer; release exceptional large frames.
        if (pending.length > 64 * 1024) pending = Buffer.alloc(0);
        length = 0;
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          throw new Error("Invalid workspace control frame");
        }
        receive(message as Record<string, unknown>);
        offset = end + 1;
      }
    } catch (error) {
      reject(error);
    }
  });
  stream.on("error", reject);
  stream.on("end", () => {
    reject(
      new Error(
        length ? "Truncated workspace control frame" : "Workspace control channel closed"
      )
    );
  });
}
