import { describe, expect, it } from "vitest";
import {
  nativeInvocationId,
  nativeInvocationIdentity,
  nativeInvocationSourceSchema,
  nativeOriginatingInputSchema,
} from "./nativeInvocation.js";

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

describe("nested native invocation identity", () => {
  const source = {
    owner: {
      runtimeId: "agent:one",
      authoritySessionId: "lifetime:one",
      contextId: "ctx:one",
      incarnation: "storage:one",
      channelId: "channel:one",
      source: "workers/agent-worker",
      effectiveVersion: "version:one",
      className: "AiChatWorker",
      objectKey: "agent:one",
      executionDigest: "a".repeat(64),
    },
    task: { conversationId: 4, taskId: 23, kind: "pi.tool", version: 2 },
    operation: {
      kind: "nested-tool" as const,
      parentTaskId: 22,
      parentCallId: "parent:call",
      key: "child:one",
      callId: "child:call",
      name: "read",
      argumentsDigest: "b".repeat(64),
    },
  };
  it("preserves actual child ancestry without inventing an assistant entry", () => {
    expect(nativeInvocationSourceSchema.parse(source)).toEqual(source);
    expect(nativeInvocationIdentity(source).operation).toEqual({
      kind: "nested-tool",
      parentTaskId: 22,
      parentCallId: "parent:call",
      key: "child:one",
      callId: "child:call",
    });
    expect(
      nativeInvocationSourceSchema.safeParse({
        ...source,
        operation: { ...source.operation, assistantEntryId: 12 },
      }).success
    ).toBe(false);
  });
  it("separates nested call coordinates within an owner lifetime", () => {
    const original = nativeInvocationId(nativeInvocationIdentity(source));
    for (const change of [
      { parentTaskId: 24 },
      { parentCallId: "other:parent" },
      { key: "child:two" },
      { callId: "other:call" },
    ])
      expect(
        nativeInvocationId(
          nativeInvocationIdentity({ ...source, operation: { ...source.operation, ...change } })
        )
      ).not.toBe(original);
  });
});
