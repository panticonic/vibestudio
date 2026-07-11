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
    if (channel.readyState !== "open") done();
  });
}
