import { nativeInvocationId } from "@vibestudio/service-schemas/nativeInvocation";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authorityAcquisitionReceiptSchema,
  authorityMethods,
} from "@vibestudio/service-schemas/authority";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import {
  createInvocationSnapshot,
  invocationSnapshotDigest,
} from "@vibestudio/shared/authority/invocationSnapshot";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { createAuthorityService } from "./authorityService.js";
import { acquisitionInvocationProjection } from "./acquisitionInvocationProjection.js";
import { acquisitionJson, storeAcquisitionInputs } from "./acquisitionRequestStorage.js";
import type { AcquisitionRequestInput } from "./acquisitionCoordinator.js";

const owner = { ownerRuntimeId: "do:workers/agent:Agent:one", sessionId: "session:one" };
const executionDigest = "a".repeat(64);
const fixtures: Array<{ path: string; grants: CapabilityGrantStore }> = [];

function input(code = true): AcquisitionRequestInput {
  const snapshot = createInvocationSnapshot({
    service: "llm",
    method: "connect",
    capability: "llm.use",
    capabilityDefinitionDigest: "-",
    resourceType: "model",
    provider: "-",
    providerExecutionDigest: "-",
    resourceKey: "model:one",
    args: [{ modelId: "one", providerId: "provider:one" }],
    preparedStateDigest: "-",
    callerPrincipal: "code:workers/agent@version:one",
    sessionId: owner.sessionId,
    missionSubject: "-",
    snippetDigest: executionDigest,
    codeLineage: { class: "internal", chain: [] },
    initiatorChain: ["user:alice"],
  });
  return {
    snapshot,
    snapshotDigest: invocationSnapshotDigest(snapshot),
    tier: "gated",
    caller: createVerifiedCaller(
      owner.ownerRuntimeId,
      "do",
      code
        ? {
            callerId: owner.ownerRuntimeId,
            callerKind: "do",
            repoPath: "workers/agent",
            effectiveVersion: "version:one",
            executionDigest,
          }
        : null
    ),
    renderedAction: "use model one",
    resource: { kind: "exact", key: snapshot.resourceKey },
  };
}

function fixture(inputs: AcquisitionRequestInput[] = [input()], kind = "invocation") {
  const path = mkdtempSync(join(tmpdir(), "acquisition-invocation-projection-"));
  const grants = new CapabilityGrantStore({ statePath: path });
  const tracked = { path, grants };
  fixtures.push(tracked);
  const record = grants.acquisitions.admit({
    ...owner,
    requestKey: "request:one",
    facts: acquisitionJson({ kind, inputs: storeAcquisitionInputs(inputs) }),
  });
  const service = createAuthorityService({
    dispatcher: {} as never,
    acquisitions: {} as never,
    grants,
  });
  const context = {
    caller: createVerifiedCaller(owner.ownerRuntimeId, "do"),
    authorization: { session: { id: owner.sessionId } } as never,
  };
  return { ...tracked, record, service, context, tracked };
}

afterEach(() => {
  for (const { path, grants } of fixtures.splice(0)) {
    grants.close();
    rmSync(path, { recursive: true });
  }
});

describe("canonical acquisition invocation projection", () => {
  it("projects exact sealed native model coordinates and rejects a different causal invocation", () => {
    const nativeInvocation = {
      owner: { runtimeId: owner.ownerRuntimeId, authoritySessionId: owner.sessionId },
      task: { taskId: 12, conversationId: 0 },
      operation: { kind: "model" as const, purpose: "generation" as const, attempt: 2, cutoff: 9 },
    };
    const original = input();
    original.snapshot.nativeInvocation = nativeInvocation;
    original.snapshot.causalParent = {
      kind: "trajectory-invocation",
      logId: "trajectory:channel:one",
      head: "main",
      invocationId: nativeInvocationId(nativeInvocation),
    };
    original.snapshotDigest = invocationSnapshotDigest(original.snapshot);
    const f = fixture([original]);
    expect(acquisitionInvocationProjection(f.record)[0]!.nativeInvocation).toEqual(
      nativeInvocation
    );
    original.snapshot.causalParent.invocationId = "invocation:foreign";
    original.snapshotDigest = invocationSnapshotDigest(original.snapshot);
    const foreign = fixture([original]);
    expect(() => acquisitionInvocationProjection(foreign.record)).toThrow(
      "sealed owner or snapshot"
    );
  });
  it("retains original identity across host reopen, terminal reads and exact acknowledgement", async () => {
    const original = input();
    const f = fixture([original]);
    const read = async () =>
      authorityAcquisitionReceiptSchema.parse(
        await f.service.handler(f.context, "acquisitionReceipt", [
          { acquisitionId: f.record.acquisitionId },
        ])
      );
    const pending = await read();
    expect(pending.invocations).toEqual([
      {
        ...owner,
        causalParent: null,
        nativeInvocation: null,
        code: { repoPath: "workers/agent", effectiveVersion: "version:one", executionDigest },
        service: "llm",
        method: "connect",
        argsDigest: original.snapshot.argsDigest,
        preparedStateDigest: "-",
        snapshotDigest: original.snapshotDigest,
        capability: "llm.use",
        resourceKey: "model:one",
      },
    ]);
    f.grants.close();
    f.tracked.grants = new CapabilityGrantStore({ statePath: f.path });
    const reopened = f.tracked.grants;
    expect(
      acquisitionInvocationProjection(reopened.acquisitions.get(f.record.acquisitionId, owner)!)
    ).toEqual(pending.invocations);
    const terminal = reopened.acquisitions.resolve(
      f.record.acquisitionId,
      owner,
      f.record.bindingDigest,
      { decision: "allow-once" },
      () => ({ state: "decided", value: { state: "decided", decision: "allow-once" } })
    );
    const reopenedService = createAuthorityService({
      dispatcher: {} as never,
      acquisitions: {} as never,
      grants: reopened,
    });
    const outstanding = authorityMethods.outstandingAcquisitions.returns.parse(
      await reopenedService.handler(f.context, "outstandingAcquisitions", [{}])
    );
    expect(outstanding.receipts).toHaveLength(1);
    expect(outstanding.receipts[0]).toMatchObject({
      state: "decided",
      invocations: pending.invocations,
      bindingDigest: pending.bindingDigest,
      admission: pending.admission,
    });
    await expect(
      reopenedService.handler(f.context, "acknowledgeAcquisition", [
        {
          acquisitionId: terminal.acquisitionId,
          resolutionDigest: terminal.resolutionDigest!,
        },
      ])
    ).resolves.toEqual({ acknowledged: true });
    expect(await reopenedService.handler(f.context, "outstandingAcquisitions", [{}])).toEqual({
      receipts: [],
      next: null,
    });
    expect(
      authorityAcquisitionReceiptSchema.parse(
        await reopenedService.handler(f.context, "acquisitionReceipt", [
          { acquisitionId: terminal.acquisitionId },
        ])
      ).invocations
    ).toEqual(pending.invocations);
  });

  it.each(["invocation", "target-join"])(
    "projects every %s facet in its original order",
    (kind) => {
      const first = input();
      const snapshot = { ...first.snapshot, capability: "llm.second", resourceKey: "model:two" };
      const second = { ...first, snapshot, snapshotDigest: invocationSnapshotDigest(snapshot) };
      const f = fixture([first, second], kind);
      expect(
        acquisitionInvocationProjection(f.record).map((invocation) => invocation.snapshotDigest)
      ).toEqual([first.snapshotDigest, second.snapshotDigest]);
    }
  );

  it("represents genuinely absent code identity without manufacturing an image", () => {
    const withoutCode = fixture([input(false)]);
    expect(acquisitionInvocationProjection(withoutCode.record)[0]?.code).toBeNull();
    const incomplete = input();
    delete incomplete.caller.code!.executionDigest;
    const f = fixture([incomplete]);
    expect(acquisitionInvocationProjection(f.record)[0]?.code?.executionDigest).toBeNull();
  });

  it("projects immutable authenticated source coordinates and rejects source substitution", () => {
    const original = input();
    original.snapshot.causalParent = {
      kind: "trajectory-invocation",
      logId: "trajectory:channel:one",
      head: "main",
      invocationId: "invocation:native:one",
    };
    original.snapshotDigest = invocationSnapshotDigest(original.snapshot);
    const f = fixture([original]);
    const projected = acquisitionInvocationProjection(f.record);
    expect(projected[0]?.causalParent).toEqual(original.snapshot.causalParent);
    original.snapshot.causalParent.invocationId = "invocation:native:substituted";
    expect(acquisitionInvocationProjection(f.record)).toEqual(projected);
    const substituted = fixture([original]);
    expect(() => acquisitionInvocationProjection(substituted.record)).toThrow(
      /sealed owner or snapshot/
    );
  });

  it("refuses composed facets from sibling native invocations with otherwise identical RPCs", () => {
    const first = input();
    first.snapshot.causalParent = {
      kind: "trajectory-invocation",
      logId: "trajectory:channel:one",
      head: "main",
      invocationId: "invocation:native:first",
    };
    first.snapshotDigest = invocationSnapshotDigest(first.snapshot);
    const snapshot = {
      ...first.snapshot,
      causalParent: { ...first.snapshot.causalParent, invocationId: "invocation:native:second" },
    };
    const f = fixture([
      first,
      { ...first, snapshot, snapshotDigest: invocationSnapshotDigest(snapshot) },
    ]);
    expect(() => acquisitionInvocationProjection(f.record)).toThrow(/one exact invocation/);
  });

  it("authenticates the retained owner before projecting and distinguishes unknown IDs", async () => {
    const f = fixture();
    await expect(
      f.service.handler(f.context, "acquisitionReceipt", [{ acquisitionId: "unknown" }])
    ).resolves.toBeNull();
    await expect(
      f.service.handler(
        {
          ...f.context,
          caller: createVerifiedCaller("do:workers/foreign:Agent:one", "do"),
        },
        "acquisitionReceipt",
        [{ acquisitionId: f.record.acquisitionId }]
      )
    ).rejects.toThrow(/not owned/);
    await expect(
      f.service.handler(
        {
          ...f.context,
          authorization: { session: { id: "foreign-session" } } as never,
        },
        "acquisitionReceipt",
        [{ acquisitionId: f.record.acquisitionId }]
      )
    ).rejects.toThrow(/not owned/);
  });

  it.each(["owner", "session", "code", "digest"] as const)(
    "refuses sealed inputs that disagree with their %s binding",
    (field) => {
      const original = input();
      if (field === "owner") original.caller.runtime.id = "foreign-runtime";
      if (field === "session") original.snapshot.sessionId = "foreign-session";
      if (field === "code") original.caller.code!.callerId = "foreign-runtime";
      if (field === "digest") original.snapshotDigest = "b".repeat(64);
      const f = fixture([original]);
      expect(() => acquisitionInvocationProjection(f.record)).toThrow(/sealed owner or snapshot/);
    }
  );

  it("refuses a receipt whose facets name different original operations", () => {
    const first = input();
    const snapshot = { ...first.snapshot, method: "other" };
    const f = fixture([
      first,
      { ...first, snapshot, snapshotDigest: invocationSnapshotDigest(snapshot) },
    ]);
    expect(() => acquisitionInvocationProjection(f.record)).toThrow(/one exact invocation/);
  });

  it("refuses unknown stored acquisition kinds instead of emitting a weaker public identity", async () => {
    const f = fixture([input()], "unsupported");
    await expect(
      f.service.handler(f.context, "acquisitionReceipt", [
        { acquisitionId: f.record.acquisitionId },
      ])
    ).rejects.toThrow(/no sealed invocation inputs/);
  });

  it("requires a nonempty invocation projection on every public receipt", async () => {
    const f = fixture();
    const receipt = authorityAcquisitionReceiptSchema.parse(
      await f.service.handler(f.context, "acquisitionReceipt", [
        { acquisitionId: f.record.acquisitionId },
      ])
    );
    expect(
      authorityAcquisitionReceiptSchema.safeParse({ ...receipt, invocations: [] }).success
    ).toBe(false);
  });
});
