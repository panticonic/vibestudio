import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createVerifiedCaller,
  ServiceDispatcher,
  type ServiceContext,
} from "@vibestudio/shared/serviceDispatcher";
import { createTestExecutionSession } from "@vibestudio/shared/serviceDispatcherTestUtils";
import {
  createInvocationSnapshot,
  invocationSnapshotDigest,
} from "@vibestudio/shared/authority/invocationSnapshot";
import {
  authorityMethods,
  authorityAcquisitionReceiptSchema,
} from "@vibestudio/service-schemas/authority";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { AcquisitionCoordinator } from "./acquisitionCoordinator.js";
import { createAuthorityService } from "./authorityService.js";
import { authorizeVerifiedCaller } from "./authorityRuntime.js";
import type { AcquisitionOwner, AuthorityAcquisitionRecord } from "./authorityAcquisitionStore.js";
import { acquisitionJson, storeAcquisitionInputs } from "./acquisitionRequestStorage.js";
import type { AcquisitionRequestInput } from "./acquisitionCoordinator.js";

const owner: AcquisitionOwner = {
  ownerRuntimeId: "do:workers/test:Agent:one",
  sessionId: "session-one",
};
function context(sessionId = owner.sessionId, runtimeId = owner.ownerRuntimeId): ServiceContext {
  const executionSession = {
    ...createTestExecutionSession({ runtimeId, agentBinding: null, mode: "interactive" }),
    authoritySessionId: sessionId,
  };
  const image = executionSession.executionImage;
  return {
    caller: createVerifiedCaller(
      runtimeId,
      "do",
      {
        callerId: runtimeId,
        callerKind: "do",
        repoPath: image.repoPath,
        effectiveVersion: image.effectiveVersion,
        executionDigest: image.executionDigest,
        requested: [],
      },
      null,
      { userId: "test", handle: "test" },
      executionSession
    ),
  };
}
function dispatcher(grants: CapabilityGrantStore) {
  const dispatcher = new ServiceDispatcher();
  dispatcher.setAuthorityResolver(({ caller, service, capability, resourceKey, tier }) =>
    authorizeVerifiedCaller(caller, {
      workspaceId: "test",
      workspaceMember: true,
      sessionId: caller.executionSession?.authoritySessionId ?? caller.runtime.id,
      audience: "service:" + service,
      capability,
      resourceKey,
      tier,
      grantStore: grants,
    })
  );
  dispatcher.registerService(
    createAuthorityService({
      dispatcher,
      grants,
      acquisitions: new AcquisitionCoordinator({ grantStore: grants, approvalQueue: {} as never }),
    })
  );
  dispatcher.markInitialized();
  return dispatcher;
}
const fixtures: Array<{ statePath: string; grants: CapabilityGrantStore }> = [];
function fixture() {
  const statePath = mkdtempSync(join(tmpdir(), "authority-acquisition-service-"));
  const f = { statePath, grants: new CapabilityGrantStore({ statePath }) };
  fixtures.push(f);
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.grants.close();
    rmSync(f.statePath, { recursive: true });
  }
});
function reopen(f: ReturnType<typeof fixture>) {
  f.grants.close();
  f.grants = new CapabilityGrantStore({ statePath: f.statePath });
}
function invocationInput(key: string, scope: AcquisitionOwner): AcquisitionRequestInput {
  const caller = context(scope.sessionId, scope.ownerRuntimeId).caller;
  const snapshot = createInvocationSnapshot({
    service: "llm",
    method: "connect",
    capability: "llm.use",
    capabilityDefinitionDigest: "-",
    resourceType: "model",
    provider: "-",
    providerExecutionDigest: "-",
    resourceKey: "model:" + key,
    args: [{ modelId: key, providerId: "provider:test" }],
    preparedStateDigest: "-",
    callerPrincipal: caller.executionSession!.executionImage.principal,
    sessionId: scope.sessionId,
    missionSubject: "-",
    snippetDigest: caller.executionSession!.executionImage.executionDigest,
    codeLineage: { class: "internal", chain: [] },
    initiatorChain: ["user:test"],
    at: 1,
  });
  return {
    snapshot,
    snapshotDigest: invocationSnapshotDigest(snapshot),
    caller,
    tier: "gated",
    renderedAction: "use model " + key,
    resource: { kind: "exact", key: snapshot.resourceKey },
  };
}
function admit(f: ReturnType<typeof fixture>, key = "one", scope = owner, createdAt = 1) {
  return f.grants.acquisitions.admit(
    {
      ...scope,
      requestKey: scope.ownerRuntimeId + "/" + scope.sessionId + "/" + key,
      facts: acquisitionJson({
        kind: "invocation",
        inputs: storeAcquisitionInputs([invocationInput(key, scope)]),
      }),
    },
    createdAt
  );
}
function settle(f: ReturnType<typeof fixture>, record: AuthorityAcquisitionRecord) {
  return f.grants.acquisitions.resolve(
    record.acquisitionId,
    record.admission,
    record.bindingDigest,
    { kind: "answer", decision: "task" },
    () => ({ state: "decided", value: { state: "decided", decision: "task" } }),
    2
  );
}
function invoke(
  f: ReturnType<typeof fixture>,
  ctx: ServiceContext,
  method: string,
  input: unknown
) {
  return dispatcher(f.grants).dispatch(ctx, "authority", method, [input]);
}
async function receipt(f: ReturnType<typeof fixture>, id: string, ctx = context()) {
  return authorityMethods.acquisitionReceipt.returns.parse(
    await invoke(f, ctx, "acquisitionReceipt", { acquisitionId: id })
  );
}
async function page(
  f: ReturnType<typeof fixture>,
  after?: { createdAt: number; acquisitionId: string },
  ctx = context()
) {
  return authorityMethods.outstandingAcquisitions.returns.parse(
    await invoke(f, ctx, "outstandingAcquisitions", after ? { after } : {})
  );
}
function acknowledge(
  f: ReturnType<typeof fixture>,
  record: AuthorityAcquisitionRecord,
  ctx = context()
) {
  return invoke(f, ctx, "acknowledgeAcquisition", {
    acquisitionId: record.acquisitionId,
    resolutionDigest: record.resolutionDigest,
  });
}

describe("authenticated canonical acquisition service", () => {
  it("reads retained immutable pending facts without presenting or deciding an approval", async () => {
    const f = fixture();
    const record = admit(f);
    const observed = await receipt(f, record.acquisitionId);
    const original = invocationInput("one", owner);
    expect(observed).toEqual({
      acquisitionId: record.acquisitionId,
      admission: record.admission,
      bindingDigest: record.bindingDigest,
      invocations: [
        {
          ...owner,
          causalParent: null,
          nativeInvocation: null,
          code: {
            repoPath: original.caller.code!.repoPath,
            effectiveVersion: original.caller.code!.effectiveVersion,
            executionDigest: original.caller.code!.executionDigest,
          },
          service: original.snapshot.service,
          method: original.snapshot.method,
          argsDigest: original.snapshot.argsDigest,
          preparedStateDigest: original.snapshot.preparedStateDigest,
          snapshotDigest: original.snapshotDigest,
          capability: original.snapshot.capability,
          resourceKey: original.snapshot.resourceKey,
        },
      ],
      createdAt: record.createdAt,
      state: "pending",
    });
    expect(await page(f)).toEqual({ receipts: [observed], next: null });
    expect(f.grants.listAuthorityGrants()).toEqual([]);
    expect(await receipt(f, "acq:absent")).toBeNull();
  });

  it.each([context("session-two"), context(owner.sessionId, "do:foreign")])(
    "refuses receipt, wait and acknowledgement for a different authenticated owner %j",
    async (foreign) => {
      const f = fixture();
      const record = settle(f, admit(f));
      await expect(receipt(f, record.acquisitionId, foreign)).rejects.toMatchObject({
        code: "EACCES",
      });
      await expect(
        invoke(f, foreign, "awaitDecision", { acquisitionId: record.acquisitionId })
      ).rejects.toMatchObject({ code: "EACCES" });
      await expect(acknowledge(f, record, foreign)).rejects.toMatchObject({ code: "EACCES" });
      expect(await page(f, undefined, foreign)).toEqual({ receipts: [], next: null });
      expect(
        f.grants.acquisitions.get(record.acquisitionId, owner)?.acknowledgedAt
      ).toBeUndefined();
    }
  );

  it("replaces inbound authorization with the dispatcher's live session before reading", async () => {
    const f = fixture();
    const record = admit(f);
    const foreign = context("session-two");
    foreign.authorization = authorizeVerifiedCaller(context().caller, {
      workspaceId: "test",
      workspaceMember: true,
      sessionId: owner.sessionId,
      audience: "service:authority",
      capability: "authority.acquisitionReceipt",
      resourceKey: "-",
    }).context;
    await expect(receipt(f, record.acquisitionId, foreign)).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  it("rejects caller-selected owners, sessions and noncanonical digests at the wire boundary", async () => {
    const f = fixture();
    const record = settle(f, admit(f));
    for (const extra of [{ ownerRuntimeId: "do:foreign" }, { sessionId: "session-two" }]) {
      await expect(
        invoke(f, context(), "acquisitionReceipt", {
          acquisitionId: record.acquisitionId,
          ...extra,
        })
      ).rejects.toThrow(/invalid args/i);
      await expect(invoke(f, context(), "outstandingAcquisitions", extra)).rejects.toThrow(
        /invalid args/i
      );
    }
    await expect(
      invoke(f, context(), "acknowledgeAcquisition", {
        acquisitionId: record.acquisitionId,
        resolutionDigest: "not-a-digest",
      })
    ).rejects.toThrow(/invalid args/i);
    await expect(
      invoke(f, context(), "acknowledgeAcquisition", {
        acquisitionId: record.acquisitionId,
        resolutionDigest: "0".repeat(64),
      })
    ).rejects.toThrow(/does not match/);
    expect((await page(f)).receipts).toHaveLength(1);
  });

  it("keeps a canonical result due across lost observation/reopen until exact acknowledgement", async () => {
    const f = fixture();
    const record = settle(f, admit(f));
    const original = await receipt(f, record.acquisitionId);
    reopen(f);
    expect(await receipt(f, record.acquisitionId)).toEqual(original);
    expect((await page(f)).receipts).toEqual([original]);
    await expect(
      invoke(f, context(), "awaitDecision", { acquisitionId: record.acquisitionId })
    ).resolves.toEqual({ state: "decided", decision: "task" });
    expect((await page(f)).receipts).toHaveLength(1); // Reading/waiting does not acknowledge.
    await expect(acknowledge(f, record)).resolves.toEqual({ acknowledged: true });
    const firstAck = await receipt(f, record.acquisitionId);
    expect(firstAck?.state).toBe("decided");
    if (firstAck?.state === "decided") expect(firstAck.acknowledgedAt).toEqual(expect.any(Number));
    reopen(f);
    await expect(acknowledge(f, record)).resolves.toEqual({ acknowledged: true });
    expect(await receipt(f, record.acquisitionId)).toEqual(firstAck);
    expect(await page(f)).toEqual({ receipts: [], next: null });
  });

  it("retains delivery when an acknowledgement write fails and permits exact retry after reopen", async () => {
    const f = fixture();
    const record = settle(f, admit(f));
    const sql = new DatabaseSync(f.grants.databasePath);
    try {
      sql.exec(
        "CREATE TRIGGER reject_ack BEFORE UPDATE OF acknowledged_at ON authority_acquisitions BEGIN SELECT RAISE(ABORT,'ack write rejected'); END"
      );
      await expect(acknowledge(f, record)).rejects.toThrow("ack write rejected");
      expect((await page(f)).receipts).toHaveLength(1);
      expect(
        f.grants.acquisitions.get(record.acquisitionId, owner)?.acknowledgedAt
      ).toBeUndefined();
    } finally {
      sql.exec("DROP TRIGGER reject_ack");
      sql.close();
    }
    reopen(f);
    await expect(acknowledge(f, record)).resolves.toEqual({ acknowledged: true });
    expect((await page(f)).receipts).toEqual([]);
  });

  it("pages beyond 64 same-clock records while acknowledgements remove earlier rows", async () => {
    const f = fixture();
    const records = Array.from({ length: 130 }, (_, i) => admit(f, String(i), owner, 1));
    admit(f, "foreign", { ...owner, sessionId: "session-two" }, 1);
    const first = await page(f);
    expect(first.receipts).toHaveLength(64);
    expect(first.next).not.toBeNull();
    for (const record of first.receipts) {
      const terminal = settle(f, f.grants.acquisitions.get(record.acquisitionId, owner)!);
      await acknowledge(f, terminal);
    }
    const second = await page(f, first.next!);
    const third = await page(f, second.next!);
    expect(second.receipts).toHaveLength(64);
    expect(third.receipts).toHaveLength(2);
    expect(third.next).toBeNull();
    const ids = [...first.receipts, ...second.receipts, ...third.receipts].map(
      (r) => r.acquisitionId
    );
    expect(new Set(ids)).toEqual(new Set(records.map((r) => r.acquisitionId)));
    expect((await page(f)).receipts).toHaveLength(64);
  });

  it("refuses acknowledgement of pending work and invalid cursor bounds", async () => {
    const f = fixture();
    const record = admit(f);
    await expect(
      invoke(f, context(), "acknowledgeAcquisition", {
        acquisitionId: record.acquisitionId,
        resolutionDigest: record.bindingDigest,
      })
    ).rejects.toThrow(/does not match/);
    for (const createdAt of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      await expect(page(f, { createdAt, acquisitionId: record.acquisitionId })).rejects.toThrow(
        /invalid args/i
      );
    expect((await page(f)).receipts).toHaveLength(1);
  });

  it("allows receipt inspection but refuses acknowledgement under read-only containment", async () => {
    const f = fixture();
    const record = settle(f, admit(f));
    const readOnly = { ...context(), readOnly: true };
    expect((await receipt(f, record.acquisitionId, readOnly))?.state).toBe("decided");
    await expect(acknowledge(f, record, readOnly)).rejects.toThrow(/read.only/i);
    expect(f.grants.acquisitions.get(record.acquisitionId, owner)?.acknowledgedAt).toBeUndefined();
  });

  it("requires authenticated handler context rather than falling back to the runtime", async () => {
    const f = fixture();
    const service = createAuthorityService({
      dispatcher: {} as never,
      grants: f.grants,
      acquisitions: {} as never,
    });
    for (const [method, input] of [
      ["acquisitionReceipt", { acquisitionId: "acq:absent" }],
      ["outstandingAcquisitions", {}],
      ["acknowledgeAcquisition", { acquisitionId: "acq:absent", resolutionDigest: "0".repeat(64) }],
      ["awaitDecision", { acquisitionId: "acq:absent" }],
    ] as const)
      await expect(service.handler(context(), method, [input])).rejects.toMatchObject({
        code: "EACCES",
      });
  });

  it("retains structured failures and closed outcomes as canonical data, without forging a decision", async () => {
    const f = fixture();
    const failed = admit(f, "failed");
    f.grants.acquisitions.resolve(
      failed.acquisitionId,
      owner,
      failed.bindingDigest,
      { kind: "failure" },
      () => ({
        state: "failed",
        value: { state: "failed", error: { message: "original failure", code: "ECONNECTION" } },
      }),
      2
    );
    const pending = admit(f, "retired");
    f.grants.acquisitions.retire(owner, 3);
    const observed = await receipt(f, failed.acquisitionId);
    expect(observed?.state).toBe("failed");
    if (observed?.state !== "failed") throw new Error("Missing canonical failure receipt");
    expect(observed.resolution).toEqual({
      state: "failed",
      error: { message: "original failure", code: "ECONNECTION" },
    });
    expect((await receipt(f, pending.acquisitionId))?.state).toBe("closed");
    expect(await page(f)).toEqual({ receipts: [], next: null });
    expect(() => admit(f, "new")).toThrow(/retired/);
  });

  it("rejects corrupt receipt contents and malformed terminal wire shapes", async () => {
    const f = fixture();
    const record = settle(f, admit(f));
    const valid = await receipt(f, record.acquisitionId);
    expect(() => authorityAcquisitionReceiptSchema.parse({ ...valid, state: "pending" })).toThrow();
    expect(() =>
      authorityAcquisitionReceiptSchema.parse({ ...valid, resolutionDigest: undefined })
    ).toThrow();
    const sql = new DatabaseSync(f.grants.databasePath);
    try {
      sql
        .prepare("UPDATE authority_acquisitions SET resolution_json=? WHERE acquisition_id=?")
        .run(
          '{"state":"decided","value":{"state":"decided","decision":"deny"}}',
          record.acquisitionId
        );
    } finally {
      sql.close();
    }
    await expect(receipt(f, record.acquisitionId)).rejects.toThrow(/verification/);
    await expect(page(f)).rejects.toThrow(/verification/);
  });
});
