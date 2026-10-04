import { expect, it } from "vitest";
import {
  nativeInvocationId,
  type NativeInvocationSource,
} from "@vibestudio/service-schemas/nativeInvocation";
import { inspectNativeApprovalInvocation } from "./nativeApprovalEvidence.js";
const source: NativeInvocationSource = {
  owner: {
    runtimeId: "agent",
    authoritySessionId: "authority",
    channelId: "channel",
    contextId: "context",
    incarnation: "incarnation",
    source: "workers/agent",
    effectiveVersion: "version",
    className: "Agent",
    objectKey: "agent",
    executionDigest: "b".repeat(64),
  },
  task: { conversationId: 1, taskId: 2, kind: "pi.tool", version: 1 },
  operation: {
    kind: "tool",
    assistantEntryId: 3,
    callId: "read",
    name: "read",
    argumentsDigest: "a".repeat(64),
  },
};
const event = { actorId: "agent", invocationId: nativeInvocationId(source), nativeSource: source };
it("distinguishes native tool starts from nested channel transport on the same agent stream", () => {
  expect(inspectNativeApprovalInvocation(event, "channel")).toEqual({
    source,
    invocationId: event.invocationId,
  });
  expect(
    inspectNativeApprovalInvocation(
      { actorId: "agent", invocationId: "transport-call", transport: { kind: "channel" } },
      "channel"
    )
  ).toBeNull();
});
it("retains strict original identity and source requirements for native work", () => {
  for (const invalid of [
    { ...event, nativeSource: undefined },
    { ...event, actorId: "foreign" },
    { ...event, invocationId: "foreign" },
    { ...event, transport: { kind: "channel" } },
  ])
    expect(() => inspectNativeApprovalInvocation(invalid, "channel")).toThrow();
  expect(() => inspectNativeApprovalInvocation(event, "foreign-channel")).toThrow();
});
