import { describe, expect, it } from "vitest";
import { createInvocationSnapshot, invocationSnapshotDigest } from "./invocationSnapshot.js";

const base = () =>
  createInvocationSnapshot({
    service: "fs",
    method: "writeFile",
    capability: "service:fs.writeFile",
    resourceKey: "workspace:/a.txt",
    args: ["/a.txt", "ok", undefined],
    preparedStateDigest: "-",
    callerPrincipal: "session:conversation-1",
    sessionId: "conversation-1",
    mission: "-",
    snippetDigest: "a".repeat(64),
    codeLineage: { class: "internal", chain: ["repo:x@y"] },
    contextLineage: { class: "external", latchEpoch: 2, externalKeys: ["web:example.com"] },
    initiatorChain: ["user:u", "session:conversation-1"],
    at: 1,
  });

describe("invocation snapshot", () => {
  it("excludes actor, time, and context lineage from retry identity", () => {
    const left = base();
    const right = {
      ...left,
      callerPrincipal: "session:conversation-2" as const,
      sessionId: "conversation-2",
      contextLineage: { class: "external" as const, latchEpoch: 9, externalKeys: ["web:other.test"] },
      initiatorChain: ["user:other"],
      at: 999,
    };
    expect(invocationSnapshotDigest(left)).toBe(invocationSnapshotDigest(right));
  });

  it("changes when the prepared state, mission, or code-lineage class changes", () => {
    const snapshot = base();
    const digest = invocationSnapshotDigest(snapshot);
    expect(invocationSnapshotDigest({ ...snapshot, preparedStateDigest: "b".repeat(64) })).not.toBe(digest);
    expect(invocationSnapshotDigest({ ...snapshot, mission: "mission:m@closure" })).not.toBe(digest);
    expect(invocationSnapshotDigest({ ...snapshot, codeLineage: { class: "external", chain: [] } })).not.toBe(digest);
  });
});
