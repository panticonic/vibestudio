import { describe, it } from "vitest";
import type { RtcDataChannelLike, RtcDataChannelState } from "./webrtcPeer.js";
import { awaitDrain } from "./channelIo.js";

/**
 * A channel whose buffer can move at a chosen moment — specifically while a
 * waiter is subscribing, which is the window a level check taken before
 * subscribing cannot see.
 */
class DrainRaceChannel implements RtcDataChannelLike {
  readonly label = "bulk";
  readyState: RtcDataChannelState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readonly maxMessageSize = 256 * 1024;
  /** Runs when a waiter subscribes to the low-water event. */
  onSubscribe: (() => void) | null = null;
  private lowHandlers = new Set<() => void>();
  private closeHandlers = new Set<() => void>();

  send(): void {}
  close(): void {
    this.readyState = "closed";
    for (const handler of [...this.closeHandlers]) handler();
  }
  /** Drain to empty and fire the edge, exactly once, like a real channel. */
  drain(): void {
    this.bufferedAmount = 0;
    for (const handler of [...this.lowHandlers]) handler();
  }
  onOpen(): () => void {
    return () => {};
  }
  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }
  onError(): () => void {
    return () => {};
  }
  onMessage(): () => void {
    return () => {};
  }
  onBufferedAmountLow(handler: () => void): () => void {
    this.lowHandlers.add(handler);
    this.onSubscribe?.();
    return () => this.lowHandlers.delete(handler);
  }
}

/** Reject rather than hang, so a regression fails the run instead of stalling it. */
async function within(promise: Promise<void>, ms = 1000): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  await Promise.race([
    promise,
    new Promise<void>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("awaitDrain never resolved")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

describe("awaitDrain", () => {
  it("returns immediately when the buffer is already at the threshold", async () => {
    const channel = new DrainRaceChannel();
    await within(awaitDrain(channel));
  });

  it("resolves when the buffer drains after the waiter subscribes", async () => {
    const channel = new DrainRaceChannel();
    channel.bufferedAmount = 4096;
    const drained = awaitDrain(channel);
    channel.drain();
    await within(drained);
  });

  it("does not miss a buffer that empties while the waiter is subscribing", async () => {
    // The low-water event is an edge with no replay. A waiter that samples the
    // buffer, then subscribes, cannot see a drain that lands in between — and
    // the waiter here is a serialized write loop nothing else restarts, so a
    // missed edge parks every stream on the pipe until something tears it down.
    // A pipe whose low-water mark is zero sits empty most of the time, which
    // makes this window common rather than exotic.
    const channel = new DrainRaceChannel();
    channel.bufferedAmount = 4096;
    channel.onSubscribe = () => {
      channel.onSubscribe = null;
      channel.bufferedAmount = 0; // drained; its edge already fired and is gone
    };
    await within(awaitDrain(channel));
  });

  it("does not miss a channel that closes while the waiter is subscribing", async () => {
    const channel = new DrainRaceChannel();
    channel.bufferedAmount = 4096;
    channel.onSubscribe = () => {
      channel.onSubscribe = null;
      channel.readyState = "closed";
    };
    await within(awaitDrain(channel));
  });
});
