import { describe, expect, it } from "vitest";
import { describeDataChannelContract } from "../../../packages/rpc/src/transports/dataChannelContract.js";
import { WrappedDataChannel } from "./nodeDatachannelPeer.js";

/**
 * libdatachannel-shaped fake: `bufferedAmount()` is synchronous and already
 * accounts for a send by the time it returns, and the low-water callback is a
 * single native registration the wrapper fans out.
 */
function createNativeFake() {
  let level = 0;
  let lowHandler: (() => void) | null = null;
  const sent: Uint8Array[] = [];
  return {
    sent,
    reportLevel(bytes: number): void {
      level = bytes;
    },
    emitLow(): void {
      lowHandler?.();
    },
    native: {
      getLabel: () => "bulk",
      isOpen: () => true,
      close: () => {},
      sendMessageBinary: (buffer: Buffer) => {
        sent.push(new Uint8Array(buffer));
        return true;
      },
      bufferedAmount: () => level,
      setBufferedAmountLowThreshold: () => {},
      maxMessageSize: () => 262_144,
      onOpen: () => {},
      onClosed: () => {},
      onError: () => {},
      onMessage: () => {},
      onBufferedAmountLow: (cb: () => void) => {
        lowHandler = cb;
      },
    },
  };
}

describeDataChannelContract({ describe, it, expect }, "nodeDatachannelPeer", () => {
  const fake = createNativeFake();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channel = new WrappedDataChannel(fake.native as any, "bulk");
  return {
    channel,
    platform: { reportLevel: fake.reportLevel, emitLow: fake.emitLow },
    // libdatachannel increments its own buffered amount when it queues, and
    // reports zero only when the bytes genuinely reached SCTP — so delegation
    // is correct here and the adapter has nothing to compensate for.
    platformReportsSendsSynchronously: true,
  };
});
