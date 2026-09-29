import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevInstanceSupervisor } from "../../dev/devInstanceSupervisor.js";
import type { DevelopmentRun, DevelopmentSession } from "@vibestudio/service-schemas/development";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { createDevelopmentNativeService } from "./developmentNativeService.js";
import type { PreparedDevelopmentBuild } from "./developmentExecutor.js";
import { developmentRecipeFixture } from "./developmentRecipeFixture.test-helper.js";

const digest = "a".repeat(64);
const caller = (id: string) => ({ caller: { runtime: { id, kind: "do" } } }) as ServiceContext;

function fixture(target: DevelopmentRun["target"] = { kind: "build-only" }) {
  const recipe = developmentRecipeFixture(process.platform, process.arch, target);
  const repository = (repositoryId: string, repoPath: string) => ({
    repositoryId,
    repoPath,
    repositoryState: { kind: "event" as const, eventId: "event:source" },
    repositoryManifestDigest: digest,
    materializedTreeDigest: digest,
    contentRoot: `state:${digest}`,
    sourcePlanDigest: digest,
  });
  const session: DevelopmentSession = {
    sessionId: "session:one",
    idempotencyKey: "open",
    state: "ready",
    mode: "semantic",
    nativeTool: null,
    native: null,
    repository: { repositoryId: "host", repoPath: "projects/host" },
    contextId: "context:one",
    parentContextId: "context:parent",
    basis: {
      parentWorkingHead: { kind: "event", eventId: "event:parent" },
      childBaseState: { kind: "event", eventId: "event:source" },
    },
    owner: { runtimeId: "do:development", runtimeKind: "do", userId: "user:one" },
    contextEffect: "owned",
    repairAttention: null,
    createdAt: 1,
    updatedAt: 1,
    primaryDiagnostic: null,
    cleanupDiagnostics: [],
  };
  const pair = {
    kind: "combined" as const,
    hostRepositoryId: "host",
    baseRepositoryId: "base",
    personalRepositoryId: "personal",
    systemRepositoryId: "system",
  };
  const snapshot: DevelopmentRun["snapshot"] = {
    version: 1,
    sessionId: session.sessionId,
    contextId: session.contextId,
    pair: {
      kind: "combined",
      host: repository("host", "projects/host"),
      base: repository("base", "templates/base"),
      personal: repository("personal", "templates/personal"),
      system: repository("system", "templates/system"),
      pairDigest: digest,
    },
    recipeDigest: digest,
    toolchain: {
      executorId: digest,
      node: { digest, version: "test", platform: process.platform, arch: process.arch },
      pnpm: { digest, version: "test" },
      hostSourceBuild: { digest },
    },
    declaredEnvironment: recipe.declaredEnvironment,
    environmentDigest: digest,
    lockfileDigest: digest,
    snapshotDigest: digest,
  };
  const run: DevelopmentRun = {
    version: 1,
    runId: "run:one",
    sessionId: session.sessionId,
    ownerRuntimeId: session.owner.runtimeId,
    ownerRuntimeKind: "do",
    ownerUserId: "user:one",
    attachedHostAuthorityCeiling: null,
    target,
    recipe,
    snapshot,
    state: "stopped",
    commitPoint: "snapshot-retained",
    artifact: null,
    instance: null,
    hostReadiness: null,
    client: null,
    attachedHost: null,
    repair: null,
    createdAt: 1,
    updatedAt: 1,
    terminalAt: 2,
  };
  const plan = { version: 1, runId: run.runId, recipe, snapshot } as PreparedDevelopmentBuild;
  const prepareExact = vi.fn().mockResolvedValue(plan);
  const retire = vi.fn().mockResolvedValue(undefined);
  const materialize = vi.fn().mockResolvedValue(undefined);
  const execute = vi.fn().mockResolvedValue({ executionDigest: digest });
  const stop = vi.fn().mockResolvedValue(undefined);
  const isolated = {
    start: vi.fn(),
    stop: vi.fn(),
    mintClientInvite: vi.fn(),
    waitForClientAttestation: vi.fn(),
    takeAttachmentPorts: vi.fn(),
    retireManagementChannel: vi.fn(),
  };
  const attached = {
    attach: vi.fn().mockResolvedValue({
      attachedHostSessionId: "attached:one",
      childGenerationId: "a".repeat(32),
      authorityCeilingDigest: digest,
      expiresAt: 99,
    }),
    close: vi.fn().mockResolvedValue(undefined),
    recover: vi.fn().mockResolvedValue("recovered"),
  };
  const nativeClose = vi.fn().mockResolvedValue(undefined);
  const controller = createDevelopmentNativeService({
    native: { close: nativeClose } as unknown as Parameters<
      typeof createDevelopmentNativeService
    >[0]["native"],
    executor: {
      prepareExact,
      retire,
      materialize,
      execute,
      stop,
      resolveClientArtifactSource: vi.fn(),
    },
    isolatedExecutor: isolated,
    attachedHostPublisher: attached,
    attachedHostParentId: "host:parent",
  });
  const service = controller.definition;
  const prepare = (ctx: ServiceContext) =>
    service.handler(ctx, "prepareBuild", [
      { session, runId: run.runId, recipe, pair, target: run.target },
    ]);
  return {
    close: controller.close,
    nativeClose,
    service,
    prepare,
    prepareExact,
    retire,
    run,
    materialize,
    execute,
    stop,
    isolated,
    attached,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

const registeredInstance: NonNullable<DevelopmentRun["instance"]> = {
  instanceId: "child-one",
  generationId: "a".repeat(32),
  lifecycle: "ephemeral",
  state: "registered",
  executionDigest: digest,
  serverBuildId: digest,
  serverId: null,
  serverBootId: null,
  workspaceId: null,
  workspaceName: null,
  gatewayUrl: null,
  registeredAt: 1,
  readyAt: null,
  stoppedAt: null,
};

describe("native development build ownership", () => {
  it.runIf(process.platform !== "win32")(
    "drains a real isolated process tree before close resolves",
    async () => {
      const f = fixture({ kind: "isolated-host", includeClient: false });
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "vibestudio-native-owner-"));
      const readyFile = path.join(root, "ready.json");
      let grandchildPid = 0;
      const supervisor = new DevInstanceSupervisor({
        sourceRoot: root,
        command: process.execPath,
        args: [
          "-e",
          `
        const {spawn}=require('node:child_process');
        const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
        require('node:fs').writeFileSync(process.argv[1],JSON.stringify({pid:child.pid}));
        setInterval(()=>{},1000);
      `,
          readyFile,
        ],
        env: process.env,
        stdio: "ignore",
        readiness: {
          file: readyFile,
          async onReady(value) {
            grandchildPid = (value as { pid: number }).pid;
          },
        },
      });
      f.isolated.start.mockImplementation(async (_run, _plan, lifecycle) => {
        lifecycle.onRegistered(registeredInstance);
        await supervisor.start();
        const ready = { ...registeredInstance, state: "ready" as const, readyAt: 2 };
        await lifecycle.onReady(ready);
        return ready;
      });
      f.isolated.stop.mockImplementation(async (run: DevelopmentRun) => {
        await supervisor.stop();
        return { ...run.instance!, state: "stopped", stoppedAt: 3 };
      });
      try {
        await f.prepare(caller("do:development"));
        await f.service.handler(caller("do:development"), "beginBuild", [{ run: f.run }]);
        await vi.waitFor(() => expect(f.attached.attach).toHaveBeenCalledTimes(1));
        expect(grandchildPid).toBeGreaterThan(0);
        process.kill(grandchildPid, 0);
        const childPid = supervisor.process!.pid!;
        await f.close();
        await vi.waitFor(() => {
          for (const pid of [childPid, grandchildPid]) {
            expect(() => process.kill(pid, 0)).toThrow();
          }
        });
        expect(f.attached.close).toHaveBeenCalledTimes(1);
        expect(f.retire).not.toHaveBeenCalled();
      } finally {
        await supervisor.stop();
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  );

  it("joins shutdown callers and cancels materialization before any child can launch", async () => {
    const f = fixture({ kind: "isolated-host", includeClient: false });
    const gate = deferred();
    f.materialize.mockReturnValue(gate.promise);
    await f.prepare(caller("do:development"));
    await f.service.handler(caller("do:development"), "beginBuild", [{ run: f.run }]);
    const closing = f.close();
    expect(f.close()).toBe(closing);
    await expect(f.prepare(caller("do:development"))).rejects.toMatchObject({ code: "ECLOSED" });
    let finished = false;
    void closing.then(() => {
      finished = true;
    });
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalled());
    expect(finished).toBe(false);
    gate.resolve();
    await closing;
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.isolated.start).not.toHaveBeenCalled();
    expect(f.nativeClose).toHaveBeenCalledTimes(1);
    expect(f.retire).not.toHaveBeenCalled();
  });

  it("joins preparation already admitted before closing native tool ownership", async () => {
    const f = fixture();
    const gate = deferred();
    const plan = await f.prepareExact();
    f.prepareExact.mockImplementation(async () => {
      await gate.promise;
      return plan;
    });
    const preparing = f.prepare(caller("do:development"));
    const closing = f.close();
    expect(f.nativeClose).not.toHaveBeenCalled();
    gate.resolve();
    await preparing;
    await closing;
    expect(f.nativeClose).toHaveBeenCalledTimes(1);
    await expect(
      f.service.handler(caller("do:development"), "beginBuild", [{ run: f.run }])
    ).rejects.toMatchObject({ code: "ECLOSED" });
  });

  it("waits for a registered child to acknowledge shutdown", async () => {
    const f = fixture({ kind: "isolated-host", includeClient: false });
    const registered = deferred();
    const startup = deferred();
    const stopped = deferred();
    f.isolated.start.mockImplementation(async (_run, _plan, lifecycle) => {
      lifecycle.onRegistered(registeredInstance);
      registered.resolve();
      await startup.promise;
      return registeredInstance;
    });
    f.isolated.stop.mockImplementation(async (run: DevelopmentRun) => {
      await stopped.promise;
      startup.resolve();
      return { ...run.instance!, state: "stopped", stoppedAt: 3 };
    });
    await f.prepare(caller("do:development"));
    await f.service.handler(caller("do:development"), "beginBuild", [{ run: f.run }]);
    await registered.promise;
    const closing = f.close();
    let finished = false;
    void closing.then(() => {
      finished = true;
    });
    await vi.waitFor(() => expect(f.isolated.stop).toHaveBeenCalledTimes(1));
    expect(finished).toBe(false);
    stopped.resolve();
    await closing;
    expect(f.isolated.stop).toHaveBeenCalledTimes(1);
  });

  it("lets the preparing runtime release its exact root without a new approval", async () => {
    const f = fixture();
    await f.prepare(caller("do:development"));
    expect(f.service.methods?.["retireBuild"]?.tier).toMatchObject({ tier: "open" });
    expect(f.service.methods?.["retireBuild"]?.capability).toBeUndefined();
    await f.service.handler(caller("do:development"), "retireBuild", [{ run: f.run }]);
    expect(f.retire).toHaveBeenCalledExactlyOnceWith(f.run);
  });

  it("rejects another runtime even when it knows the complete run record", async () => {
    const f = fixture();
    await f.prepare(caller("do:development"));
    await expect(
      f.service.handler(caller("do:other"), "retireBuild", [{ run: f.run }])
    ).rejects.toMatchObject({ code: "EOWNERSHIP" });
    await expect(f.prepare(caller("do:other"))).rejects.toMatchObject({ code: "EOWNERSHIP" });
    expect(f.prepareExact).toHaveBeenCalledTimes(1);
    expect(f.retire).not.toHaveBeenCalled();
  });

  it("refuses a changed snapshot before touching the filesystem", async () => {
    const f = fixture();
    await f.prepare(caller("do:development"));
    const run = { ...f.run, snapshot: { ...f.run.snapshot, snapshotDigest: "b".repeat(64) } };
    await expect(
      f.service.handler(caller("do:development"), "retireBuild", [{ run }])
    ).rejects.toMatchObject({ code: "EEXECUTION_HANDLE" });
    expect(f.retire).not.toHaveBeenCalled();
  });

  it("waits for materialization to settle and prevents a late build after retirement", async () => {
    const f = fixture();
    const gate = deferred();
    f.materialize.mockReturnValue(gate.promise);
    await f.prepare(caller("do:development"));
    await f.service.handler(caller("do:development"), "beginBuild", [{ run: f.run }]);
    const retiring = f.service.handler(caller("do:development"), "retireBuild", [{ run: f.run }]);
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalled());
    expect(f.retire).not.toHaveBeenCalled();
    gate.resolve();
    await retiring;
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.retire).toHaveBeenCalledExactlyOnceWith(f.run);
  });

  it("stops the registered child before removing its root even when the caller has an earlier run record", async () => {
    const f = fixture({ kind: "isolated-host", includeClient: false });
    f.isolated.start.mockImplementation(async (_run, _plan, lifecycle) => {
      lifecycle.onRegistered(registeredInstance);
      const ready = { ...registeredInstance, state: "ready" as const, readyAt: 2 };
      await lifecycle.onReady(ready);
      return ready;
    });
    f.isolated.stop.mockImplementation(async (run: DevelopmentRun) => {
      expect(run.instance).toMatchObject({ instanceId: "child-one", state: "ready" });
      expect(f.retire).not.toHaveBeenCalled();
      return { ...run.instance!, state: "stopped", stoppedAt: 3 };
    });
    await f.prepare(caller("do:development"));
    await f.service.handler(caller("do:development"), "beginBuild", [{ run: f.run }]);
    await vi.waitFor(async () => {
      expect(
        await f.service.handler(caller("do:development"), "inspectBuild", [
          { runId: f.run.runId, snapshotDigest: digest },
        ])
      ).toMatchObject({ state: "ready" });
    });
    const stopped = await f.service.handler(caller("do:development"), "stopBuild", [
      { runId: f.run.runId, snapshotDigest: digest },
    ]);
    expect(stopped).toMatchObject({
      instance: { state: "stopped", stoppedAt: 3 },
      attachedHost: { state: "closed" },
      hostReadiness: "stopped",
    });
    expect(f.attached.close).toHaveBeenCalledExactlyOnceWith(
      "attached:one",
      "development-run-stopped"
    );
    expect(
      await f.service.handler(caller("do:development"), "inspectBuild", [
        { runId: f.run.runId, snapshotDigest: digest },
      ])
    ).toMatchObject({ state: "stopped", instance: { state: "stopped" } });
    await f.service.handler(caller("do:development"), "retireBuild", [{ run: f.run }]);
    expect(f.isolated.stop).toHaveBeenCalledTimes(1);
    expect(f.retire).toHaveBeenCalledExactlyOnceWith(f.run);
  });

  it("does not create a child that finishes preparing after retirement started", async () => {
    const f = fixture({ kind: "isolated-host", includeClient: false });
    const gate = deferred();
    const createChild = vi.fn();
    f.isolated.start.mockImplementation(async (_run, _plan, lifecycle) => {
      await gate.promise;
      lifecycle.onRegistered(registeredInstance);
      createChild();
      return registeredInstance;
    });
    await f.prepare(caller("do:development"));
    await f.service.handler(caller("do:development"), "beginBuild", [{ run: f.run }]);
    await vi.waitFor(() => expect(f.isolated.start).toHaveBeenCalled());
    const retiring = f.service.handler(caller("do:development"), "retireBuild", [{ run: f.run }]);
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalled());
    expect(f.retire).not.toHaveBeenCalled();
    gate.resolve();
    await retiring;
    expect(createChild).not.toHaveBeenCalled();
    expect(f.isolated.stop).not.toHaveBeenCalled();
    expect(f.retire).toHaveBeenCalledExactlyOnceWith(f.run);
  });
});
