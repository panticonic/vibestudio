import { describe, expect, it } from "vitest";
import { BufferedLevel } from "./bufferedLevel.js";

describe("BufferedLevel", () => {
  it("counts a write immediately, before the platform reports it", () => {
    // The scheduler samples bufferedAmount to decide whether there is room. On
    // react-native-webrtc the native level arrives asynchronously, so a level
    // that omits the write that just returned tells the scheduler the channel
    // is empty and it keeps writing — which is how a burst outruns the pipe.
    const level = new BufferedLevel(0);
    expect(level.value).toBe(0);

    level.recordSend(16384);
    expect(level.value).toBe(16384);

    level.recordSend(16384);
    expect(level.value).toBe(32768);
  });

  it("treats the native level as absolute rather than a delta", () => {
    const level = new BufferedLevel(0);
    level.recordSend(16384);
    level.recordSend(16384);

    // Native says 4096 is still queued — that figure already accounts for both
    // writes, so adding to it would double-count and leave a level that never
    // returns to zero.
    level.applyNativeLevel(4096);
    expect(level.value).toBe(4096);
  });

  it("returns to zero when the platform reports a drained channel", () => {
    const level = new BufferedLevel(0);
    level.recordSend(65536);
    level.applyNativeLevel(0);
    expect(level.value).toBe(0);
    expect(level.isAtOrBelow(0)).toBe(true);
  });

  it("counts writes that arrive after a native level", () => {
    const level = new BufferedLevel(0);
    level.applyNativeLevel(1024);
    level.recordSend(512);
    expect(level.value).toBe(1536);
  });

  it("is drained at exactly the threshold, not only below it", () => {
    // react-native-webrtc emits its low edge on a strict `<`, so it misses
    // exact equality — and at a threshold of 0, which the mobile bulk channel
    // uses to mean "wait until empty", `x < 0` can never be satisfied at all.
    const level = new BufferedLevel(0);
    expect(level.isAtOrBelow(0)).toBe(true);

    level.recordSend(256);
    expect(level.isAtOrBelow(256)).toBe(true);
    expect(level.isAtOrBelow(255)).toBe(false);
  });

  it("starts from the level the channel already had", () => {
    const level = new BufferedLevel(2048);
    expect(level.value).toBe(2048);
    expect(level.isAtOrBelow(0)).toBe(false);
  });
});
