/**
 * The buffered level of a channel whose platform reports it asynchronously.
 *
 * `RtcDataChannelLike` requires `bufferedAmount` to include the write that just
 * returned, because the scheduler samples it to decide whether there is room.
 * react-native-webrtc sets its own figure only from the native event, so
 * between a burst of writes and the next event it reports a level missing all
 * of them. Counting sends locally and letting each native level replace the
 * count — it is absolute, not a delta — keeps the published value honest in
 * both directions: never behind a write, never stuck above a drain.
 */
export class BufferedLevel {
  private nativeLevel = 0;
  private sentSinceNativeLevel = 0;

  constructor(initialLevel = 0) {
    this.nativeLevel = initialLevel;
  }

  get value(): number {
    return this.nativeLevel + this.sentSinceNativeLevel;
  }

  recordSend(byteLength: number): void {
    this.sentSinceNativeLevel += byteLength;
  }

  /** Adopt an absolute level from the platform, discarding the local overlay. */
  applyNativeLevel(level: number): void {
    this.nativeLevel = level;
    this.sentSinceNativeLevel = 0;
  }

  /**
   * Whether the channel counts as drained.
   *
   * "At or below", not "below": the W3C condition is inclusive, and a strict
   * comparison is unsatisfiable at a threshold of 0 — which is the value the
   * mobile bulk channel uses to mean "wait until empty".
   */
  isAtOrBelow(threshold: number): boolean {
    return this.value <= threshold;
  }
}
