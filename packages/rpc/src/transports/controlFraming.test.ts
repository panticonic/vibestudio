import { describe, expect, it } from "vitest";
import {
  frameControlMessage,
  createControlDefragmenter,
  ControlProtocolViolation,
  isSequencedControlMessage,
  stampControlSequence,
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

describe("control wire sequence", () => {
  const enc = new TextEncoder();
  const sequenced = (text: string, seq: number): Uint8Array => {
    const [part] = frameControlMessage(enc.encode(text), 16 * 1024, 1, true);
    stampControlSequence(part!, seq);
    return part!;
  };

  it("round-trips a stamped sequence and preserves the payload", () => {
    const gaps: number[] = [];
    const defrag = createControlDefragmenter({ onSequenceGap: (_e, _r, m) => gaps.push(m) });
    const out = defrag.accept(sequenced("hello", 7));
    expect(new TextDecoder().decode(out!)).toBe("hello");
    expect(gaps).toEqual([]);
  });

  it("stays unsequenced unless asked, so an un-upgraded peer still parses it", () => {
    const [part] = frameControlMessage(enc.encode("hi"), 16 * 1024, 1);
    expect(isSequencedControlMessage(part!)).toBe(false);
    expect(new TextDecoder().decode(createControlDefragmenter().accept(part!)!)).toBe("hi");
  });

  it("reports how many control messages were lost", () => {
    const seen: Array<{ expected: number; received: number; missing: number }> = [];
    const defrag = createControlDefragmenter({
      onSequenceGap: (expected, received, missing) => seen.push({ expected, received, missing }),
    });
    defrag.accept(sequenced("a", 4));
    defrag.accept(sequenced("b", 5));
    defrag.accept(sequenced("c", 9)); // 6,7,8 lost
    expect(seen).toEqual([{ expected: 6, received: 9, missing: 3 }]);
  });

  it("survives the u32 wrap without a false gap", () => {
    const gaps: number[] = [];
    const defrag = createControlDefragmenter({ onSequenceGap: (_e, _r, m) => gaps.push(m) });
    defrag.accept(sequenced("a", 0xffffffff));
    defrag.accept(sequenced("b", 0));
    expect(gaps).toEqual([]);
  });

  it("does not let interleaved fragments consume sequence numbers", () => {
    // The hazard this guards: the control scheduler round-robins across lanes,
    // so a large fragmented frame can be interleaved between two small whole
    // ones. Fragments carry their own frame id and must NOT advance the wire
    // sequence, or a perfectly healthy pipe reports a gap and tears itself down.
    const gaps: number[] = [];
    const defrag = createControlDefragmenter({ onSequenceGap: (_e, _r, m) => gaps.push(m) });
    const big = frameControlMessage(enc.encode("x".repeat(200)), 64, 99, true);
    expect(big.length).toBeGreaterThan(1);

    defrag.accept(sequenced("first", 1));
    for (const fragment of big) defrag.accept(fragment);
    defrag.accept(sequenced("second", 2));
    expect(gaps).toEqual([]);
  });

  it("forgets the sequence across reset — a fresh pipe renumbers", () => {
    const gaps: number[] = [];
    const defrag = createControlDefragmenter({ onSequenceGap: (_e, _r, m) => gaps.push(m) });
    defrag.accept(sequenced("a", 900));
    defrag.reset();
    defrag.accept(sequenced("b", 0));
    expect(gaps).toEqual([]);
  });
});
