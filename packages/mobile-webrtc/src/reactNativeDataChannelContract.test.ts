import { describe, expect, it, vi } from "vitest";

// react-native-webrtc and react-native are imported at module scope by the
// adapter. Stub them so the adapter's own logic — the part the contract is
// about — can be exercised off-device.
vi.mock("react-native-webrtc", () => ({ RTCPeerConnection: class {} }));

const nativeListeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();

vi.mock("react-native", () => ({
  NativeModules: { WebRTCModule: {} },
  NativeEventEmitter: class {
    addListener(event: string, handler: (payload: Record<string, unknown>) => void) {
      const handlers = nativeListeners.get(event) ?? [];
      handlers.push(handler);
      nativeListeners.set(event, handlers);
      return {
        remove: () => {
          const current = nativeListeners.get(event) ?? [];
          nativeListeners.set(
            event,
            current.filter((entry) => entry !== handler)
          );
        },
      };
    }
  },
}));

const { describeDataChannelContract } = await import(
  "../../rpc/src/transports/dataChannelContract.js"
);
const { WrappedDataChannel } = await import("./reactNativeWebRtcPeer.js");

const REACT_TAG = 7;

function emitNative(event: string, payload: Record<string, unknown>): void {
  for (const handler of nativeListeners.get(event) ?? []) handler(payload);
}

describeDataChannelContract({ describe, it, expect }, "reactNativeWebRtcPeer", () => {
  nativeListeners.clear();
  const dc = {
    label: "bulk",
    readyState: "open",
    binaryType: "arraybuffer",
    bufferedAmount: 0,
    _reactTag: REACT_TAG,
    send: () => {},
    close: () => {},
    addEventListener: () => {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channel = new WrappedDataChannel(dc as any, "bulk");
  return {
    channel,
    platform: {
      reportLevel: (bytes: number) =>
        emitNative("dataChannelDidChangeBufferedAmount", {
          reactTag: REACT_TAG,
          bufferedAmount: bytes,
        }),
      // The adapter owns the low-water decision on this platform (it derives the
      // edge from the absolute level), so the native emit is a no-op here — the
      // level report above is what must produce the edge.
      emitLow: () => {},
    },
    // react-native-webrtc sets its figure only from the native event, so a burst
    // of writes reports as an empty channel until that event lands. The adapter
    // must count its own sends to compensate.
    platformReportsSendsSynchronously: false,
  };
});
