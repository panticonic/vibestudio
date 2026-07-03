import { describe, expect, it } from "vitest";
import {
  frameControlMessage,
  createControlDefragmenter,
  ControlProtocolViolation,
} from "./controlFraming.js";

describe("control framing", () => {
  it("round-trips a small frame as a single whole message", () => {
    const frame = new TextEncoder().encode("hello");
    const parts = frameControlMessage(frame, 16 * 1024, 1);
    expect(parts.length).toBe(1);
    const out = createControlDefragmenter().accept(parts[0]!);
    expect(out).not.toBeNull();
    expect(new TextDecoder().decode(out!)).toBe("hello");
  });

  it("fragments and reassembles a frame larger than the cap", () => {
    const frame = new Uint8Array(50_000).map((_, i) => i % 256);
    const max = 16 * 1024;
    const parts = frameControlMessage(frame, max, 7);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.byteLength).toBeLessThanOrEqual(max);
    const defrag = createControlDefragmenter();
    let out: Uint8Array | null = null;
    for (const part of parts) out = defrag.accept(part) ?? out;
    expect([...out!]).toEqual([...frame]);
  });

  it("reassembles two interleaved fragment sets independently", () => {
    const max = 32; // tiny cap forces fragmentation
    const a = new Uint8Array(100).fill(0xaa);
    const b = new Uint8Array(100).fill(0xbb);
    const pa = frameControlMessage(a, max, 1);
    const pb = frameControlMessage(b, max, 2);
    const defrag = createControlDefragmenter();
    const results: Uint8Array[] = [];
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if (pa[i]) {
        const r = defrag.accept(pa[i]!);
        if (r) results.push(r);
      }
      if (pb[i]) {
        const r = defrag.accept(pb[i]!);
        if (r) results.push(r);
      }
    }
    expect(results.length).toBe(2);
    expect(results.some((r) => r.length === 100 && r.every((x) => x === 0xaa))).toBe(true);
    expect(results.some((r) => r.length === 100 && r.every((x) => x === 0xbb))).toBe(true);
  });

  it("reset() drops in-flight fragments so a new pipe never reassembles stale data", () => {
    const parts = frameControlMessage(new Uint8Array(100).fill(0xcc), 32, 1);
    const defrag = createControlDefragmenter();
    expect(defrag.accept(parts[0]!)).toBeNull(); // partial set
    defrag.reset();
    let out: Uint8Array | null = null;
    for (let i = 1; i < parts.length; i++) out = defrag.accept(parts[i]!) ?? out;
    expect(out).toBeNull(); // index 0 was dropped → set can never complete
  });

  it("throws a protocol violation past the max pending fragment sets cap", () => {
    const defrag = createControlDefragmenter({ maxPendingSets: 2 });
    const max = 32; // tiny cap forces multi-fragment sets that stay pending on index 0
    const firstFragment = (id: number): Uint8Array =>
      frameControlMessage(new Uint8Array(100).fill(id), max, id)[0]!;
    expect(defrag.accept(firstFragment(1))).toBeNull(); // 1 pending set
    expect(defrag.accept(firstFragment(2))).toBeNull(); // 2 pending sets (at cap)
    expect(() => defrag.accept(firstFragment(3))).toThrow(ControlProtocolViolation);
  });

  it("throws a protocol violation past the max buffered fragment bytes cap", () => {
    const defrag = createControlDefragmenter({ maxBufferedBytes: 40 });
    const max = 32; // chunkMax = 23 bytes per fragment
    const parts = frameControlMessage(new Uint8Array(100).fill(0x11), max, 1);
    expect(defrag.accept(parts[0]!)).toBeNull(); // buffers 23 bytes (< 40)
    expect(() => defrag.accept(parts[1]!)).toThrow(ControlProtocolViolation); // 23+23 > 40
  });

  it("carries the CONTROL_PROTOCOL_VIOLATION code and names the cap", () => {
    const defrag = createControlDefragmenter({ maxBufferedBytes: 10 });
    const parts = frameControlMessage(new Uint8Array(100).fill(0x22), 32, 1);
    try {
      defrag.accept(parts[0]!);
      throw new Error("expected a protocol violation");
    } catch (e) {
      expect(e).toBeInstanceOf(ControlProtocolViolation);
      expect((e as ControlProtocolViolation).code).toBe("CONTROL_PROTOCOL_VIOLATION");
      expect((e as Error).message).toContain("10");
    }
  });

  it("completing a set releases its budget for the next set", () => {
    const max = 32;
    // Cap fits exactly one full 100-byte set at a time (last chunk lands at 100).
    const defrag = createControlDefragmenter({ maxBufferedBytes: 100 });
    const a = frameControlMessage(new Uint8Array(100).fill(0xaa), max, 1);
    let outA: Uint8Array | null = null;
    for (const p of a) outA = defrag.accept(p) ?? outA;
    expect(outA).not.toBeNull(); // set A completed, releasing its budget
    const b = frameControlMessage(new Uint8Array(100).fill(0xbb), max, 2);
    let outB: Uint8Array | null = null;
    expect(() => {
      for (const p of b) outB = defrag.accept(p) ?? outB;
    }).not.toThrow(); // fits only because A's bytes were released
    expect(outB).not.toBeNull();
  });

  it("reset() releases the buffered-byte budget", () => {
    const max = 32; // chunkMax = 23 bytes per fragment
    const defrag = createControlDefragmenter({ maxBufferedBytes: 40 });
    const first = frameControlMessage(new Uint8Array(100).fill(0x33), max, 1);
    expect(defrag.accept(first[0]!)).toBeNull(); // buffers 23 bytes
    defrag.reset(); // clears the byte total back to 0
    const next = frameControlMessage(new Uint8Array(100).fill(0x44), max, 2);
    expect(defrag.accept(next[0]!)).toBeNull(); // 23 bytes fits again (post-reset)
    expect(() => defrag.accept(next[1]!)).toThrow(ControlProtocolViolation); // 23+23 > 40
  });
});
