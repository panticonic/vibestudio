import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVerifiedCaller, ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import { z } from "zod";
import { testAuthority } from "@vibestudio/shared/serviceDispatcherTestUtils";
import type { AcquisitionRequestInput } from "./acquisitionCoordinator.js";
import {
  createInvocationSnapshot,
  invocationSnapshotDigest,
} from "@vibestudio/shared/authority/invocationSnapshot";
import { createAuthorityService } from "./authorityService.js";
import { authorizeVerifiedCaller } from "./authorityRuntime.js";
import { taskAuthorityPrincipal } from "./taskAuthorityRegistry.js";
import { AgentExecutionSessionRegistry } from "./agentExecutionSessionRegistry.js";
import { AcquisitionCoordinator } from "./acquisitionCoordinator.js";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { createApprovalQueue } from "./approvalQueue.js";

function planActorFixture(runtimeId = "do:compiler") {
  const code = {
    callerId: runtimeId,
    callerKind: "do" as const,
    repoPath: "workers/compiler",
    effectiveVersion: "a".repeat(64),
    executionDigest: "b".repeat(64),
    requested: [],
  };
  const caller = createVerifiedCaller(runtimeId, "do", code, null, {
    userId: "alice",
    handle: "alice",
  });
  const author = {
    workspaceId: "workspace:one",
    userId: "alice",
    runtimeId,
    authoritySessionId: "lifecycle:compiler",
    contextId: "context:compiler",
    code: {
      repoPath: code.repoPath,
      effectiveVersion: code.effectiveVersion,
      executionDigest: code.executionDigest,
    },
    agentBinding: null,
  };
  const deps = {
    workspaceId: author.workspaceId,
    resolveCodeIdentity: () => code,
    resolveAuthorEntity: () =>
      ({
        status: "active",
        authoritySessionId: author.authoritySessionId,
        contextId: author.contextId,
      }) as never,
  };
  return { caller, author, deps };
}
const plannedExecution = {
  kind: "method" as const,
  image: {
    source: "workers/compiler",
    ref: `state:${"c".repeat(64)}` as const,
    effectiveVersion: "a".repeat(64),
    className: "Compiler",
    objectKey: "one",
  },
  method: "run",
  args: [],
  operations: [],
};

function executionInput(
  kind: "agent-turn" | "method" | "eval" = "agent-turn"
): Parameters<AgentExecutionSessionRegistry["admitExecution"]>[0] {
  const runtimeId = "do:workers/agent:Agent:one";
  return {
    admissionKey: "execution:one",
    controllerRuntimeId: "do:workers/missions:MissionsDO:workspace",
    mode: "mission",
    ownerUser: "user:alice",
    workspaceId: "workspace:one",
    contextId: "context:one",
    agentBinding: null,
    taskRef: "run:one",
    taskAuthority: "task:one",
    executionImage: {
      principal: "code:workers/agent@one",
      repoPath: "workers/agent",
      ref: "state:one",
      effectiveVersion: "one",
      executionDigest: "a".repeat(64),
    },
    executor:
      kind === "agent-turn"
        ? { kind, runtimeId, entityId: runtimeId, channelId: "channel:one", turnId: "turn:one" }
        : kind === "method"
          ? {
              kind,
              runtimeId,
              invocationId: "invocation:one",
              service: "workers/agent",
              method: "run",
            }
          : {
              kind,
              runtimeId,
              evalRunId: "run:one",
              authorityManifest: {
                mode: "adaptive",
                effects: "read-write",
                approvals: "prompt",
                requests: [],
                digest: "0".repeat(64),
              },
            },
    mission: {
      subject: `mission:one@${"c".repeat(64)}`,
      missionId: "one",
      revision: 1,
      revisionDigest: "c".repeat(64),
    },
    authorityPlanDigest: "b".repeat(64),
    parent: null,
    causalParent: null,
  };
}

const executionFixtures: Array<{
  statePath: string;
  grants: CapabilityGrantStore;
  acquisitions: AcquisitionCoordinator;
}> = [];

function executionFixture(kind: "agent-turn" | "method" | "eval" = "agent-turn") {
  const statePath = mkdtempSync(join(tmpdir(), "authority-finish-execution-"));
  const grants = new CapabilityGrantStore({ statePath });
  const queue = createApprovalQueue({
    eventService: { emitProjected: () => {} } as never,
    scopeAccess: { isMember: () => true, isAdmin: () => true },
  });
  const acquisitions = new AcquisitionCoordinator({ grantStore: grants, approvalQueue: queue });
  executionFixtures.push({ statePath, grants, acquisitions });
  const registry = new AgentExecutionSessionRegistry();
  const fact = registry.admitExecution(executionInput(kind));
  const service = createAuthorityService({
    dispatcher: {} as never,
    acquisitions,
    executionAdmissions: registry,
  });
  const finish = (controllerRuntimeId = fact.controllerRuntimeId) =>
    service.handler(
      { caller: createVerifiedCaller(controllerRuntimeId, "do") },
      "finishExecution",
      [{ authoritySessionId: fact.authoritySessionId }]
    );
  const snapshot = createInvocationSnapshot({
    service: "gateway",
    method: "fetch",
    capability: "workspace.gateway.access",
    capabilityDefinitionDigest: "-",
    resourceType: "network",
    provider: "-",
    providerExecutionDigest: "-",
    resourceKey: "https://example.com",
    args: ["https://example.com"],
    preparedStateDigest: "-",
    callerPrincipal: `session:${fact.authoritySessionId}`,
    sessionId: fact.authoritySessionId,
    taskAuthority: "task:one",
    missionSubject: "-",
    snippetDigest: "a".repeat(64),
    codeLineage: { class: "internal", chain: [] },
    initiatorChain: ["user:alice"],
  });
  const info = acquisitions.request({
    snapshot,
    snapshotDigest: invocationSnapshotDigest(snapshot),
    tier: "gated",
    caller: createVerifiedCaller(fact.executor.runtimeId, "do"),
    renderedAction: "read example.com",
    resource: { kind: "exact", key: snapshot.resourceKey },
  });
  const owner = { ownerRuntimeId: fact.executor.runtimeId, sessionId: fact.authoritySessionId };
  return {
    statePath,
    grants,
    queue,
    acquisitions,
    registry,
    fact,
    info,
    owner,
    finish,
    service,
    snapshot,
  };
}

afterEach(async () => {
  for (const f of executionFixtures.splice(0)) {
    try {
      await f.acquisitions.closeAll();
      await Promise.resolve();
    } finally {
      f.grants.close();
      rmSync(f.statePath, { recursive: true });
    }
  }
});

describe("authorityService execution completion", () => {
  it("withdraws only the authenticated original acquisition and preserves sibling work", async () => {
    const f = executionFixture();
    const snapshot = createInvocationSnapshot({ ...f.snapshot, args: ["another operation"] });
    const sibling = f.acquisitions.request({
      snapshot,
      snapshotDigest: invocationSnapshotDigest(snapshot),
      tier: "gated",
      caller: createVerifiedCaller(f.owner.ownerRuntimeId, "do"),
      renderedAction: "read example.com again",
      resource: { kind: "exact", key: snapshot.resourceKey },
    });
    const record = f.grants.acquisitions.get(f.info.acquisitionId, f.owner)!;
    const context = {
      caller: createVerifiedCaller(f.owner.ownerRuntimeId, "do"),
      authorization: { session: { id: f.owner.sessionId } },
    } as never;
    const input = { acquisitionId: record.acquisitionId, bindingDigest: record.bindingDigest };
    for (const foreign of [
      {
        caller: createVerifiedCaller("do:foreign", "do"),
        authorization: { session: { id: f.owner.sessionId } },
      },
      {
        caller: createVerifiedCaller(f.owner.ownerRuntimeId, "do"),
        authorization: { session: { id: "foreign-session" } },
      },
      { caller: createVerifiedCaller(f.owner.ownerRuntimeId, "do") },
    ])
      await expect(
        f.service.handler(foreign as never, "withdrawAcquisition", [input])
      ).rejects.toMatchObject({ code: "EACCES" });
    expect(f.queue.listPending()).toHaveLength(2);
    const withdrawn = await f.service.handler(context, "withdrawAcquisition", [input]);
    expect(withdrawn).toMatchObject({
      state: "closed",
      resolution: { state: "closed", reason: "operation-ended" },
    });
    expect(f.queue.listPending()).toHaveLength(1);
    expect(f.grants.acquisitions.get(sibling.acquisitionId, f.owner)?.state).toBe("pending");
    await expect(f.service.handler(context, "withdrawAcquisition", [input])).resolves.toEqual(
      withdrawn
    );
    expect(
      f.grants.acquisitions.admit({ ...f.owner, requestKey: "still-active", facts: {} }).state
    ).toBe("pending");
  });

  it("retains the pending prompt and original write failure until exact withdrawal can commit", async () => {
    const f = executionFixture();
    const record = f.grants.acquisitions.get(f.info.acquisitionId, f.owner)!;
    const context = {
      caller: createVerifiedCaller(f.owner.ownerRuntimeId, "do"),
      authorization: { session: { id: f.owner.sessionId } },
    } as never;
    const input = { acquisitionId: record.acquisitionId, bindingDigest: record.bindingDigest };
    const sql = new DatabaseSync(f.grants.databasePath);
    try {
      sql.exec(
        "CREATE TRIGGER reject_exact_withdrawal BEFORE UPDATE ON authority_acquisitions WHEN NEW.state = 'closed' BEGIN SELECT RAISE(ABORT, 'exact withdrawal rejected'); END"
      );
      await expect(f.service.handler(context, "withdrawAcquisition", [input])).rejects.toThrow(
        "exact withdrawal rejected"
      );
      expect(f.queue.listPending()).toHaveLength(1);
      expect(f.grants.acquisitions.get(record.acquisitionId, f.owner)).toEqual(record);
      sql.exec("DROP TRIGGER reject_exact_withdrawal");
      await expect(
        f.service.handler(context, "withdrawAcquisition", [input])
      ).resolves.toMatchObject({ state: "closed" });
      expect(f.queue.listPending()).toEqual([]);
    } finally {
      sql.exec("DROP TRIGGER IF EXISTS reject_exact_withdrawal");
      sql.close();
    }
  });

  it.each(["agent-turn", "method"] as const)(
    "closes %s approval receipts and prompts before releasing execution admission, once",
    async (kind) => {
      const f = executionFixture(kind);
      expect(f.queue.listPending()).toHaveLength(1);
      const unrelatedOwner = { ...f.owner, sessionId: "unrelated-session" };
      const unrelated = f.grants.acquisitions.admit({
        ...unrelatedOwner,
        requestKey: "unrelated-session/request",
        facts: {},
      });
      const wait = f.acquisitions.awaitDecision({
        acquisitionId: f.info.acquisitionId,
        ...f.owner,
      });
      const closeSession = vi.spyOn(f.acquisitions, "closeSession");
      await expect(f.finish()).resolves.toBeUndefined();
      await expect(wait).resolves.toMatchObject({ state: "closed" });
      expect(f.queue.listPending()).toEqual([]);
      expect(f.acquisitions.pending()).toEqual([]);
      expect(f.grants.acquisitions.get(f.info.acquisitionId, f.owner)).toMatchObject({
        state: "closed",
        resolution: { state: "closed", value: { reason: "owner-retired" } },
      });
      expect(f.grants.acquisitions.outstanding(f.owner)).toEqual([]);
      expect(f.grants.acquisitions.get(unrelated.acquisitionId, unrelatedOwner)?.state).toBe(
        "pending"
      );
      expect(f.registry.resolveInvocation(f.fact.executor.runtimeId, f.fact.nonce)).toBeNull();
      await expect(f.finish()).resolves.toBeUndefined();
      expect(closeSession).toHaveBeenCalledExactlyOnceWith(f.fact.authoritySessionId);
      expect(() =>
        f.grants.acquisitions.admit({ ...f.owner, requestKey: "later", facts: {} })
      ).toThrow(/retired/);
    }
  );

  it("refuses a foreign controller before closing any canonical receipt or prompt", async () => {
    const f = executionFixture();
    const closeSession = vi.spyOn(f.acquisitions, "closeSession");
    await expect(f.finish("do:workers/other:Controller:one")).rejects.toThrow(
      /admission controller/
    );
    expect(closeSession).not.toHaveBeenCalled();
    expect(f.grants.acquisitions.get(f.info.acquisitionId, f.owner)?.state).toBe("pending");
    expect(f.queue.listPending()).toHaveLength(1);
    expect(f.registry.resolveInvocation(f.fact.executor.runtimeId, f.fact.nonce)).toBe(f.fact);
  });

  it("propagates canonical closure failure and retains authenticated authority for an exact retry", async () => {
    const f = executionFixture();
    const sql = new DatabaseSync(f.grants.databasePath);
    const originalClose = f.acquisitions.closeSession.bind(f.acquisitions);
    let closureFailure: unknown;
    vi.spyOn(f.acquisitions, "closeSession").mockImplementation(async (sessionId) => {
      try {
        await originalClose(sessionId);
      } catch (error) {
        closureFailure = error;
        throw error;
      }
    });
    try {
      sql.exec(
        "CREATE TRIGGER reject_execution_closure BEFORE UPDATE ON authority_acquisitions WHEN NEW.state = 'closed' BEGIN SELECT RAISE(ABORT, 'canonical execution closure rejected'); END"
      );
      const observed = await f.finish().then(
        () => undefined,
        (error: unknown) => error
      );
      expect(observed).toBe(closureFailure);
      expect(observed).toBeInstanceOf(Error);
      expect(observed).toMatchObject({ message: "canonical execution closure rejected" });
      expect(f.registry.resolveInvocation(f.fact.executor.runtimeId, f.fact.nonce)).toBe(f.fact);
      expect(f.grants.acquisitions.get(f.info.acquisitionId, f.owner)?.state).toBe("pending");
      expect(f.grants.acquisitions.outstanding(f.owner)).toHaveLength(1);
      expect(f.queue.listPending()).toHaveLength(1);
      sql.exec("DROP TRIGGER reject_execution_closure");
      await expect(f.finish()).resolves.toBeUndefined();
      expect(f.registry.resolveInvocation(f.fact.executor.runtimeId, f.fact.nonce)).toBeNull();
      expect(f.grants.acquisitions.get(f.info.acquisitionId, f.owner)?.state).toBe("closed");
      expect(f.queue.listPending()).toEqual([]);
    } finally {
      sql.exec("DROP TRIGGER IF EXISTS reject_execution_closure");
      sql.close();
    }
  });

  it("finishes an eval cell without retiring its retained notebook-history authority", async () => {
    const f = executionFixture("eval");
    const closeSession = vi.spyOn(f.acquisitions, "closeSession");
    await expect(f.finish()).resolves.toBeUndefined();
    expect(closeSession).not.toHaveBeenCalled();
    expect(f.registry.resolve(f.fact.executor.runtimeId)).toBe(f.fact);
    expect(f.grants.acquisitions.get(f.info.acquisitionId, f.owner)?.state).toBe("pending");
    expect(f.queue.listPending()).toHaveLength(1);
    const secondInput = executionInput("eval");
    if (secondInput.executor.kind !== "eval") throw new Error("Expected eval input");
    const second = f.registry.admitExecution({
      ...secondInput,
      admissionKey: "execution:two",
      executor: { ...secondInput.executor, evalRunId: "run:two" },
    });
    expect(second.authoritySessionId).toBe(f.fact.authoritySessionId);
    expect(f.registry.resolveInvocation(second.executor.runtimeId, second.nonce)).toBe(second);
  });
});

describe("authorityService", () => {
  it("lists and resets rules by the workspace-qualified chat binding", async () => {
    const subject = taskAuthorityPrincipal({
      workspaceId: "workspace:one",
      contextId: "context:agent",
      channelId: "channel:task",
    });
    const revokeSubject = vi.fn((_subject: string) => 1);
    const service = createAuthorityService({
      dispatcher: {} as never,
      acquisitions: {} as never,
      workspaceId: "workspace:one",
      grants: {
        listActiveAuthorityGrants: () => [
          {
            id: "grant:one",
            effect: "allow",
            capability: "panel.inspect",
            resource: { kind: "exact", key: "panel:task-board" },
            subject,
            constraints: { lineageAtConsent: ["none"] },
            issuedBy: "user:alice",
            provenance: "acquisition",
            createdAt: 10,
            scope: "task",
          },
        ],
        revokeSubject,
        transaction: (work: () => unknown) => work(),
      } as never,
    });
    const ctx = {
      caller: createVerifiedCaller("panel:chat", "panel", null, null, {
        userId: "alice",
        handle: "alice",
      }),
    } as never;
    const input = { contextId: "context:agent", channelId: "channel:task" };

    await expect(service.handler(ctx, "listTaskRules", [input])).resolves.toEqual([
      {
        id: "grant:one",
        capability: "panel.inspect",
        action: expect.any(String),
        resource: "panel:task-board",
        decidedAt: 10,
      },
    ]);
    await expect(service.handler(ctx, "resetTaskRules", [input])).resolves.toEqual({
      revokedGrantCount: 1,
    });
    expect(revokeSubject).toHaveBeenCalledWith(subject);
  });

  it("resets every agent task subject stamped with the same chat and no other chat", async () => {
    const chatOne = "channel:shared-task";
    const firstSubject = taskAuthorityPrincipal({
      workspaceId: "workspace:one",
      contextId: "context:first-agent",
      channelId: chatOne,
    });
    const secondSubject = taskAuthorityPrincipal({
      workspaceId: "workspace:one",
      contextId: "context:second-agent",
      channelId: chatOne,
    });
    const otherSubject = taskAuthorityPrincipal({
      workspaceId: "workspace:one",
      contextId: "context:first-agent",
      channelId: "channel:other-task",
    });
    const active = [
      { id: "grant:first", subject: firstSubject, taskRef: chatOne },
      { id: "grant:second", subject: secondSubject, taskRef: chatOne },
      { id: "grant:other", subject: otherSubject, taskRef: "channel:other-task" },
    ].map(({ id, subject, taskRef }) => ({
      id,
      effect: "allow" as const,
      capability: "panel.inspect",
      resource: { kind: "exact" as const, key: "panel:task-board" },
      subject,
      constraints: { taskRef, lineageAtConsent: ["none"] },
      issuedBy: "user:alice" as const,
      provenance: "acquisition" as const,
      createdAt: 10,
      scope: "task" as const,
    }));
    const revokeSubject = vi.fn((_subject: string) => 1);
    const service = createAuthorityService({
      dispatcher: {} as never,
      acquisitions: {} as never,
      workspaceId: "workspace:one",
      grants: {
        listActiveAuthorityGrants: () => active,
        revokeSubject,
        transaction: (work: () => unknown) => work(),
      } as never,
    });
    const ctx = {
      caller: createVerifiedCaller("panel:chat", "panel", null, null, {
        userId: "alice",
        handle: "alice",
      }),
    } as never;
    const input = { contextId: "context:first-agent", channelId: chatOne };

    await expect(service.handler(ctx, "listTaskRules", [input])).resolves.toHaveLength(2);
    await expect(service.handler(ctx, "resetTaskRules", [input])).resolves.toEqual({
      revokedGrantCount: 2,
    });
    expect(new Set(revokeSubject.mock.calls.map(([subject]) => subject))).toEqual(
      new Set([firstSubject, secondSubject])
    );
    expect(revokeSubject).not.toHaveBeenCalledWith(otherSubject);
  });

  it("forwards cancellation and keeps internal grant identity out of the wait result", async () => {
    const signal = new AbortController().signal;
    const awaitDecision = vi.fn(async () => ({
      state: "decided" as const,
      decision: "once" as const,
      grantId: "grant:internal",
    }));
    const service = createAuthorityService({
      dispatcher: { preflightAuthority: vi.fn() } as never,
      acquisitions: { awaitDecision } as never,
    });

    const caller = createVerifiedCaller("agent:1", "agent");
    const authorization = authorizeVerifiedCaller(caller, {
      workspaceId: "workspace:one",
      workspaceMember: true,
      sessionId: "authority:session-one",
      audience: "service:authority",
      capability: "authority.awaitDecision",
      resourceKey: "-",
    }).context;
    await expect(
      service.handler({ caller, signal, authorization }, "awaitDecision", [
        { acquisitionId: "acq:1" },
      ])
    ).resolves.toEqual({ state: "decided", decision: "once" });
    expect(awaitDecision).toHaveBeenCalledWith({
      acquisitionId: "acq:1",
      ownerRuntimeId: "agent:1",
      sessionId: "authority:session-one",
      signal,
    });
  });

  it.each(["compiled", "existing"])(
    "matches a static plan against runtime receiver identity and preserves %s grants",
    async (grantKind) => {
      const statePath = mkdtempSync(join(tmpdir(), "authority-plan-runtime-"));
      const grants = new CapabilityGrantStore({ statePath });
      try {
        const dispatcher = new ServiceDispatcher();
        const capability = "runtime.supervision.manage";
        const caller = createVerifiedCaller("app:compiler", "app", undefined, null, {
          userId: "alice",
          handle: "alice",
        });
        const baseline = testAuthority(caller, capability, "activate:app:task-board");
        dispatcher.setAuthorityResolver(() => ({
          ...baseline,
          grants: grants.grantsForSubjects(
            [baseline.context.authorizingOrigin.principal],
            capability
          ),
        }));
        const request = vi.fn((input: AcquisitionRequestInput) => ({
          acquisitionId: "acq:runtime",
          ownerRuntimeId: caller.runtime.id,
          snapshotDigest: input.snapshotDigest,
          capability,
          resourceKey: input.snapshot.resourceKey,
          tier: "gated" as const,
          cardType: "permission.gated" as const,
          renderedAction: "start a workspace service",
          pending: true,
        }));
        dispatcher.setAuthorityAcquirer({
          request,
          acquire: vi.fn(),
          consume: vi.fn(),
          invalidate: vi.fn(),
        });
        const handler = vi.fn(async () => "started");
        dispatcher.registerService({
          name: "lifecycle",
          authority: { principals: ["code"] },
          handler,
          methods: {
            activate: {
              website: { kind: "eligible", rationale: "Explicit fixture policy" },
              args: z.tuple([z.object({ kind: z.string(), releaseId: z.string() })]),
              capability,
              tier: { tier: "gated", session: "family", rationale: "Starts admitted code" },
              authority: {
                requirement: { kind: "capability", principal: "code", capability },
                resource: {
                  kind: "argument-fields",
                  index: 0,
                  fields: ["kind", "releaseId"],
                  prefix: "activate:",
                },
              },
            },
          },
        });
        dispatcher.markInitialized();
        const args = [{ kind: "app", releaseId: "task-board" }];
        const leaf = (
          await dispatcher.compileAuthorityPlanOperation(
            { caller },
            { service: "lifecycle", method: "activate", args, use: "action" }
          )
        ).leaves[0]!;
        const targetSubject = "task:planned-lifecycle";
        const target = grants.targetRequests.ensure({
          targetSubject,
          authorityPlanDigest: "plan:one",
          operationKey: "activate:task-board",
          capability: leaf.capability,
          capabilityDefinitionDigest: leaf.capabilityDefinitionDigest,
          resource: leaf.resource,
          tier: "gated",
          sourceUser: "user:alice",
          review: leaf.review,
        });
        await expect(
          dispatcher.dispatch({ caller }, "lifecycle", "activate", args)
        ).rejects.toMatchObject({ code: "EACQUIRE" });
        const input = request.mock.calls[0]![0];
        expect(
          grants.targetRequests.pendingForInvocation({
            targetSubject,
            capability: input.snapshot.capability,
            capabilityDefinitionDigest: input.snapshot.capabilityDefinitionDigest,
            resource: input.resource,
          })?.requestId
        ).toBe(target.requestId);
        expect(handler).not.toHaveBeenCalled();
        grants.issue({
          effect: "allow",
          subject: baseline.context.authorizingOrigin.principal,
          capability: leaf.capability,
          resource: leaf.resource,
          issuedBy: "user:alice",
          provenance: "acquisition",
          ...(grantKind === "compiled"
            ? { capabilityDefinitionDigest: leaf.capabilityDefinitionDigest }
            : {}),
          scope: "version",
        });
        await expect(dispatcher.dispatch({ caller }, "lifecycle", "activate", args)).resolves.toBe(
          "started"
        );
        expect(handler).toHaveBeenCalledOnce();
        expect(request).toHaveBeenCalledOnce();
      } finally {
        grants.close();
        rmSync(statePath, { recursive: true });
      }
    }
  );

  it("joins context-aware operation compilation before publishing every receiver leaf", async () => {
    const compile = vi.fn(async (_ctx: unknown, input: { method: string }) => ({
      intent: input,
      definitionDigest: `${input.method}:receiver-definition`,
      leaves: [
        {
          service: "files",
          method: input.method,
          capability: "filesystem.read",
          resource: { kind: "exact" as const, key: input.method },
          tier: "gated" as const,
          capabilityDefinitionDigest: "-",
          provider: "-",
          providerEffectiveVersion: "-",
          use: "action" as const,
          review: {
            action: "read files",
            domain: "files" as const,
            verb: "see" as const,
            declaredBy: "host:files",
          },
        },
      ],
    }));
    const publish = vi.fn((_input: unknown) => ({
      bodyDigest: "a".repeat(64),
      compilerVersion: "authority-plan.v2",
      catalogDigest: "b".repeat(64),
    }));
    const actor = planActorFixture();
    const service = createAuthorityService({
      ...actor.deps,
      dispatcher: { compileAuthorityPlanOperation: compile } as never,
      acquisitions: {} as never,
      authorityPlans: { publish } as never,
    });
    const ctx = { caller: actor.caller };
    await service.handler(ctx, "compileAuthorityPlan", [
      {
        execution: {
          ...plannedExecution,
          operations: [
            { service: "files", method: "first", args: ["notes/a"], use: "action" },
            { service: "files", method: "second", use: "conditional" },
          ],
        },
      },
    ]);
    expect(compile.mock.calls[0]).toEqual([
      ctx,
      { service: "files", method: "first", args: ["notes/a"], use: "action" },
    ]);
    expect(compile.mock.calls[1]).toEqual([
      ctx,
      { service: "files", method: "second", args: [], use: "conditional" },
    ]);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      leaves: [
        expect.objectContaining({ method: "first", capabilityDefinitionDigest: "-" }),
        expect.objectContaining({ method: "second", capabilityDefinitionDigest: "-" }),
      ],
    });
  });

  it("does not publish a partial plan or start later preparation after a receiver failure", async () => {
    const failure = new Error("receiver snapshot unavailable");
    const compile = vi.fn().mockRejectedValue(failure);
    const publish = vi.fn();
    const actor = planActorFixture();
    const service = createAuthorityService({
      ...actor.deps,
      dispatcher: { compileAuthorityPlanOperation: compile } as never,
      acquisitions: {} as never,
      authorityPlans: { publish } as never,
    });
    await expect(
      service.handler({ caller: actor.caller }, "compileAuthorityPlan", [
        {
          execution: {
            ...plannedExecution,
            operations: [
              { service: "files", method: "first", use: "action" },
              { service: "files", method: "second", use: "action" },
            ],
          },
        },
      ])
    ).rejects.toBe(failure);
    expect(compile).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });

  it("lets the durable controller retire authority only after live executions close", async () => {
    const subject = `mission:timer@${"a".repeat(64)}` as const;
    const hasLiveMissionSubject = vi.fn(() => true);
    const retireTargetSubject = vi.fn(() => ({ cancelledRequests: 2 }));
    const revokeSubject = vi.fn(() => 3);
    const service = createAuthorityService({
      dispatcher: {} as never,
      acquisitions: {
        targetSubject: () => ({
          authorityPlanDigest: "b".repeat(64),
          ownerUser: "user:alice",
          controllerRuntimeId: "do:missions",
          state: "active",
        }),
        retireTargetSubject,
      } as never,
      executionAdmissions: { hasLiveMissionSubject } as never,
      grants: { revokeSubject } as never,
    });
    const context = {
      caller: createVerifiedCaller("do:missions", "do"),
    } as never;
    await expect(
      service.handler(context, "retireTarget", [{ targetSubject: subject }])
    ).rejects.toMatchObject({ code: "EBUSY" });
    hasLiveMissionSubject.mockReturnValue(false);
    await expect(
      service.handler(context, "retireTarget", [{ targetSubject: subject }])
    ).resolves.toEqual({ cancelledRequestCount: 2, revokedGrantCount: 3 });
    expect(retireTargetSubject).toHaveBeenCalledWith(subject);
    expect(revokeSubject).toHaveBeenCalledWith(subject);
  });

  it("attributes target acquisition to the verified authorizing user across a code relay", async () => {
    const registerTargetSubject = vi.fn();
    const service = createAuthorityService({
      dispatcher: {} as never,
      acquisitions: {
        targetSubject: () => null,
        registerTargetSubject,
        targetRequestsFor: () => [],
      } as never,
      authorityPlans: {
        get: () => ({ schemaVersion: 2, author: { userId: "alice" }, leaves: [] }),
      } as never,
    });
    const context = {
      caller: createVerifiedCaller("do:workers/missions:MissionsDO:workspace", "do"),
      authorizingCaller: createVerifiedCaller("agent:launcher", "agent", undefined, null, {
        userId: "alice",
        handle: "alice",
      }),
    } as never;
    const subject = `mission:timer@${"a".repeat(64)}` as const;
    await expect(
      service.handler(context, "acquireForTarget", [
        { targetSubject: subject, authorityPlanDigest: "b".repeat(64) },
      ])
    ).resolves.toEqual({ requestIds: [], grantIds: [], denialIds: [] });
    expect(registerTargetSubject).toHaveBeenCalledWith(
      subject,
      "b".repeat(64),
      "user:alice",
      "do:workers/missions:MissionsDO:workspace"
    );
  });

  it("pre-acquires an immutable plan only for the caller's attested task", async () => {
    const requestTaskRulesForTarget = vi.fn();
    const task = `task:${"d".repeat(64)}` as const;
    const actor = planActorFixture("agent:launcher");
    const service = createAuthorityService({
      ...actor.deps,
      dispatcher: {} as never,
      acquisitions: {
        requestTaskRulesForTarget,
        targetRequestsFor: () => [],
      } as never,
      authorityPlans: {
        get: () => ({
          schemaVersion: 2,
          author: actor.author,
          leaves: [
            {
              service: "notification",
              method: "showToUser",
              capability: "notification.show",
              capabilityDefinitionDigest: "c".repeat(64),
              resource: { kind: "exact", key: "user:alice" },
              tier: "gated",
              review: {
                action: "show a notification",
                domain: "people",
                verb: "act",
                declaredBy: "host:notification.showToUser",
              },
            },
          ],
        }),
      } as never,
    });
    const caller = { ...actor.caller, taskAuthority: task };

    await expect(
      service.handler({ caller } as never, "acquireForCurrentTask", [
        { authorityPlanDigest: "b".repeat(64) },
      ])
    ).resolves.toEqual({ requestIds: [], grantIds: [], denialIds: [] });
    expect(requestTaskRulesForTarget).toHaveBeenCalledWith([
      expect.objectContaining({
        targetSubject: task,
        sourceUser: "user:alice",
        capability: "notification.show",
        authorityPlanDigest: "b".repeat(64),
        resource: { kind: "exact", key: "user:alice" },
        tier: "gated",
      }),
    ]);
  });

  it("replays acquisition from the durable target owner after the launching execution ends", async () => {
    const subject = `mission:timer@${"a".repeat(64)}` as const;
    const requestForTarget = vi.fn();
    const registerTargetSubject = vi.fn();
    const service = createAuthorityService({
      dispatcher: {} as never,
      acquisitions: {
        targetSubject: () => ({
          authorityPlanDigest: "b".repeat(64),
          ownerUser: "user:alice",
          controllerRuntimeId: "do:workers/missions:MissionsDO:workspace",
          state: "active",
        }),
        registerTargetSubject,
        requestForTarget,
        targetRequestsFor: () => [],
      } as never,
      authorityPlans: {
        get: () => ({
          leaves: [
            {
              service: "accounts",
              method: "connect",
              capability: "accounts.connect",
              capabilityDefinitionDigest: "c".repeat(64),
              resource: { kind: "exact", key: "provider:example" },
              tier: "gated",
              review: {
                action: "connect an account",
                domain: "accounts",
                verb: "manage",
                declaredBy: "host:accounts.connect",
              },
            },
          ],
        }),
      } as never,
    });

    await expect(
      service.handler(
        {
          caller: createVerifiedCaller(
            "do:workers/missions:MissionsDO:workspace",
            "do",
            undefined,
            null,
            { userId: "system", handle: "system" }
          ),
        } as never,
        "acquireForTarget",
        [{ targetSubject: subject, authorityPlanDigest: "b".repeat(64) }]
      )
    ).resolves.toEqual({ requestIds: [], grantIds: [], denialIds: [] });
    expect(registerTargetSubject).not.toHaveBeenCalled();
    expect(requestForTarget).toHaveBeenCalledWith(
      expect.objectContaining({ targetSubject: subject, sourceUser: "user:alice" })
    );
  });

  it("rejects target replay from code other than the registered controller", async () => {
    const service = createAuthorityService({
      dispatcher: {} as never,
      acquisitions: {
        targetSubject: () => ({
          authorityPlanDigest: "b".repeat(64),
          ownerUser: "user:alice",
          controllerRuntimeId: "do:workers/missions:MissionsDO:workspace",
          state: "active",
        }),
        targetRequestsFor: () => [],
      } as never,
      authorityPlans: { get: () => ({ leaves: [] }) } as never,
    });
    const subject = `mission:timer@${"a".repeat(64)}` as const;
    await expect(
      service.handler(
        { caller: createVerifiedCaller("do:unrelated:Worker:one", "do") } as never,
        "acquireForTarget",
        [{ targetSubject: subject, authorityPlanDigest: "b".repeat(64) }]
      )
    ).rejects.toThrow(/different controller/);
  });

  it("rejects execution admission from code other than the registered controller", async () => {
    const service = createAuthorityService({
      dispatcher: {} as never,
      acquisitions: {
        targetSubject: () => ({
          authorityPlanDigest: "b".repeat(64),
          ownerUser: "user:alice",
          controllerRuntimeId: "do:workers/missions:MissionsDO:workspace",
          state: "active",
        }),
      } as never,
      authorityPlans: {} as never,
      executionAdmissions: {} as never,
      workspaceId: "workspace:one",
      resolveCodeIdentity: () => null,
    });
    await expect(
      service.handler(
        { caller: createVerifiedCaller("do:unrelated:Worker:one", "do") } as never,
        "admitExecution",
        [
          {
            admissionKey: "mission:timer:run:one",
            contextId: "context:one",
            taskRef: "run:one",
            mission: {
              subject: `mission:timer@${"a".repeat(64)}`,
              missionId: "timer",
              revision: 1,
              revisionDigest: "a".repeat(64),
            },
            executionImage: {
              source: "workers/agent-worker",
              ref: `state:${"c".repeat(64)}`,
              effectiveVersion: "d".repeat(64),
              className: "AiChatWorker",
            },
            authorityPlanDigest: "b".repeat(64),
            executor: {
              kind: "agent-turn",
              runtimeId: "do:workers/agent-worker:AiChatWorker:timer",
              entityId: "do:workers/agent-worker:AiChatWorker:timer",
              channelId: "channel:one",
              turnId: "run:one",
            },
          },
        ]
      )
    ).rejects.toThrow(/different mission controller/);
  });
});
