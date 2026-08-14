import type { RtcDataChannelLike } from "./webrtcPeer.js";

/**
 * Shared data-channel backpressure primitive used by `frameScheduler` (which
 * drives both pipe roles). Kept in one home so the next drain/backpressure fix
 * lands once. (The former `writeChunked` helper was removed — it had zero call
 * sites once `frameScheduler` became the single send mechanism per channel.)
 */

/**
 * Await the channel draining below its low-water threshold. Resolves early if the
 * channel CLOSES while backpressured — otherwise `onBufferedAmountLow` would never
 * fire and a serialized write loop would wedge forever on a dead channel.
 */
export async function awaitDrain(channel: RtcDataChannelLike): Promise<void> {
  if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) return;
  await new Promise<void>((resolve) => {
    let offLow = () => {};
    let offClose = () => {};
    const done = () => {
      offLow();
      offClose();
      resolve();
    };
    offLow = channel.onBufferedAmountLow(done);
    offClose = channel.onClose(done);
    // Re-read the state the subscriptions exist to observe. Both are edge
    // events with no replay, so anything that happened between the check above
    // and these subscriptions is lost — and the waiter is a serialized write
    // loop that nothing else will restart, so a lost edge is not a delay, it is
    // a permanent stall. The buffer emptying is the likely one: a pipe whose
    // low-water mark is zero drains to empty constantly, so this window is hit
    // often rather than rarely.
    if (
      channel.readyState !== "open" ||
      channel.bufferedAmount <= channel.bufferedAmountLowThreshold
    ) {
      done();
    }
  });
}
