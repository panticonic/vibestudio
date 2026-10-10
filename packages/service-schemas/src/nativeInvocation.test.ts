import { describe, expect, it } from "vitest";
import { nativeOriginatingInputSchema } from "./nativeInvocation.js";

const originatingInput = {
  conversationId: 4,
  submissionId: 12,
  entryId: 13,
  channelRef: {
    source: "workers/pubsub-channel",
    className: "PubSubChannel",
    objectKey: "channel:one",
  },
  eventSequence: 7,
  envelopeId: "envelope:one",
  messageId: "message:one",
  receiverParticipantId: "agent:one",
};
describe("native originating input coordinates", () => {
  it("preserves the original locally committed channel cursor and identities", () => {
    expect(nativeOriginatingInputSchema.parse(originatingInput)).toEqual(originatingInput);
  });
  it("rejects a provisional or unsafe sequence at the shared protocol boundary", () => {
    for (const sequence of [null, undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(
        nativeOriginatingInputSchema.safeParse({ ...originatingInput, eventSequence: sequence })
          .success
      ).toBe(false);
  });
});
