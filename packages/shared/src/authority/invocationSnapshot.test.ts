import { describe, expect, it } from "vitest";
import { createInvocationSnapshot, invocationSnapshotDigest } from "./invocationSnapshot.js";

const base = () =>
  createInvocationSnapshot({
    service: "fs",
    method: "writeFile",
    capability: "service:fs.writeFile",
    capabilityDefinitionDigest: "-",
    resourceType: "filesystem",
    provider: "-",
    providerExecutionDigest: "-",
    resourceKey: "workspace:/a.txt",
    args: ["/a.txt", "ok", undefined],
    preparedStateDigest: "-",
    callerPrincipal: "session:conversation-1",
    sessionId: "conversation-1",
    missionSubject: "-",
    snippetDigest: "a".repeat(64),
    codeLineage: { class: "internal", chain: ["repo:x@y"] },
    contextLineage: { class: "external", latchEpoch: 2, externalKeys: ["web:example.com"] },
    initiatorChain: ["user:u", "session:conversation-1"],
    at: 1,
  });

describe("invocation snapshot", () => {
  it("seals mutable subject, revocation generation, and initiating document into consent", () => {
    const binding = { subject: "website:site-1" as const, generation: 1, documentId: "doc-1" };
    const snapshot = { ...base(), subjectBinding: binding };
    const digest = invocationSnapshotDigest(snapshot);
    for (const changed of [
      { ...binding, subject: "website:site-2" as const },
      { ...binding, generation: 2 },
      { ...binding, documentId: "doc-2" },
      undefined,
    ]) {
      expect(invocationSnapshotDigest({ ...snapshot, subjectBinding: changed })).not.toBe(digest);
    }
  });

  it("excludes actor, time, and context lineage from retry identity", () => {
    const left = base();
    const right = {
      ...left,
      callerPrincipal: "session:conversation-2" as const,
      sessionId: "conversation-2",
      contextLineage: {
        class: "external" as const,
        latchEpoch: 9,
        externalKeys: ["web:other.test"],
      },
      initiatorChain: ["user:other"],
      at: 999,
    };
    expect(invocationSnapshotDigest(left)).toBe(invocationSnapshotDigest(right));
  });

  it("seals both workspace addresses into approval retry identity", () => {
    const snapshot = { ...base(), sourceWorkspaceId: "project", workspaceId: "personal" };
    const digest = invocationSnapshotDigest(snapshot);
    expect(
      invocationSnapshotDigest({ ...snapshot, sourceWorkspaceId: "another-project" })
    ).not.toBe(digest);
    expect(invocationSnapshotDigest({ ...snapshot, workspaceId: "shared" })).not.toBe(digest);
  });

  it("changes when receiver, prepared state, mission, or code-lineage facts change", () => {
    const snapshot = base();
    const digest = invocationSnapshotDigest(snapshot);
    expect(
      invocationSnapshotDigest({ ...snapshot, providerExecutionDigest: "b".repeat(64) })
    ).not.toBe(digest);
    expect(
      invocationSnapshotDigest({ ...snapshot, capabilityDefinitionDigest: "c".repeat(64) })
    ).not.toBe(digest);
    expect(invocationSnapshotDigest({ ...snapshot, preparedStateDigest: "b".repeat(64) })).not.toBe(
      digest
    );
    expect(
      invocationSnapshotDigest({
        ...snapshot,
        missionSubject: "mission:m@closure",
      })
    ).not.toBe(digest);
    expect(
      invocationSnapshotDigest({ ...snapshot, codeLineage: { class: "external", chain: [] } })
    ).not.toBe(digest);
  });
});


it("seals initiating website identity independently from receiver grant identity", () => {
  const website = { subject: "website:site" as const, userId: "user:u" as const,
    workspaceId: "ws", origin: "https://example.com", connected: true,
    binding: { subject: "website:site" as const, generation: 0, documentId: "doc1" } };
  const snapshot = { ...base(), callerPrincipal: "code:receiver@v1" as const, initiatingWebsite: website };
  const digest = invocationSnapshotDigest(snapshot);
  for (const change of [undefined, { ...website, origin: "https://other.test" },
    { ...website, binding: { ...website.binding, documentId: "doc2" } },
    { ...website, binding: { ...website.binding, generation: 1 } }]) {
    expect(invocationSnapshotDigest({ ...snapshot, initiatingWebsite: change })).not.toBe(digest);
  }
});
