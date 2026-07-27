import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { DevelopmentSessionStore } from "./developmentSessionStore.js";
import {
  createDevelopmentService,
  developmentNativeResourceKey,
  type DevelopmentRepositoryResolver,
  type NativeDevelopmentController,
} from "./developmentService.js";
import { SystemTestBuildFaultRegistry } from "./systemTestBuildFaultRegistry.js";
import type { RuntimeServiceInternal } from "./runtimeService.js";
import { DevelopmentRecipeRegistry } from "./developmentRecipes.js";
import { developmentMethods, type DevelopmentRun } from "@vibestudio/service-schemas/development";
import type { PreparedDevelopmentBuild } from "./developmentExecutor.js";
import {
  executionArtifactDigest,
  executionSourceClosureDigest,
} from "@vibestudio/shared/execution/retention";

function setup(
  repository: DevelopmentRepositoryResolver["resolveExact"] = async () => ({
    status: "present",
    repoPath: "packages/app",
    sourceState: { kind: "event", eventId: "event:source" },
  }),
  native?: NativeDevelopmentController,
  testHooks: Pick<
    Parameters<typeof createDevelopmentService>[0],
    "armSystemTestBuildFailure" | "consumeSystemTestBuildFailure"
  > = {}
) {
  const statePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-development-"));
  const store = new DevelopmentSessionStore({ statePath });
  const runtime = {
    resolveContext: vi.fn(async () => "ctx-parent"),
    forkDevelopmentSessionContext: vi.fn(async () => ({
      contextId: "ctx-child",
      parentContextId: "ctx-parent",
      parentWorkingHead: { kind: "event" as const, eventId: "event:parent" },
      childBaseState: { kind: "event" as const, eventId: "event:child" },
    })),
    discardDevelopmentSessionContext: vi.fn(async () => {}),
  };
  const executor = {
    prepare: vi.fn(),
    materialize: vi.fn(),
    execute: vi.fn(),
    resolveClientArtifactSource: vi.fn(),
    stop: vi.fn(),
    retire: vi.fn(),
  };
  const service = createDevelopmentService({
    store,
    runtime: runtime as unknown as RuntimeServiceInternal,
    repositories: { resolveExact: repository },
    executor,
    ...(native ? { native } : {}),
    ...testHooks,
    isStateDescendant: vi.fn(async () => true),
    now: () => 100,
  });
  const caller = createVerifiedCaller("worker:agent", "worker", {
    callerId: "worker:agent",
    callerKind: "worker",
    repoPath: "workers/agent",
    effectiveVersion: "v1",
  });
  return { store, runtime, executor, service, ctx: { caller } satisfies ServiceContext };
}

async function waitForRun(
  store: DevelopmentSessionStore,
  runId: string,
  state: DevelopmentRun["state"]
): Promise<DevelopmentRun> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = store.getRun(runId);
    if (run?.state === state) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Run ${runId} did not reach ${state}`);
}

async function open(
  service: ReturnType<typeof createDevelopmentService>,
  ctx: ServiceContext,
  idempotencyKey = "open-1"
) {
  return service.handler(ctx, "openSession", [
    { repositoryId: "repository:app", mode: "semantic", idempotencyKey },
  ]);
}

function userContext(runtimeId: string, userId: string): ServiceContext {
  return {
    caller: createVerifiedCaller(
      runtimeId,
      "worker",
      {
        callerId: runtimeId,
        callerKind: "worker",
        repoPath: "workers/agent",
        effectiveVersion: "v1",
      },
      null,
      { userId, handle: userId }
    ),
  };
}

function retainedRun(
  sessionId: string,
  ownerRuntimeId: string,
  ownerUserId: string
): { run: DevelopmentRun; plan: PreparedDevelopmentBuild } {
  const recipe = new DevelopmentRecipeRegistry().list()[0]!;
  const hash = (value: string) => value.repeat(64);
  const snapshot = {
    version: 1 as const,
    sessionId,
    contextId: "ctx-child",
    repositoryId: "repository:app",
    repoPath: "packages/app",
    repositoryState: { kind: "event" as const, eventId: "event:child" },
    repositoryManifestDigest: hash("a"),
    materializedTreeDigest: hash("b"),
    contentRoot: `state:${hash("c")}`,
    sourcePlanDigest: hash("d"),
    recipeDigest: hash("e"),
    toolchain: {
      executorId: hash("f"),
      node: {
        digest: hash("1"),
        version: "v24",
        platform: process.platform,
        arch: process.arch,
      },
      pnpm: { digest: hash("2"), version: "10" },
      hostSourceBuild: { digest: hash("3") },
    },
    declaredEnvironment: recipe.declaredEnvironment,
    environmentDigest: hash("4"),
    lockfileDigest: hash("5"),
    snapshotDigest: hash("6"),
  };
  const run: DevelopmentRun = {
    version: 1,
    runId: "run-retained",
    sessionId,
    ownerRuntimeId,
    ownerRuntimeKind: "worker",
    ownerUserId,
    attachedHostAuthorityCeiling: null,
    target: { kind: "build-only" },
    recipe,
    snapshot,
    state: "accepted",
    commitPoint: "none",
    artifact: null,
    instance: null,
    hostReadiness: null,
    client: null,
    attachedHost: null,
    repair: null,
    createdAt: 100,
    updatedAt: 100,
    terminalAt: null,
  };
  return {
    run,
    plan: {
      version: 1,
      runId: run.runId,
      sourcePlan: {} as PreparedDevelopmentBuild["sourcePlan"],
      snapshot,
      recipe,
      executables: {
        nodePath: "/node",
        pnpmCliPath: "/pnpm/pnpm.cjs",
        pnpmRootPath: "/pnpm",
        pnpmCliRelativePath: "pnpm.cjs",
      },
    },
  };
}

function retainedArtifact(): NonNullable<DevelopmentRun["artifact"]> {
  const contentRoots = [{ repoPath: "packages/app", stateHash: `state:${"c".repeat(64)}` }];
  const unsigned = {
    version: 1 as const,
    sourceState: {
      kind: "workspace" as const,
      workspaceId: "workspace:test",
      effectiveVersion: "e".repeat(64) as never,
      state: { kind: "event" as const, eventId: "event:retained" },
      contentRoots,
      sourceClosureDigest: executionSourceClosureDigest(contentRoots),
    },
    recipeDigest: "a".repeat(64) as never,
    buildKey: "b".repeat(64) as never,
    artifactDigest: "d".repeat(64) as never,
  };
  return {
    ...unsigned,
    executionDigest: executionArtifactDigest(unsigned),
  } as unknown as NonNullable<DevelopmentRun["artifact"]>;
}

describe("development semantic sessions", () => {
  it("keeps the retained-snapshot build fault exact-run, expiring, and one-shot", () => {
    let now = 100;
    const registry = new SystemTestBuildFaultRegistry({ now: () => now, ttlMs: 10 });
    const { run } = retainedRun("development-session", "worker:owner", "user:owner");
    const armed = registry.arm({
      sessionId: run.sessionId,
      runId: run.runId,
      ownerRuntimeId: run.ownerRuntimeId,
      ownerUserId: run.ownerUserId,
      phase: "after-snapshot-retained",
    });
    expect(
      registry.arm({
        sessionId: run.sessionId,
        runId: run.runId,
        ownerRuntimeId: run.ownerRuntimeId,
        ownerUserId: run.ownerUserId,
        phase: "after-snapshot-retained",
      })
    ).toEqual(armed);
    expect(() =>
      registry.arm({
        sessionId: "development-other",
        runId: run.runId,
        ownerRuntimeId: run.ownerRuntimeId,
        ownerUserId: run.ownerUserId,
        phase: "after-snapshot-retained",
      })
    ).toThrow(/binding drifted/);

    expect(
      registry.consumeAfterSnapshotRetained({
        ...run,
        ownerRuntimeId: "worker:other",
        state: "installing",
        commitPoint: "snapshot-retained",
      })
    ).toBeNull();
    const consumed = registry.consumeAfterSnapshotRetained({
      ...run,
      state: "installing",
      commitPoint: "snapshot-retained",
    });
    expect(consumed).toMatchObject({ runId: run.runId, phase: "after-snapshot-retained" });
    expect(
      registry.consumeAfterSnapshotRetained({
        ...run,
        state: "installing",
        commitPoint: "snapshot-retained",
      })
    ).toBeNull();

    registry.arm({
      sessionId: run.sessionId,
      runId: run.runId,
      ownerRuntimeId: run.ownerRuntimeId,
      ownerUserId: run.ownerUserId,
      phase: "after-snapshot-retained",
    });
    now += 10;
    expect(
      registry.consumeAfterSnapshotRetained({
        ...run,
        state: "installing",
        commitPoint: "snapshot-retained",
      })
    ).toBeNull();
  });

  it("exposes the build-failure fixture only to the host-attested seam and only for an owned run", async () => {
    const arm = vi.fn(() => {
      throw Object.assign(new Error("attested system-test harness required"), { code: "EACCES" });
    });
    const fixture = setup(undefined, undefined, { armSystemTestBuildFailure: arm });
    const opened = (await open(fixture.service, fixture.ctx)) as {
      kind: "opened";
      session: { sessionId: string };
    };
    const retained = retainedRun(
      opened.session.sessionId,
      fixture.ctx.caller.runtime.id,
      "user:owner"
    );
    retained.run.ownerUserId = null;
    fixture.store.putRun(retained.run, retained.plan, "intent");

    await expect(
      fixture.service.handler(fixture.ctx, "faultFailBuildAfterSnapshotRetained", [
        {
          sessionId: opened.session.sessionId,
          runId: retained.run.runId,
          phase: "after-snapshot-retained",
        },
      ])
    ).rejects.toMatchObject({ code: "EACCES" });
    expect(arm).toHaveBeenCalledTimes(1);
    await expect(
      fixture.service.handler(
        userContext("worker:other", "user:other"),
        "faultFailBuildAfterSnapshotRetained",
        [
          {
            sessionId: opened.session.sessionId,
            runId: retained.run.runId,
            phase: "after-snapshot-retained",
          },
        ]
      )
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(developmentMethods.faultFailBuildAfterSnapshotRetained.agentFacing).toBe(false);
  });

  it("fails once after retaining the snapshot, records the injected diagnostic, and retries the same snapshot", async () => {
    const registry = new SystemTestBuildFaultRegistry();
    const fixture = setup(undefined, undefined, {
      armSystemTestBuildFailure: (_caller, input, phase) => registry.arm({ ...input, phase }),
      consumeSystemTestBuildFailure: (run) => registry.consumeAfterSnapshotRetained(run),
    });
    const opened = (await open(fixture.service, fixture.ctx)) as {
      kind: "opened";
      session: { sessionId: string };
    };
    const retained = retainedRun(opened.session.sessionId, fixture.ctx.caller.runtime.id, "");
    fixture.executor.prepare.mockResolvedValue(retained.plan);
    fixture.executor.materialize.mockResolvedValue(undefined);
    fixture.executor.execute.mockResolvedValue(retainedArtifact());
    const startContext: ServiceContext = {
      ...fixture.ctx,
      preparedAuthority: {
        resolver: "development.start.native",
        digest: "f".repeat(64),
        payload: retained.plan,
      },
    };
    const armReceipt = (await fixture.service.handler(
      fixture.ctx,
      "faultFailBuildAfterSnapshotRetained",
      [
        {
          sessionId: opened.session.sessionId,
          runId: retained.run.runId,
          phase: "after-snapshot-retained",
        },
      ]
    )) as { faultId: string; runId: string; phase: string; armedAt: number };
    await expect(
      fixture.service.handler(fixture.ctx, "faultFailBuildAfterSnapshotRetained", [
        {
          sessionId: opened.session.sessionId,
          runId: retained.run.runId,
          phase: "after-snapshot-retained",
        },
      ])
    ).resolves.toEqual(armReceipt);
    const started = (await fixture.service.handler(startContext, "start", [
      {
        sessionId: opened.session.sessionId,
        runId: retained.run.runId,
        recipeId: retained.plan.recipe.recipeId,
        target: { kind: "build-only" },
      },
    ])) as DevelopmentRun;
    expect(started.snapshot.snapshotDigest).toBe(retained.plan.snapshot.snapshotDigest);
    const failed = await waitForRun(fixture.store, retained.run.runId, "failed");
    expect(failed).toMatchObject({
      commitPoint: "snapshot-retained",
      repair: {
        retryable: true,
        primaryError: { code: "ESYSTEMTEST_INJECTED_BUILD" },
      },
    });
    const diagnostics = fixture.store
      .listRunEvents(retained.run.runId)
      .events.filter((event) => event.kind === "diagnostic");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.payload).toMatchObject({
      code: "ESYSTEMTEST_INJECTED_BUILD",
      faultId: armReceipt.faultId,
      phase: "after-snapshot-retained",
    });
    expect(fixture.executor.execute).not.toHaveBeenCalled();

    fixture.executor.materialize.mockResolvedValue(undefined);
    const retried = (await fixture.service.handler(startContext, "retry", [
      { runId: retained.run.runId, idempotencyKey: "retry-injected-build" },
    ])) as DevelopmentRun;
    expect(retried.snapshot.snapshotDigest).toBe(retained.plan.snapshot.snapshotDigest);
    const succeeded = await waitForRun(fixture.store, retained.run.runId, "succeeded");
    expect(succeeded.snapshot.snapshotDigest).toBe(retained.plan.snapshot.snapshotDigest);
    expect(fixture.executor.execute).toHaveBeenCalledTimes(1);
  });

  it("reports reviewed native tool availability exactly as the live executor describes it", async () => {
    const native = {
      describeTool: vi.fn(async (toolId: "claude-code" | "system-editor") => ({
        toolId,
        executorId: "local:reviewed",
        available: toolId === "claude-code",
        ...(toolId === "system-editor"
          ? { unavailableReason: "No reviewed system editor adapter is installed" }
          : {}),
        interactiveTerminal: toolId === "claude-code",
      })),
    } as unknown as NativeDevelopmentController;
    const { service, ctx } = setup(undefined, native);

    await expect(service.handler(ctx, "listNativeTools", [])).resolves.toEqual([
      {
        toolId: "claude-code",
        executorId: "local:reviewed",
        available: true,
        unavailableReason: null,
        interactiveTerminal: true,
      },
      {
        toolId: "system-editor",
        executorId: "local:reviewed",
        available: false,
        unavailableReason: "No reviewed system editor adapter is installed",
        interactiveTerminal: false,
      },
    ]);
  });

  it("keeps source-only session and stop operations promptless, while retry re-enters native authority", () => {
    expect(developmentMethods.openSession.access).toEqual({ sensitivity: "write" });
    expect(developmentMethods.stop.access).toEqual({ sensitivity: "write" });
    expect(developmentMethods.destroySession.access).toEqual({ sensitivity: "destructive" });
    expect(developmentMethods.forceRetire.access).toEqual({ sensitivity: "destructive" });
    expect(developmentMethods.retry.authority).toMatchObject({
      prepared: { resolver: "development.start.native" },
    });
  });

  it("uses a standing native authority resource that is stable across source edits and changes at every reviewed boundary", () => {
    const base = {
      contextId: "ctx-child",
      repositoryId: "repository:app",
      baseState: { kind: "event" as const, eventId: "event:base" },
      executorId: "executor-a".repeat(8),
      recipeId: "recipe-a",
      lockfileDigest: "a".repeat(64),
      network: "approved-registry" as const,
      target: { kind: "build-only" as const },
      clientExecutor: null,
    };
    // Current source snapshot is deliberately absent: descendants keep the
    // same standing scope, so iteration does not generate approval fatigue.
    const stable = developmentNativeResourceKey(base);
    expect(developmentNativeResourceKey({ ...base })).toBe(stable);
    expect(developmentNativeResourceKey({ ...base, contextId: "ctx-other" })).not.toBe(stable);
    expect(developmentNativeResourceKey({ ...base, executorId: "executor-b".repeat(8) })).not.toBe(
      stable
    );
    expect(developmentNativeResourceKey({ ...base, recipeId: "recipe-b" })).not.toBe(stable);
    expect(developmentNativeResourceKey({ ...base, lockfileDigest: "b".repeat(64) })).not.toBe(
      stable
    );
    expect(
      developmentNativeResourceKey({
        ...base,
        target: { kind: "current-host-client", client: "electron" },
      })
    ).not.toBe(stable);
  });

  it("verifies parent and child exact state, records immutable basis, and is idempotent", async () => {
    const resolver = vi.fn(async () => ({
      status: "present" as const,
      repoPath: "packages/app",
      sourceState: { kind: "event" as const, eventId: "event:source" },
    }));
    const { service, ctx, runtime } = setup(resolver);
    const first = await open(service, ctx);
    const second = await open(service, ctx);

    expect(first).toMatchObject({
      kind: "opened",
      session: {
        state: "ready",
        contextId: "ctx-child",
        basis: {
          parentWorkingHead: { kind: "event", eventId: "event:parent" },
          childBaseState: { kind: "event", eventId: "event:child" },
        },
      },
    });
    expect(second).toEqual(first);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(runtime.forkDevelopmentSessionContext).toHaveBeenCalledTimes(1);
  });

  it("keeps durable sessions and runs visible across same-user reconnects only", async () => {
    const fixture = setup();
    const firstClient = userContext("worker:first", "user:alice");
    const secondClient = userContext("worker:second", "user:alice");
    const otherUser = userContext("worker:third", "user:bob");
    const opened = (await open(fixture.service, firstClient)) as {
      kind: "opened";
      session: { sessionId: string };
    };
    await expect(open(fixture.service, secondClient)).resolves.toEqual(opened);
    expect(fixture.runtime.forkDevelopmentSessionContext).toHaveBeenCalledTimes(1);
    await expect(
      fixture.service.handler(secondClient, "getSession", [{ sessionId: opened.session.sessionId }])
    ).resolves.toMatchObject({ sessionId: opened.session.sessionId });
    await expect(
      fixture.service.handler(secondClient, "listSessions", [undefined])
    ).resolves.toMatchObject({ sessions: [{ sessionId: opened.session.sessionId }] });
    await expect(
      fixture.service.handler(otherUser, "getSession", [{ sessionId: opened.session.sessionId }])
    ).resolves.toBeNull();

    const retained = retainedRun(
      opened.session.sessionId,
      firstClient.caller.runtime.id,
      "user:alice"
    );
    fixture.store.putRun(retained.run, retained.plan, "intent");
    await expect(
      fixture.service.handler(secondClient, "get", [{ runId: retained.run.runId }])
    ).resolves.toMatchObject({ runId: retained.run.runId });
    await expect(fixture.service.handler(secondClient, "list", [undefined])).resolves.toMatchObject(
      { runs: [{ runId: retained.run.runId }] }
    );
    await expect(
      fixture.service.handler(otherUser, "get", [{ runId: retained.run.runId }])
    ).resolves.toBeNull();
    await expect(fixture.service.handler(otherUser, "list", [undefined])).resolves.toEqual({
      runs: [],
      nextCursor: null,
    });
  });

  it("returns a typed adoption action from the parent without creating a child", async () => {
    const missing = setup(async () => ({ status: "not-adopted" }));
    await expect(open(missing.service, missing.ctx)).resolves.toMatchObject({
      kind: "repository-not-adopted",
      contextId: "ctx-parent",
      adoptionAction: "gitInterop.importProject",
    });
    expect(missing.runtime.forkDevelopmentSessionContext).not.toHaveBeenCalled();
  });

  it("retains or semantically destroys a context on idempotent close", async () => {
    const retained = setup();
    const opened = (await open(retained.service, retained.ctx)) as {
      kind: "opened";
      session: { sessionId: string };
    };
    await retained.service.handler(retained.ctx, "closeSession", [
      {
        sessionId: opened.session.sessionId,
        idempotencyKey: "close-1",
      },
    ]);
    expect(retained.runtime.discardDevelopmentSessionContext).not.toHaveBeenCalled();

    const destroyed = setup();
    const openedDestroyed = (await open(destroyed.service, destroyed.ctx)) as {
      kind: "opened";
      session: { sessionId: string };
    };
    const closed = await destroyed.service.handler(destroyed.ctx, "destroySession", [
      {
        sessionId: openedDestroyed.session.sessionId,
        idempotencyKey: "close-1",
      },
    ]);
    expect(closed).toMatchObject({ state: "closed" });
    expect(destroyed.runtime.discardDevelopmentSessionContext).toHaveBeenCalledWith("ctx-child");
  });

  it("keeps cleanup failures repairable without losing diagnostics", async () => {
    const { service, ctx, runtime } = setup();
    const opened = (await open(service, ctx)) as { kind: "opened"; session: { sessionId: string } };
    runtime.discardDevelopmentSessionContext
      .mockRejectedValueOnce(Object.assign(new Error("semantic context busy"), { code: "EBUSY" }))
      .mockResolvedValueOnce(undefined);
    const repair = await service.handler(ctx, "destroySession", [
      {
        sessionId: opened.session.sessionId,
        idempotencyKey: "close-1",
      },
    ]);
    expect(repair).toMatchObject({
      state: "requires-repair",
      primaryDiagnostic: { code: "EBUSY", message: "semantic context busy" },
      cleanupDiagnostics: [{ code: "EBUSY" }],
    });
    await expect(
      service.handler(ctx, "retrySessionCleanup", [
        {
          sessionId: opened.session.sessionId,
          idempotencyKey: "repair-1",
        },
      ])
    ).resolves.toMatchObject({ state: "closed" });
  });

  it("rejects malformed persisted session structure rather than adopting it", () => {
    const statePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-development-invalid-"));
    const filePath = path.join(statePath, "development", "sessions.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        sessions: [{ sessionId: "development-bad", idempotencyKey: "key", state: "ready" }],
      })
    );
    expect(() => new DevelopmentSessionStore({ statePath })).toThrow(/Invalid development session/);
  });

  it("prepares an exact native build without materializing, spawning, or exposing a plan to the handler", async () => {
    const fixture = setup();
    const opened = (await open(fixture.service, fixture.ctx)) as {
      kind: "opened";
      session: { sessionId: string };
    };
    const prepared = retainedRun(
      opened.session.sessionId,
      fixture.ctx.caller.runtime.id,
      fixture.ctx.caller.subject?.userId ?? ""
    ).plan;
    fixture.executor.prepare.mockResolvedValue(prepared);
    const prepare = fixture.service.authorityPreparation?.["development.start.native"];
    await expect(
      prepare?.(fixture.ctx, [
        {
          sessionId: opened.session.sessionId,
          runId: prepared.runId,
          recipeId: prepared.recipe.recipeId,
          target: { kind: "build-only" },
        },
      ])
    ).resolves.toMatchObject({ payload: prepared, selections: [expect.anything()] });
    expect(fixture.executor.materialize).not.toHaveBeenCalled();
    expect(fixture.executor.execute).not.toHaveBeenCalled();
    expect(fixture.store.getRun(prepared.runId)).toBeNull();
  });

  it("rejects a prepared source outside the session lineage before authority can approve it", async () => {
    const fixture = setup();
    const opened = (await open(fixture.service, fixture.ctx)) as {
      kind: "opened";
      session: { sessionId: string };
    };
    const prepared = retainedRun(
      opened.session.sessionId,
      fixture.ctx.caller.runtime.id,
      fixture.ctx.caller.subject?.userId ?? ""
    ).plan;
    fixture.executor.prepare.mockResolvedValue(prepared);
    fixture.service = createDevelopmentService({
      store: fixture.store,
      runtime: fixture.runtime as unknown as RuntimeServiceInternal,
      repositories: {
        resolveExact: async () => ({
          status: "present",
          repoPath: "packages/app",
          sourceState: { kind: "event", eventId: "event:source" },
        }),
      },
      executor: fixture.executor,
      isStateDescendant: vi.fn(async () => false),
      now: () => 100,
    });
    const prepare = fixture.service.authorityPreparation?.["development.start.native"];
    await expect(
      prepare?.(fixture.ctx, [
        {
          sessionId: opened.session.sessionId,
          runId: prepared.runId,
          recipeId: prepared.recipe.recipeId,
          target: { kind: "build-only" },
        },
      ])
    ).rejects.toMatchObject({ code: "ELINEAGE" });
    expect(fixture.executor.materialize).not.toHaveBeenCalled();
    expect(fixture.executor.execute).not.toHaveBeenCalled();
  });

  it("does not let a failed run retry without the dispatcher-sealed exact native plan", async () => {
    const fixture = setup();
    const opened = (await open(fixture.service, fixture.ctx)) as {
      kind: "opened";
      session: { sessionId: string };
    };
    const retained = retainedRun(
      opened.session.sessionId,
      fixture.ctx.caller.runtime.id,
      "user:unused"
    );
    fixture.store.putRun(
      {
        ...retained.run,
        ownerUserId: null,
        state: "failed",
        terminalAt: 100,
        repair: {
          phase: "building",
          primaryError: { code: "EBUILD", message: "build failed", at: 100 },
          cleanupErrors: [],
          retryable: true,
          attention: "actionable",
          knownEffects: { executionRoot: "owned", process: "absent", artifact: "absent" },
        },
      },
      retained.plan,
      "intent"
    );
    await expect(
      fixture.service.handler(fixture.ctx, "retry", [
        { runId: retained.run.runId, idempotencyKey: "retry-1" },
      ])
    ).rejects.toThrow("Prepared authority payload 'development.start.native' is unavailable");
    expect(fixture.store.getRun(retained.run.runId)?.state).toBe("failed");
    expect(fixture.executor.materialize).not.toHaveBeenCalled();
  });

  it("persists a fixed-code initiator's manifest as the attached route ceiling", async () => {
    const fixture = setup();
    const requested = [
      {
        capability: "workspace.file.write",
        resource: { kind: "prefix" as const, prefix: "context:development/" },
      },
    ];
    const caller = createVerifiedCaller("worker:agent", "worker", {
      callerId: "worker:agent",
      callerKind: "worker",
      repoPath: "workers/agent",
      effectiveVersion: "v1",
      requested,
    });
    const opened = (await open(fixture.service, { caller })) as {
      kind: "opened";
      session: { sessionId: string };
    };
    const retained = retainedRun(opened.session.sessionId, caller.runtime.id, "");
    const run = (await fixture.service.handler(
      {
        caller,
        preparedAuthority: {
          resolver: "development.start.native",
          digest: "f".repeat(64),
          payload: retained.plan,
        },
      },
      "start",
      [
        {
          sessionId: opened.session.sessionId,
          runId: retained.run.runId,
          recipeId: retained.plan.recipe.recipeId,
          target: { kind: "isolated-host", includeClient: false },
        },
      ]
    )) as DevelopmentRun;
    expect(run.attachedHostAuthorityCeiling).toEqual(requested);
  });

  it("preserves the primary failure and exact retained ids when force-retire cleanup fails", async () => {
    const fixture = setup();
    const retained = retainedRun(
      "development-session",
      fixture.ctx.caller.runtime.id,
      "user:unused"
    );
    const primary = { code: "EBUILD", message: "original build failure", at: 90 };
    fixture.store.putRun(
      {
        ...retained.run,
        ownerUserId: null,
        state: "requires-repair",
        artifact: retainedArtifact(),
        repair: {
          phase: "building",
          primaryError: primary,
          cleanupErrors: [],
          retryable: false,
          attention: "actionable",
          knownEffects: {
            executionRoot: "owned",
            process: "absent",
            artifact: "retained",
          },
        },
      },
      retained.plan,
      "intent"
    );
    fixture.executor.retire.mockRejectedValue(
      Object.assign(new Error("owned root is busy"), { code: "EBUSY" })
    );
    await expect(
      fixture.service.handler(fixture.ctx, "forceRetire", [
        { runId: retained.run.runId, idempotencyKey: "retire-1" },
      ])
    ).resolves.toMatchObject({
      runId: retained.run.runId,
      state: "requires-repair",
      artifact: {
        buildKey: "b".repeat(64),
        artifactDigest: "d".repeat(64),
      },
      repair: {
        primaryError: primary,
        cleanupErrors: [{ code: "EBUSY", message: "owned root is busy" }],
        knownEffects: {
          executionRoot: "owned",
          process: "absent",
          artifact: "retained",
        },
      },
    });
  });
});
