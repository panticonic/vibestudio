import { describe, expect, it, vi } from "vitest";
import type { RtcDataChannelLike, RtcDataChannelState } from "./webrtcPeer.js";
import { createFrameScheduler, type FrameTrafficClass } from "./frameScheduler.js";

class FakeChannel implements RtcDataChannelLike {
  readonly label: string;
  readyState: RtcDataChannelState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readonly maxMessageSize = 256 * 1024;
  readonly safeReceiveWindowBytes = 512 * 1024;
  readonly sent: number[] = [];
  trackBuffered = false;
  private readonly low = new Set<() => void>();

  constructor(label: string) {
    this.label = label;
  }
  send(data: Uint8Array): void {
    this.sent.push(data[0] ?? 0);
    if (this.trackBuffered) this.bufferedAmount += data.byteLength;
  }
  drainTo(bytes: number): void {
    this.bufferedAmount = bytes;
    if (bytes <= this.bufferedAmountLowThreshold) {
      for (const handler of [...this.low]) handler();
    }
  }
  close(): void {
    this.readyState = "closed";
  }
  onOpen(): () => void {
    return () => undefined;
  }
  onClose(): () => void {
    return () => undefined;
  }
  onError(): () => void {
    return () => undefined;
  }
  onMessage(): () => void {
    return () => undefined;
  }
  onBufferedAmountLow(handler: () => void): () => void {
    this.low.add(handler);
    return () => this.low.delete(handler);
  }
}

const part = (tag: number, bytes = 1): Uint8Array => {
  const value = new Uint8Array(bytes);
  value[0] = tag;
  return value;
};

function harness(opts?: {
  receiveWindow?: number;
  totalCapBytes?: number;
  perKeyCapBytes?: number;
}) {
  const control = new FakeChannel("control");
  const interactive = new FakeChannel("interactive");
  const bulk = new FakeChannel("bulk");
  let receiveWindow = opts?.receiveWindow ?? 512 * 1024;
  const scheduler = createFrameScheduler({
    lanes: {
      control: { getChannel: () => control, weight: 8 },
      interactive: {
        getChannel: () => interactive,
        weight: 4,
        window: { minBytes: 0, initialBytes: 64 * 1024, maxBytes: () => receiveWindow },
      },
      bulk: {
        getChannel: () => bulk,
        weight: 1,
        window: { minBytes: 0, initialBytes: 64 * 1024, maxBytes: () => receiveWindow },
      },
    },
    totalCapBytes: opts?.totalCapBytes,
    perKeyCapBytes: opts?.perKeyCapBytes,
  });
  return {
    control,
    interactive,
    bulk,
    scheduler,
    setReceiveWindow: (v: number) => (receiveWindow = v),
  };
}

const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("association-aware frame scheduler", () => {
  it("uses the 8:4:1 association weights while preserving bulk progress", async () => {
    const h = harness();
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < 16; i++) writes.push(h.scheduler.enqueue("control", "c", [part(10 + i)]));
    for (let i = 0; i < 8; i++)
      writes.push(h.scheduler.enqueue("interactive", "i", [part(40 + i)]));
    for (let i = 0; i < 2; i++) writes.push(h.scheduler.enqueue("bulk", "b", [part(70 + i)]));
    await Promise.all(writes);
    expect(h.control.sent).toHaveLength(16);
    expect(h.interactive.sent).toHaveLength(8);
    expect(h.bulk.sent).toEqual([70, 71]);
  });

  it("does not let a saturated bulk channel block control or interactive work", async () => {
    const h = harness({ receiveWindow: 0 });
    h.bulk.trackBuffered = true;
    const bulk = h.scheduler.enqueue("bulk", 1, [part(1, 16), part(2, 16), part(3, 16)]);
    await tick();
    expect(h.bulk.sent).toEqual([1]);
    const control = h.scheduler.enqueue("control", "session", [part(9)]);
    const interactive = h.scheduler.enqueue("interactive", 2, [part(8)]);
    await Promise.all([control, interactive]);
    expect(h.control.sent).toEqual([9]);
    expect(h.interactive.sent).toEqual([8]);
    expect(h.bulk.sent).toEqual([1]);
    h.bulk.drainTo(0);
    await tick();
    h.bulk.drainTo(0);
    await bulk;
    expect(h.bulk.sent).toEqual([1, 2, 3]);
  });

  it("round-robins keys within one traffic class", async () => {
    const h = harness();
    await Promise.all([
      h.scheduler.enqueue("interactive", "a", [part(1), part(2), part(3)]),
      h.scheduler.enqueue("interactive", "b", [part(4), part(5), part(6)]),
    ]);
    expect(h.interactive.sent).toEqual([1, 4, 2, 5, 3, 6]);
  });

  it("negotiates drain-to-zero behavior from a zero receive window", async () => {
    const h = harness({ receiveWindow: 0 });
    h.interactive.trackBuffered = true;
    const write = h.scheduler.enqueue("interactive", 1, [part(1, 16), part(2, 16)]);
    await tick();
    expect(h.interactive.bufferedAmountLowThreshold).toBe(0);
    expect(h.interactive.sent).toEqual([1]);
    h.interactive.drainTo(0);
    await write;
    expect(h.interactive.sent).toEqual([1, 2]);
  });

  it("grows a desktop window after fast drains without exceeding the negotiated cap", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ receiveWindow: 96 * 1024 });
      h.bulk.trackBuffered = true;
      const chunks = Array.from({ length: 9 }, (_, i) => part(i + 1, 16 * 1024));
      const write = h.scheduler.enqueue("bulk", 1, chunks);
      await tick();
      expect(h.bulk.bufferedAmountLowThreshold).toBe(64 * 1024);
      h.bulk.drainTo(64 * 1024);
      await tick();
      expect(h.bulk.bufferedAmountLowThreshold).toBe(80 * 1024);
      h.bulk.drainTo(80 * 1024);
      await tick();
      expect(h.bulk.bufferedAmountLowThreshold).toBe(96 * 1024);
      h.bulk.drainTo(0);
      await tick();
      h.bulk.drainTo(0);
      await write;
      expect(h.bulk.bufferedAmountLowThreshold).toBeLessThanOrEqual(96 * 1024);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a cancelled key and admits another key waiting on capacity", async () => {
    const h = harness({ receiveWindow: 0, totalCapBytes: 16, perKeyCapBytes: 16 });
    h.bulk.trackBuffered = true;
    const first = h.scheduler.enqueue("bulk", 1, [part(1, 16), part(2, 16)]);
    const second = h.scheduler.enqueue("bulk", 2, [part(3, 16)]);
    await tick();
    h.scheduler.dropKey("bulk", 1);
    expect(await first).toBe("dropped");
    h.bulk.drainTo(0);
    expect(await second).toBe("flushed");
  });

  it("settles every lane as dropped when the association closes", async () => {
    const h = harness({ receiveWindow: 0 });
    h.bulk.trackBuffered = true;
    const writes = [
      h.scheduler.enqueue("bulk", 1, [part(1, 16), part(2, 16)]),
      h.scheduler.enqueue("interactive", 2, [part(2)]),
    ];
    await tick();
    h.scheduler.close();
    expect(await Promise.all(writes)).toContain("dropped");
    expect(h.scheduler.pendingBytes()).toBe(0);
  });

  it("drops one association generation while remaining usable by its replacement", async () => {
    const h = harness({ receiveWindow: 0 });
    h.bulk.trackBuffered = true;
    const stale = h.scheduler.enqueue("bulk", 1, [part(1, 16), part(2, 16)]);
    await tick();
    expect(h.bulk.sent).toEqual([1]);

    h.scheduler.reset();
    expect(await stale).toBe("dropped");
    expect(h.scheduler.pendingBytes()).toBe(0);

    h.bulk.trackBuffered = false;
    h.bulk.bufferedAmount = 0;
    await expect(h.scheduler.enqueue("bulk", 2, [part(3)])).resolves.toBe("flushed");
    expect(h.bulk.sent).toEqual([1, 3]);
  });

  it("meters bytes by traffic class and stream", async () => {
    const h = harness({ receiveWindow: 0 });
    h.bulk.trackBuffered = true;
    const write = h.scheduler.enqueue("bulk", 7, [part(1, 8), part(2, 8)]);
    await tick();
    expect(h.scheduler.pendingBytes("bulk", 7)).toBe(8);
    expect(h.scheduler.pendingBytes("bulk")).toBe(8);
    expect(h.scheduler.pendingBytes("interactive")).toBe(0);
    h.bulk.drainTo(0);
    await write;
  });

  it.each<FrameTrafficClass>(["control", "interactive", "bulk"])(
    "settles %s writes when its channel is unavailable",
    async (trafficClass) => {
      const h = harness();
      const channel = h[trafficClass];
      channel.close();
      await expect(h.scheduler.enqueue(trafficClass, "x", [part(1)])).resolves.toBe("dropped");
    }
  );
});
