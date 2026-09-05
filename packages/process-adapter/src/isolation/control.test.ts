import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { readControl } from "./control.js";

describe("workspace process control framing", () => {
  it("handles fragmented and coalesced messages and reports clean EOF once", async () => {
    const stream = new PassThrough();
    const received = vi.fn();
    const failed = vi.fn();
    readControl(stream, received, failed);
    stream.write('{"type":');
    stream.write('"ready"}\n{"type":"exit","id":"a"}\n');
    expect(received.mock.calls.map(([value]) => value)).toEqual([
      { type: "ready" },
      { type: "exit", id: "a" },
    ]);
    stream.end();
    await new Promise((resolve) => stream.once("end", resolve));
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls[0]![0].message).toBe("Workspace control channel closed");
  });
  it("terminates decoding after a malformed frame and reports truncated EOF", async () => {
    const malformed = new PassThrough();
    const receive = vi.fn();
    const fail = vi.fn();
    readControl(malformed, receive, fail);
    malformed.write('[]\n{"type":"ready"}\n');
    malformed.end();
    await new Promise((resolve) => malformed.once("end", resolve));
    expect(receive).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledTimes(1);
    const truncated = new PassThrough();
    const failed = vi.fn();
    readControl(truncated, receive, failed);
    truncated.end('{"type":');
    await new Promise((resolve) => truncated.once("end", resolve));
    expect(failed.mock.calls[0]![0].message).toBe("Truncated workspace control frame");
  });

  it("decodes highly fragmented UTF-8 frames without retaining prior frame bytes", () => {
    const stream = new PassThrough();
    const receive = vi.fn();
    const fail = vi.fn();
    readControl(stream, receive, fail);
    const value = "α🦊".repeat(20_000);
    const frame = Buffer.from(JSON.stringify({ value }) + "\n");
    for (let offset = 0; offset < frame.length; offset += 7) {
      stream.write(frame.subarray(offset, offset + 7));
    }
    stream.write('{"type":"ready"}\n');
    expect(receive.mock.calls).toEqual([[{ value }], [{ type: "ready" }]]);
    expect(fail).not.toHaveBeenCalled();
    stream.destroy();
  });

  it("rejects an oversized unterminated frame before attempting JSON decoding", () => {
    const stream = new PassThrough();
    const receive = vi.fn();
    const fail = vi.fn();
    readControl(stream, receive, fail);
    const chunk = Buffer.alloc(1024 * 1024, 32);
    for (let count = 0; count < 40; count++) stream.write(chunk);
    stream.write('{"type":"ready"}\n');
    expect(receive).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledTimes(1);
    expect(fail.mock.calls[0]![0].message).toBe("Oversized control frame");
    stream.destroy();
  });
});
