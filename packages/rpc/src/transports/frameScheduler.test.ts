import { describe, expect, it } from "vitest";
import type { RtcDataChannelLike, RtcDataChannelState } from "./webrtcPeer.js";
import { createFrameScheduler } from "./frameScheduler.js";

/**
 * Fake channel with a REAL `bufferedAmount` simulation: tests control drain
 * explicitly (`drain()`), and `trackBuffered` makes every send raise
 * `bufferedAmount` so the pump parks between parts.
 */
class FakeChannel implements RtcDataChannelLike {
  readyState: RtcDataChannelState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  maxMessageSize = 256 * 1024;
  trackBuffered = false;
  readonly sent: Uint8Array[] = [];
  private lowH = new Set<() => void>();
  private closeH = new Set<() => void>();
  constructor(readonly label = "bulk") {}
  send(data: Uint8Array): void {
    if (this.readyState !== "open") throw new Error("send on non-open channel");
    this.sent.push(data.slice());
    if (this.trackBuffered) this.bufferedAmount += data.byteLength;
  }
  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    for (const h of [...this.closeH]) h();
  }
  /** Simulate the SCTP queue flushing: bufferedAmount → 0, low event fires. */
  drain(): void {
    this.bufferedAmount = 0;
    for (const h of [...this.lowH]) h();
  }
  onOpen(): () => void {
    return () => {};
  }
  onClose(h: () => void): () => void {
    this.closeH.add(h);
    return () => this.closeH.delete(h);
  }
  onError(): () => void {
    return () => {};
  }
  onMessage(): () => void {
    return () => {};
  }
  onBufferedAmountLow(h: () => void): () => void {
    this.lowH.add(h);
    return () => this.lowH.delete(h);
  }
}

/** Flush the pump: setTimeout(0) lets every pending microtask chain settle. */
const tick = async (turns = 3): Promise<void> => {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** A part tagged [keyChar, seq] so send order is assertable. */
const part = (key: string, seq: number, size = 2): Uint8Array => {
  const p = new Uint8Array(size);
  p[0] = key.charCodeAt(0);
  p[1] = seq;
  return p;
};
const label = (p: Uint8Array): string => `${String.fromCharCode(p[0]!)}${p[1]}`;

describe("frame scheduler", () => {
  it("round-robins across keys at part granularity", async () => {
    const ch = new FakeChannel();
    const s = createFrameScheduler({ getChannel: () => ch });
    const a = s.enqueue("a", [part("a", 0), part("a", 1), part("a", 2), part("a", 3)]);
    const b = s.enqueue("b", [part("b", 0), part("b", 1), part("b", 2)]);
    await Promise.all([a, b]);
    expect(ch.sent.map(label)).toEqual(["a0", "b0", "a1", "b1", "a2", "b2", "a3"]);
    expect(s.pendingBytes()).toBe(0);
  });

  it("preserves per-key FIFO across multiple enqueues", async () => {
    const ch = new FakeChannel();
    const s = createFrameScheduler({ getChannel: () => ch });
    const first = s.enqueue("a", [part("a", 0), part("a", 1)]);
    const second = s.enqueue("a", [part("a", 2)]);
    await Promise.all([first, second]);
    expect(ch.sent.map(label)).toEqual(["a0", "a1", "a2"]);
  });

  it("per-key cap blocks a flooding key while another key proceeds", async () => {
    const ch = new FakeChannel();
    ch.bufferedAmount = 1; // backpressured: nothing sends until drain()
    const s = createFrameScheduler({ getChannel: () => ch, perKeyCapBytes: 10 });
    const done: string[] = [];
    const a1 = s.enqueue("a", [part("a", 0, 8)]).then(() => done.push("a1"));
    const a2 = s.enqueue("a", [part("a", 1, 8)]).then(() => done.push("a2"));
    const b = s.enqueue("b", [part("b", 0, 4)]).then(() => done.push("b"));
    await tick();
    expect(s.pendingBytes("a")).toBe(8); // a2 (8+8 > 10) still awaiting capacity
    expect(s.pendingBytes("b")).toBe(4); // b admitted despite a2 waiting ahead of it
    expect(done).toEqual([]);
    ch.drain();
    await Promise.all([a1, a2, b]);
    // a2 was admitted only after a1's bytes drained — b went out before it.
    expect(done).toEqual(["a1", "b", "a2"]);
    expect(ch.sent.map(label)).toEqual(["a0", "b0", "a1"]);
  });

  it("does not admit a later same-key waiter ahead of an older per-key-blocked waiter", async () => {
    const ch = new FakeChannel();
    ch.bufferedAmount = 1;
    const s = createFrameScheduler({ getChannel: () => ch, perKeyCapBytes: 10 });
    const done: string[] = [];
    const a1 = s.enqueue("a", [part("a", 0, 8)]).then(() => done.push("a1"));
    const a2 = s.enqueue("a", [part("a", 1, 8)]).then(() => done.push("a2"));
    const a3 = s.enqueue("a", [part("a", 2, 2)]).then(() => done.push("a3"));
    const b = s.enqueue("b", [part("b", 0, 2)]).then(() => done.push("b"));

    await tick();
    expect(s.pendingBytes("a")).toBe(8);
    expect(s.pendingBytes("b")).toBe(2);
    expect(done).toEqual([]);

    ch.drain();
    await Promise.all([a1, a2, a3, b]);
    expect(done).toEqual(["a1", "b", "a2", "a3"]);
    expect(ch.sent.map(label)).toEqual(["a0", "b0", "a1", "a2"]);
  });

  it("total cap blocks any key until bytes drain", async () => {
    const ch = new FakeChannel();
    ch.bufferedAmount = 1;
    const s = createFrameScheduler({ getChannel: () => ch, totalCapBytes: 16 });
    let bAccepted = false;
    const a = s.enqueue("a", [part("a", 0, 12)]);
    const b = s.enqueue("b", [part("b", 0, 8)]).then(() => {
      bAccepted = true;
    });
    await tick();
    expect(s.pendingBytes()).toBe(12); // b (12+8 > 16) not accepted
    expect(bAccepted).toBe(false);
    ch.drain();
    await Promise.all([a, b]);
    expect(ch.sent.map(label)).toEqual(["a0", "b0"]);
  });

  it("admits a batch larger than a cap into an empty scope (never wedges)", async () => {
    const ch = new FakeChannel();
    const s = createFrameScheduler({ getChannel: () => ch, perKeyCapBytes: 4, totalCapBytes: 8 });
    await s.enqueue("a", [part("a", 0, 32)]); // 32 > both caps, but the scheduler is empty
    expect(ch.sent.map(label)).toEqual(["a0"]);
  });

  it("dropKey settles its enqueues (accepted AND waiting) and skips its parts", async () => {
    const ch = new FakeChannel();
    ch.bufferedAmount = 1;
    const s = createFrameScheduler({ getChannel: () => ch, perKeyCapBytes: 10 });
    const a1 = s.enqueue("a", [part("a", 0, 8), part("a", 1, 8)]); // accepted (empty key)
    const a2 = s.enqueue("a", [part("a", 2, 8)]); // parked on the per-key cap
    const b = s.enqueue("b", [part("b", 0, 4)]);
    s.dropKey("a");
    await Promise.all([a1, a2]); // both settle without a send
    expect(s.pendingBytes("a")).toBe(0);
    ch.drain();
    await b;
    expect(ch.sent.map(label)).toEqual(["b0"]); // a's parts were discarded
  });

  it("close settles everything and later enqueues settle without sending", async () => {
    const ch = new FakeChannel();
    ch.bufferedAmount = 1;
    const s = createFrameScheduler({ getChannel: () => ch });
    const a = s.enqueue("a", [part("a", 0)]);
    const b = s.enqueue("b", [part("b", 0)]);
    s.close();
    await Promise.all([a, b]);
    expect(s.pendingBytes()).toBe(0);
    await s.enqueue("c", [part("c", 0)]); // settles immediately
    ch.drain();
    await tick();
    expect(ch.sent).toHaveLength(0);
  });

  it("a channel closing mid-write settles queued work instead of wedging", async () => {
    const ch = new FakeChannel();
    ch.trackBuffered = true; // each send backpressures until drain()
    const s = createFrameScheduler({ getChannel: () => ch });
    let settled = false;
    const p = s.enqueue("a", [part("a", 0), part("a", 1), part("a", 2)]).then(() => {
      settled = true;
    });
    await tick();
    expect(ch.sent.map(label)).toEqual(["a0"]); // parked awaiting drain
    expect(settled).toBe(false);
    ch.close(); // awaitDrain resolves on close; pump settles rather than wedging
    await p;
    expect(settled).toBe(true);
    expect(ch.sent.map(label)).toEqual(["a0"]); // remaining parts never sent
    expect(s.pendingBytes()).toBe(0);
  });

  it("a null channel settles queued work; the next generation's enqueues send", async () => {
    let ch: FakeChannel | null = null;
    const s = createFrameScheduler({ getChannel: () => ch });
    await s.enqueue("a", [part("a", 0)]); // settles — no channel this generation
    expect(s.pendingBytes()).toBe(0);
    ch = new FakeChannel();
    await s.enqueue("a", [part("a", 1)]);
    expect(ch.sent.map(label)).toEqual(["a1"]);
  });

  it("an enqueue's promise resolves only after its LAST part is sent", async () => {
    const ch = new FakeChannel();
    ch.trackBuffered = true;
    const s = createFrameScheduler({ getChannel: () => ch });
    let resolved = false;
    const p = s.enqueue("a", [part("a", 0), part("a", 1), part("a", 2)]).then(() => {
      resolved = true;
    });
    await tick();
    expect(ch.sent).toHaveLength(1);
    expect(resolved).toBe(false);
    ch.drain();
    await tick();
    expect(ch.sent).toHaveLength(2);
    expect(resolved).toBe(false);
    ch.drain();
    await p;
    expect(ch.sent).toHaveLength(3);
    expect(resolved).toBe(true);
  });

  it("settles 'flushed' once sent and 'dropped' on dropKey/close/closed-scheduler", async () => {
    const ch = new FakeChannel();
    const s = createFrameScheduler({ getChannel: () => ch });
    await expect(s.enqueue("a", [part("a", 0)])).resolves.toBe("flushed");
    await expect(s.enqueue("a", [])).resolves.toBe("flushed"); // vacuously flushed

    ch.bufferedAmount = 1; // park the pump before any further send
    const viaDropKey = s.enqueue("b", [part("b", 0)]);
    s.dropKey("b");
    await expect(viaDropKey).resolves.toBe("dropped");

    const viaClose = s.enqueue("c", [part("c", 0)]);
    s.close();
    await expect(viaClose).resolves.toBe("dropped");
    await expect(s.enqueue("d", [part("d", 0)])).resolves.toBe("dropped"); // closed scheduler
    expect(ch.sent.map(label)).toEqual(["a0"]); // only the flushed batch went out
  });

  it("settles 'dropped' when the channel dies with the batch queued or PARTIALLY sent", async () => {
    // Never sent: the pump parks on backpressure, then the channel closes.
    const ch = new FakeChannel();
    ch.bufferedAmount = 1;
    const s = createFrameScheduler({ getChannel: () => ch });
    const queued = s.enqueue("a", [part("a", 0)]);
    ch.close();
    await expect(queued).resolves.toBe("dropped");
    expect(ch.sent).toHaveLength(0);

    // Partially sent: still 'dropped' — the peer's defragmenter reset discards
    // the incomplete fragment set on reconnect, so nothing was delivered.
    const ch2 = new FakeChannel();
    ch2.trackBuffered = true; // one part per drain
    const s2 = createFrameScheduler({ getChannel: () => ch2 });
    const partial = s2.enqueue("a", [part("a", 0), part("a", 1)]);
    await tick();
    expect(ch2.sent.map(label)).toEqual(["a0"]); // first part out, second parked
    ch2.close();
    await expect(partial).resolves.toBe("dropped");
  });

  it("meters pendingBytes per key and in total while parts are queued", async () => {
    const ch = new FakeChannel();
    ch.bufferedAmount = 1;
    const s = createFrameScheduler({ getChannel: () => ch });
    const a = s.enqueue("a", [part("a", 0, 6), part("a", 1, 6)]);
    const b = s.enqueue("b", [part("b", 0, 3)]);
    await tick();
    expect(s.pendingBytes("a")).toBe(12);
    expect(s.pendingBytes("b")).toBe(3);
    expect(s.pendingBytes()).toBe(15);
    ch.drain();
    await Promise.all([a, b]);
    expect(s.pendingBytes()).toBe(0);
  });
});
