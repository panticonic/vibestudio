import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ServiceDispatcher,
  createVerifiedCaller,
  type ServiceContext,
} from "@vibestudio/shared/serviceDispatcher";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import type { MissionExecution } from "@vibestudio/automation/mission";
import { createAuthorityService } from "./authorityService.js";
import { AuthorityPlanStore } from "./authorityPlanStore.js";
import { resolveCodeIdentity } from "./principalIdentity.js";
import { createVcsService } from "./vcsService.js";

const fixtures: Array<{ store: AuthorityPlanStore; path: string }> = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.store.close();
    rmSync(f.path, { recursive: true, force: true });
  }
});
function fixture() {
  const path = mkdtempSync(join(tmpdir(), "authority-plan-lifecycle-"));
  const store = new AuthorityPlanStore({ statePath: path });
  fixtures.push({ store, path });
  const entityCache = new EntityCache();
  const runtimeId = "do:workers/agent:Agent:one";
  const code = {
    callerId: runtimeId,
    callerKind: "do" as const,
    repoPath: "workers/agent",
    effectiveVersion: "a".repeat(64),
    executionDigest: "b".repeat(64),
    requested: [],
  };
  const binding = {
    entityId: runtimeId,
    contextId: "context:conversation",
    channelId: "channel:conversation",
  };
  const entity = {
    id: runtimeId,
    kind: "do",
    source: { repoPath: code.repoPath, effectiveVersion: code.effectiveVersion },
    contextId: binding.contextId,
    agentBinding: binding,
    className: "Agent",
    key: "one",
    activeBuildKey: "build:agent",
    activeExecutionDigest: code.executionDigest,
    activeAuthority: { requests: [], provides: [] },
    authoritySessionId: "lifecycle:agent",
    ownerUserId: "alice",
    status: "active",
    createdAt: 1,
    cleanupComplete: true,
  } as EntityRecord;
  entityCache._onActivate(entity);
  const caller = createVerifiedCaller(runtimeId, "do", code, binding, {
    userId: "alice",
    handle: "alice",
  });
  const ctx: ServiceContext = { caller };
  const semanticCall = vi.fn(async () => ({ contextId: binding.contextId }));
  const vcs = createVcsService({
    workspaceVcs: { semanticCall } as never,
    entityCache,
    listOwnedContexts: async () => ({ contexts: [] }),
  });
  const dispatcher = new ServiceDispatcher();
  dispatcher.registerService(vcs);
  dispatcher.markInitialized();
  const acquisitions = {
    registerTargetSubject: vi.fn(),
    requestTaskRulesForTarget: vi.fn(),
    targetSubject: () => null,
  };
  const service = createAuthorityService({
    dispatcher,
    acquisitions: acquisitions as never,
    authorityPlans: store,
    workspaceId: "workspace:one",
    resolveAuthorEntity: (id) => entityCache.resolveActive(id),
    resolveCodeIdentity: (id) => resolveCodeIdentity(entityCache, id),
  });
  const execution: MissionExecution = {
    kind: "agent",
    image: {
      source: code.repoPath,
      effectiveVersion: code.effectiveVersion,
      ref: `state:${"c".repeat(64)}`,
      className: "Agent",
      objectKey: "one",
    },
    action: { kind: "eval", code: "return await vcs.status();" },
    conversation: {
      mode: "continue",
      contextId: binding.contextId,
      channelId: binding.channelId,
      executorId: runtimeId,
    },
    operations: [
      { service: "vcs", method: "status", args: [{ contextId: binding.contextId }], use: "action" },
    ],
  };
  const compile = () =>
    service.handler(ctx, "compileAuthorityPlan", [{ execution }]) as Promise<{ digest: string }>;
  const verify = (
    digest: string,
    input: MissionExecution = execution,
    owner: ServiceContext = ctx
  ) =>
    service.handler(owner, "verifyAuthorityPlan", [
      { authorityPlanDigest: digest, execution: input },
    ]);
  return {
    store,
    entityCache,
    entity,
    caller,
    ctx,
    execution,
    code,
    binding,
    compile,
    verify,
    service,
    dispatcher,
    vcs,
    semanticCall,
    acquisitions,
  };
}

describe("author-bound authority plan lifecycle", () => {
  it("compiles real context-local VCS status once, then verifies from its controller without borrowing the controller graph", async () => {
    const f = fixture();
    await f.vcs.handler({ ...f.ctx, authorization: {} as never }, "status", [
      { contextId: f.binding.contextId },
    ]);
    expect(f.semanticCall).toHaveBeenCalledOnce();
    f.semanticCall.mockClear();
    const prepare = vi.spyOn(f.vcs.authorityPreparation!, "vcs.files.status");
    const plan = await f.compile();
    expect(prepare).toHaveBeenCalledOnce();
    const controller = createVerifiedCaller("do:workers/missions:MissionsDO:workspace", "do");
    await expect(
      f.verify(plan.digest, f.execution, { caller: controller, invokingCaller: f.caller })
    ).resolves.toMatchObject({ schemaVersion: 2, digest: plan.digest });
    expect(prepare).toHaveBeenCalledOnce();
    expect(f.semanticCall).not.toHaveBeenCalled();
    expect(f.acquisitions.registerTargetSubject).not.toHaveBeenCalled();
    expect(f.acquisitions.requestTaskRulesForTarget).not.toHaveBeenCalled();
    await expect(
      f.dispatcher.compileAuthorityPlanOperation(
        { caller: controller },
        {
          service: "vcs",
          method: "status",
          args: [{ contextId: f.binding.contextId }],
          use: "action",
        }
      )
    ).rejects.toThrow(/context read authority|reachable context graph/);
  });

  it("matches the immediate EvalDO author rather than the root review initiator", async () => {
    const f = fixture();
    const rootPlan = await f.compile();
    const evalId = "do:vibestudio/internal:EvalDO:one";
    const evalEntity = {
      ...f.entity,
      id: evalId,
      authoritySessionId: "lifecycle:eval",
      className: "EvalDO",
      source: { repoPath: "vibestudio/internal", effectiveVersion: "d".repeat(64) },
      activeBuildKey: "build:eval",
      activeExecutionDigest: "d".repeat(64),
      parentId: f.entity.id,
      stateArgs: {
        ownerPrincipalId: f.entity.id,
        agentExecutionAdmission: { v: 1, ownerId: f.entity.id },
      },
    };
    f.entityCache._onActivate(evalEntity);
    const evalCaller = {
      ...f.caller,
      runtime: { id: evalId, kind: "do" as const },
      code: resolveCodeIdentity(f.entityCache, evalId)!,
    };
    const evalPlan = (await f.service.handler({ caller: evalCaller }, "compileAuthorityPlan", [
      { execution: f.execution },
    ])) as { digest: string };
    const controller = {
      caller: createVerifiedCaller("do:missions", "do"),
      invokingCaller: evalCaller,
      authorizingCaller: f.caller,
    };
    await expect(f.verify(evalPlan.digest, f.execution, controller)).resolves.toMatchObject({
      digest: evalPlan.digest,
    });
    await expect(f.verify(rootPlan.digest, f.execution, controller)).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  it("accepts an authorized same-owner UI author for the exact live continuing target", async () => {
    const f = fixture();
    const panelId = "panel:automation-editor";
    f.entityCache._onActivate({
      ...f.entity,
      id: panelId,
      kind: "panel",
      authoritySessionId: "lifecycle:panel",
      agentBinding: undefined,
    });
    const panel = createVerifiedCaller(
      panelId,
      "panel",
      { ...f.code, callerId: panelId, callerKind: "panel" },
      null,
      f.caller.subject
    );
    const execution = { ...f.execution, operations: [] };
    const plan = (await f.service.handler({ caller: panel }, "compileAuthorityPlan", [
      { execution },
    ])) as { digest: string };
    await expect(
      f.verify(plan.digest, execution, {
        caller: createVerifiedCaller("do:missions", "do"),
        invokingCaller: panel,
      })
    ).resolves.toMatchObject({ digest: plan.digest });
  });

  it.each(["action", "args", "use", "image", "context", "channel", "key"])(
    "rejects changed %s intent before any acquisition",
    async (field) => {
      const f = fixture();
      const plan = await f.compile();
      const changed = structuredClone(f.execution);
      if (field === "action" && changed.kind === "agent")
        changed.action = { kind: "eval", code: "return 42;" };
      if (field === "args")
        changed.operations = [
          { ...changed.operations[0]!, args: [{ contextId: "context:foreign" }] },
        ];
      if (field === "use") changed.operations = [{ ...changed.operations[0]!, use: "conditional" }];
      if (field === "image") changed.image.effectiveVersion = "d".repeat(64);
      if (field === "key") changed.image.objectKey = "other";
      if (changed.kind === "agent" && changed.conversation.mode === "continue") {
        if (field === "context") changed.conversation.contextId = "context:foreign";
        if (field === "channel") changed.conversation.channelId = "channel:foreign";
      }
      await expect(f.verify(plan.digest, changed)).rejects.toMatchObject({ code: "EACCES" });
      expect(f.acquisitions.registerTargetSubject).not.toHaveBeenCalled();
    }
  );

  it.each([
    "actor",
    "user",
    "workspace",
    "context",
    "lifecycle",
    "retired",
    "code",
    "targetOwner",
    "targetChannel",
  ])("rejects wrong or stale %s binding", async (field) => {
    const f = fixture();
    const plan = await f.compile();
    let ctx = f.ctx;
    if (field === "actor") {
      const id = "do:other";
      f.entityCache._onActivate({ ...f.entity, id });
      ctx = {
        caller: { ...f.caller, runtime: { id, kind: "do" }, code: { ...f.code, callerId: id } },
      };
    }
    if (field === "workspace") ctx = { caller: { ...f.caller, workspaceId: "workspace:foreign" } };
    if (field === "user")
      ctx = { caller: { ...f.caller, subject: { userId: "bob", handle: "bob" } } };
    if (field === "context") f.entityCache._onActivate({ ...f.entity, contextId: "context:other" });
    if (field === "lifecycle")
      f.entityCache._onActivate({ ...f.entity, authoritySessionId: "lifecycle:new" });
    if (field === "retired") f.entityCache._onRetire({ ...f.entity, status: "retired" });
    if (field === "code")
      ctx = { caller: { ...f.caller, code: { ...f.code, executionDigest: "e".repeat(64) } } };
    if (field === "targetOwner") f.entityCache._onActivate({ ...f.entity, ownerUserId: "bob" });
    if (field === "targetChannel")
      f.entityCache._onActivate({
        ...f.entity,
        agentBinding: { ...f.binding, channelId: "channel:other" },
      });
    await expect(f.verify(plan.digest, f.execution, ctx)).rejects.toMatchObject({ code: "EACCES" });
  });

  it("does not accept unknown or unbound historical artifacts for a new definition", async () => {
    const f = fixture();
    await expect(f.verify("f".repeat(64))).rejects.toMatchObject({ code: "EACCES" });
    const historical = vi.spyOn(f.store, "get").mockReturnValue({ schemaVersion: 1 } as never);
    await expect(f.verify("a".repeat(64))).rejects.toMatchObject({ code: "EACCES" });
    historical.mockRestore();
  });
});
