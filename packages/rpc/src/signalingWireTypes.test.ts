import type {
  RtcIceCandidate as SignalingRtcIceCandidate,
  RtcIceServer as SignalingRtcIceServer,
  RtcSessionDescription as SignalingRtcSessionDescription,
} from "../../../apps/signaling/src/protocol.js";
import { describe, expectTypeOf, it } from "vitest";
import type {
  RtcIceCandidate,
  RtcIceServer,
  RtcSessionDescription,
} from "./transports/webrtcPeer.js";

describe("signaling WebRTC wire types", () => {
  it("keeps the standalone Worker protocol identical to the RPC protocol", () => {
    expectTypeOf<SignalingRtcSessionDescription>().toEqualTypeOf<RtcSessionDescription>();
    expectTypeOf<SignalingRtcIceCandidate>().toEqualTypeOf<RtcIceCandidate>();
    expectTypeOf<SignalingRtcIceServer>().toEqualTypeOf<RtcIceServer>();
  });
});
