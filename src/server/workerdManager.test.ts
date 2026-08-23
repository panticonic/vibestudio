/**
 * Tests for WorkerdManager — instance lifecycle, config generation,
 * name sanitization, and rebuild handling.
 */

import {
  WorkerdManager as ProductWorkerdManager,
  type WorkerdManagerDeps,
  type WorkerdWorkspaceProvider,
} from "./workerdManager.js";
import { spawn } from "child_process";
import { findServicePort } from "./hostCore/portUtils.js";
import { SingletonRegistry } from "@vibestudio/workspace/singletonRegistry";
import type { BuildResult } from "./buildV2/buildStore.js";
import { RouteRegistry } from "./routeRegistry.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildWorkerdPrograms,
  type WorkerdProgramSources,
} from "../../scripts/build-workerd-programs.mjs";
import { DIRECT_AUTHORITY_ACCEPTED_AT_HEADER } from "@vibestudio/rpc/internal";
import {
  executionArtifactDigest,
  executionSourceClosureDigest,
  verifyExecutionArtifactRef,
  type ExecutionArtifactRefV1,
} from "@vibestudio/shared/execution/retention";
import { sha256 } from "@vibestudio/shared/execution/identity";
import { ledgerTest } from "../../tests/helpers/ledgerTest.js";

// Mock child_process to prevent actual workerd spawning
vi.mock("child_process", () => ({
  spawn: vi.fn(() => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const proc = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(fn);
        return proc;
      }),
      once: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(fn);
        return proc;
      }),
      removeListener: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        listeners.get(event)?.delete(fn);
        return proc;
      }),
      emit: (event: string, ...args: unknown[]) => {
        for (const fn of listeners.get(event) ?? []) fn(...args);
      },
      kill: vi.fn(() => {
        // Simulate process exit after kill
        setTimeout(() => {
          for (const fn of listeners.get("exit") ?? [])
            (fn as (code: number | null, signal: string | null) => void)(null, "SIGTERM");
        }, 0);
      }),
      pid: 12345,
      exitCode: null,
      signalCode: null,
    };
    return proc;
  }),
}));

// Mock port-utils
vi.mock("./hostCore/portUtils.js", () => ({
  findServicePort: vi.fn(async (service: string) =>
    service === "workerdInspector" ? 49652 : 49552
  ),
  releaseServicePort: vi.fn(),
}));

function runtimeArtifact(source: string, ref = "main"): ExecutionArtifactRefV1 {
  const stateHash = `state:${sha256(`state:${source}:${ref}`)}`;
  const contentRoots = [{ repoPath: source, stateHash }];
  const unsigned = {
    version: 1 as const,
    sourceState: {
      kind: "workspace" as const,
      workspaceId: "workspace:test",
      effectiveVersion: sha256(`ev:${source}:${ref}`),
      state: { kind: "event" as const, eventId: `event:${source}:${ref}` },
      contentRoots,
      sourceClosureDigest: executionSourceClosureDigest(contentRoots),
    },
    recipeDigest: sha256(`recipe:${source}`),
    buildKey: sha256(`build:${source}:${ref}`),
    artifactDigest: sha256(`artifact:${source}:${ref}`),
  };
  return verifyExecutionArtifactRef({
    ...unsigned,
    executionDigest: executionArtifactDigest(unsigned),
  });
}

function mockWorkerBuild(
  bundle = 'export default { fetch() { return new Response("ok"); } };'
): BuildResult {
  const execution = runtimeArtifact("workers/runtime-fixture", "build");
  const buildKey = execution.buildKey;
  return {
    dir: "/tmp/test-build",
    buildKey,
    sourceStateHash: execution.sourceState.contentRoots[0]!.stateHash,
    metadata: {
      kind: "worker",
      name: "workers/runtime-fixture",
      buildKey,
      sourcePath: "workers/runtime-fixture",
      ev: execution.sourceState.effectiveVersion,
      sourceStateHash: execution.sourceState.contentRoots[0]!.stateHash,
      sourceState: execution.sourceState.state,
      execution,
      sourcemap: false,
      authority: { requests: [], provides: [], serviceRequests: [] },
      details: { kind: "generic" },
      builtAt: "2026-01-01T00:00:00.000Z",
    },
    artifacts: [
      {
        path: "worker.js",
        role: "primary",
        contentType: "text/javascript; charset=utf-8",
        encoding: "utf8",
        content: bundle,
      },
    ],
  };
}

function mockWorkerBuildFor(source: string, execution: ExecutionArtifactRefV1): BuildResult {
  const base = mockWorkerBuild();
  return {
    ...base,
    buildKey: execution.buildKey,
    sourceStateHash: execution.sourceState.contentRoots[0]!.stateHash,
    metadata: {
      ...base.metadata,
      name: source,
      buildKey: execution.buildKey,
      sourcePath: source,
      ev: execution.sourceState.effectiveVersion,
      sourceStateHash: execution.sourceState.contentRoots[0]!.stateHash,
      sourceState: execution.sourceState.state,
      execution,
    },
  };
}

type TestWorkerdDeps = WorkerdManagerDeps & WorkerdWorkspaceProvider;
const testStatePaths = new Set<string>();

class WorkerdManager extends ProductWorkerdManager {
  constructor(deps: TestWorkerdDeps) {
    super(deps);
    this.bindWorkspaceProvider(deps);
  }
}

function createMockDeps(overrides: Partial<TestWorkerdDeps> = {}): TestWorkerdDeps {
  const build = mockWorkerBuild();
  const statePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-workerd-manager-test-"));
  testStatePaths.add(statePath);
  return {
    tokenManager: {
      ensureToken: vi.fn().mockReturnValue("mock-token-123"),
      revokeToken: vi.fn(),
    } as unknown as WorkerdManagerDeps["tokenManager"],
    fsService: {
      closeHandlesForCaller: vi.fn(),
    } as unknown as WorkerdManagerDeps["fsService"],
    getServerUrl: () => "http://127.0.0.1:9999",
    bindRuntimeImage: vi.fn(async (unitPath: string, ref?: string) => ({
      source: unitPath,
      unitName: unitPath,
      artifact: runtimeArtifact(unitPath, ref ?? "main"),
      authority: { provides: [], requests: [], serviceRequests: [] },
    })),
    getBuildByKey: vi.fn(() => build),
    getBuildByExecution: vi.fn((_key, executionDigest) =>
      build.metadata.execution?.executionDigest === executionDigest ? build : null
    ),
    getManifestRoutes: () => [],
    getManifestDoClasses: () => [],
    singletonRegistry: new SingletonRegistry([]),
    getInternalDoEnv: () => ({}),
    workspaceId: "workspace:test",
    workerdPrograms: {
      router: "export default { fetch() { return new Response(null, { status: 204 }); } };",
      workerHost: "export default { fetch() { return new Response(null, { status: 204 }); } };",
      universalDo:
        "export class UniversalDO {}; export default { fetch() { return new Response(); } };",
    },
    workspacePath: "/tmp/test-workspace",
    statePath,
    getProxyPort: () => 49444,
    getSharedEgressPort: () => Promise.resolve(49555),
    registerEgressCaller: () => {},
    unregisterEgressCaller: () => {},
    egressSecret: "mock-egress-secret",
    getWorkerdGatewayToken: () => "mock-workerd-gateway-token",
    workerdStartupReadyTimeoutMs: 50,
    ...overrides,
  };
}

let compiledWorkerdPrograms: WorkerdProgramSources;

beforeAll(async () => {
  compiledWorkerdPrograms = await buildWorkerdPrograms({ write: false });
});

async function loadCompiledRouter(): Promise<{
  fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
}> {
  const dataUrl = `data:text/javascript;base64,${Buffer.from(compiledWorkerdPrograms.router).toString("base64")}`;
  const module = (await import(/* @vite-ignore */ dataUrl)) as {
    default: { fetch(request: Request, env: Record<string, unknown>): Promise<Response> };
  };
  return module.default;
}

type StartWorkerArgs = Parameters<WorkerdManager["startWorker"]>[0];

/** Default args for the runtime-managed worker-launch path (startWorker). */
function startArgs(overrides: Partial<StartWorkerArgs> = {}): StartWorkerArgs {
  return {
    source: "workers/runtime-fixture",
    key: "hello",
    contextId: "ctx-1",
    ...overrides,
  };
}

/** Status of a live worker instance by sanitized name (replaces getInstanceStatus). */
function statusOf(mgr: WorkerdManager, name: string) {
  return mgr.listInstances().find((instance) => instance.name === name) ?? null;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 204 }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(findServicePort).mockImplementation(
    async (service: Parameters<typeof findServicePort>[0]) =>
      service === "workerdInspector" ? 49652 : 49552
  );
  for (const statePath of testStatePaths) {
    fs.rmSync(statePath, { recursive: true, force: true });
  }
  testStatePaths.clear();
});

describe("WorkerdManager", () => {
  describe("current publication schema evidence", () => {
    const descriptor = (version: number, fingerprint: string) => ({
      className: "BoardDO",
      version,
      freshSchemaFingerprint: fingerprint,
    });

    it("stages each publication's exact current descriptor without comparing old generations", () => {
      const mgr = new WorkerdManager(createMockDeps());
      expect(
        mgr.validateAndStageDurableObjectSchemas("state:first", [
          {
            source: "workers/board",
            effectiveVersion: "ev-1",
            descriptor: descriptor(1, "shape-v1"),
          },
        ])
      ).toEqual([]);
      mgr.commitDurableObjectSchemas("state:first");

      expect(
        mgr.validateAndStageDurableObjectSchemas("state:second", [
          {
            source: "workers/board",
            effectiveVersion: "ev-2",
            descriptor: descriptor(2, "shape-v2"),
          },
        ])
      ).toEqual([]);
      mgr.commitDurableObjectSchemas("state:second");

      expect(
        mgr.validateAndStageDurableObjectSchemas("state:replacement", [
          {
            source: "workers/board",
            effectiveVersion: "ev-3",
            descriptor: descriptor(1, "new-current-shape"),
          },
        ])
      ).toEqual([]);
    });
  });

  it("resumes a failed maintenance journal and hides its backup until completion", async () => {
    const mgr = new WorkerdManager(createMockDeps());
    const ref = { source: "workers/board", className: "BoardDO", objectKey: "main" };
    const internals = mgr as unknown as {
      verifyDurableObjectBackup(operationId: string): Promise<void>;
      readOpenDurableObjectMaintenance(): Array<{ operationId: string }>;
    };
    const verify = internals.verifyDurableObjectBackup.bind(mgr);
    let failVerification = true;
    internals.verifyDurableObjectBackup = async (operationId) => {
      if (failVerification) throw new Error("injected verification failure");
      await verify(operationId);
    };

    await expect(mgr.resetDOStorage(ref, "test resumable reset")).rejects.toThrow(
      "injected verification failure"
    );
    const operationId = internals.readOpenDurableObjectMaintenance()[0]!.operationId;
    await expect(mgr.listDOStorageBackups(ref)).resolves.toEqual([]);

    failVerification = false;
    await expect(mgr.resetDOStorage(ref, "retry resumable reset")).resolves.toEqual({
      operationId,
    });
    await expect(mgr.listDOStorageBackups(ref)).resolves.toEqual([
      expect.objectContaining({ operationId }),
    ]);
    await mgr.shutdown();
  });

  it("resumes after replacement failure and retains only the five newest backups", async () => {
    const mgr = new WorkerdManager(createMockDeps());
    const ref = { source: "workers/board", className: "BoardDO", objectKey: "retained" };
    const internals = mgr as unknown as {
      destroyDurableObjectStorageFiles(target: typeof ref): Promise<void>;
    };
    const originalDestroy = internals.destroyDurableObjectStorageFiles.bind(mgr);
    let failDestroy = true;
    internals.destroyDurableObjectStorageFiles = async (target) => {
      if (failDestroy) throw new Error("injected replacement failure");
      await originalDestroy(target);
    };
    await expect(mgr.resetDOStorage(ref, "first attempt")).rejects.toThrow(
      "injected replacement failure"
    );
    failDestroy = false;
    const resumed = await mgr.resetDOStorage(ref, "resume replacement");
    for (let index = 0; index < 5; index += 1) {
      await mgr.resetDOStorage(ref, `retention ${index}`);
    }
    const backups = await mgr.listDOStorageBackups(ref);
    expect(backups).toHaveLength(5);
    expect(backups.some((backup) => backup.operationId === resumed.operationId)).toBe(false);
    await mgr.shutdown();
  });

  it("tombstones retired internal storage without restarting live peers and collects it at shutdown", async () => {
    const mgr = new WorkerdManager(createMockDeps());
    const ref = {
      source: "vibestudio/internal",
      className: "EvalDO",
      objectKey: "retired-eval",
    };
    const internals = mgr as unknown as {
      quiesceDurableObjectStorage(target: typeof ref): Promise<void>;
      destroyDurableObjectStorageFiles(target: typeof ref): Promise<void>;
      readOpenDurableObjectMaintenance(): Array<{
        kind: string;
        source: string;
        className: string;
        objectKey: string;
      }>;
    };
    const quiesce = vi.fn(async () => undefined);
    const destroy = vi.fn(async () => undefined);
    internals.quiesceDurableObjectStorage = quiesce;
    internals.destroyDurableObjectStorageFiles = destroy;

    await mgr.destroyRetiredDOStorage(ref);

    expect(quiesce).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(internals.readOpenDurableObjectMaintenance()).toContainEqual(
      expect.objectContaining({ kind: "destroy", ...ref })
    );

    await mgr.shutdown();

    expect(quiesce).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("binds the required process-owned egress secret", () => {
    const mgr = new WorkerdManager(createMockDeps({ egressSecret: "owned-by-bootstrap" }));

    expect(mgr.getEgressSecret()).toBe("owned-by-bootstrap");
  });

  // -------------------------------------------------------------------------
  // Instance lifecycle
  // -------------------------------------------------------------------------
  describe("startWorker", () => {
    it("mints a bearer token for the worker entity callerId", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs());

      expect(deps.tokenManager.ensureToken).toHaveBeenCalledWith(
        "worker:workers/runtime-fixture:hello",
        "worker"
      );
    });

    it("resolves canonical worker target ids to loader instance names", async () => {
      const mgr = new WorkerdManager(createMockDeps());
      const handle = await mgr.startWorker(
        startArgs({ source: "workers/runtime-fixture", key: "instance:with spaces" })
      );

      expect(mgr.resolveWorkerInstanceName(handle.targetId)).toBe("instance_with_spaces");
      expect(mgr.resolveWorkerInstanceName("worker:workers/runtime-fixture:missing")).toBeNull();
    });

    it("injects parent handle metadata into the worker runtime env", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(
        startArgs({
          parent: {
            parentId: "panel-parent",
            parentEntityId: "panel:parent-entity",
            parentKind: "panel",
          },
        })
      );

      // Workers load dynamically — parent metadata travels in the per-instance env
      // served by `/_workercode`, not the workerd config.
      const code = await mgr.getWorkerCode("hello");
      expect(code?.env["PARENT_ID"]).toBe("panel-parent");
      expect(code?.env["PARENT_ENTITY_ID"]).toBe("panel:parent-entity");
      expect(code?.env["PARENT_KIND"]).toBe("panel");
      expect(code?.env["WORKER_EFFECTIVE_VERSION"]).toMatch(/^[0-9a-f]{64}$/);
      expect(code?.env["WORKER_SOURCE_REF"]).toMatch(/^state:[0-9a-f]{64}$/);
    });

    it("serves create-time user env to the dynamically loaded worker", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs({ env: { NON_SECRET_PROBE: "configured" } }));

      const code = await mgr.getWorkerCode("hello");
      expect(code?.env["NON_SECRET_PROBE"]).toBe("configured");
    });

    it("is idempotent for a live duplicate of the same identity (no-op re-attach)", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      const first = await mgr.startWorker(startArgs());
      // Same (source, key, contextId) → returns the existing instance as a no-op.
      const again = await mgr.startWorker(startArgs());

      expect(again).toEqual(first);
      expect(mgr.listInstances()).toHaveLength(1);
    });

    it("rejects a sanitized-name collision from a different identity (full targetId match required)", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs());
      // Same key (→ same sanitized name) but a different source ⇒ different
      // targetId ⇒ genuine collision, not a re-attach.
      await expect(mgr.startWorker(startArgs({ source: "workers/other" }))).rejects.toThrow(
        /different identity/
      );
      // Distinct raw keys that sanitize to the SAME name (`a:b` and `a_b`) ⇒
      // different targetId ⇒ must throw, not silently reuse the first worker.
      await mgr.startWorker(startArgs({ source: "workers/x", key: "a:b" }));
      await expect(mgr.startWorker(startArgs({ source: "workers/x", key: "a_b" }))).rejects.toThrow(
        /different identity/
      );
    });

    it("rejects the same (source, key) in another context (no silent cross-context reuse)", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs());
      // Same source+key maps to the same (context-free) targetId, but a launch in
      // a DIFFERENT context must NOT silently reuse the ctx-1 worker — reattach
      // requires a contextId match too. Callers must use context-unique keys
      // until worker canonical ids include contextId (tracked follow-up).
      await expect(mgr.startWorker(startArgs({ contextId: "ctx-2" }))).rejects.toThrow(
        /different identity/
      );
      expect(mgr.listInstances()).toHaveLength(1);
    });

    it("records a lifecycle event and lastError on failed start, cleared by a later success", async () => {
      const recordLifecycleEvent = vi.fn();
      const bindRuntimeImage = vi.fn().mockRejectedValueOnce(new Error("boom"));
      const deps = createMockDeps({ bindRuntimeImage, recordLifecycleEvent });
      const mgr = new WorkerdManager(deps);

      await expect(mgr.startWorker(startArgs())).rejects.toThrow("boom");

      expect(recordLifecycleEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "workers/runtime-fixture",
          callerId: "worker:workers/runtime-fixture:hello",
          level: "error",
          message: "Worker failed to start: boom",
          fields: expect.objectContaining({ event: "worker-start-failed" }),
        })
      );
      expect(mgr.getLastWorkerError("workers/runtime-fixture")).toEqual(
        expect.objectContaining({ message: "boom", timestamp: expect.any(Number) })
      );

      // Subsequent successful start clears the recorded failure.
      bindRuntimeImage.mockResolvedValue({
        source: "workers/runtime-fixture",
        unitName: "workers/runtime-fixture",
        artifact: runtimeArtifact("workers/runtime-fixture", "main"),
        authority: { provides: [], requests: [], serviceRequests: [] },
      });
      await mgr.startWorker(startArgs());

      expect(mgr.getLastWorkerError("workers/runtime-fixture")).toBeNull();
      expect(recordLifecycleEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          source: "workers/runtime-fixture",
          level: "info",
          fields: expect.objectContaining({ event: "worker-started" }),
        })
      );
    });

    it("rolls back on build failure", async () => {
      const deps = createMockDeps({
        bindRuntimeImage: vi.fn().mockRejectedValue(new Error("build failed")),
      });
      const mgr = new WorkerdManager(deps);

      await expect(mgr.startWorker(startArgs())).rejects.toThrow("build failed");

      expect(deps.tokenManager.revokeToken).toHaveBeenCalledWith(
        "worker:workers/runtime-fixture:hello"
      );
      expect(mgr.listInstances()).toHaveLength(0);
    });

    it("sanitizes special characters in the entity key", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs({ key: 'hello"; process.exit();//' }));
      const [instance] = mgr.listInstances();
      // All non-alphanumeric/dash/underscore chars replaced
      expect(instance?.name).not.toContain('"');
      expect(instance?.name).not.toContain(";");
      expect(instance?.name).toMatch(/^[a-zA-Z0-9_-]+$/);
    });
  });

  // -------------------------------------------------------------------------
  // Ref-specific builds
  // -------------------------------------------------------------------------
  describe("ref builds", () => {
    it("stores explicit state ref when provided", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs({ ref: "state:abc123" }));

      expect(statusOf(mgr, "hello")?.scopeRef).toBe("state:abc123");
      expect(deps.bindRuntimeImage).toHaveBeenCalledWith("workers/runtime-fixture", "state:abc123");
    });

    it("binds protected main only when explicitly requested", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs({ ref: "main" }));

      expect(statusOf(mgr, "hello")?.scopeRef).toBe("main");
      expect(deps.bindRuntimeImage).toHaveBeenCalledWith("workers/runtime-fixture", "main");
    });

    it("binds runtime-managed workers to their owning context by default", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      const prepared = await mgr.startWorker({
        source: "workers/new",
        key: "new-worker",
        contextId: "ctx-agent",
      });

      const artifact = runtimeArtifact("workers/new", "ctx:ctx-agent");
      expect(prepared.effectiveVersion).toBe(artifact.sourceState.effectiveVersion);
      expect(prepared.buildKey).toBe(artifact.buildKey);
      expect(deps.bindRuntimeImage).toHaveBeenCalledWith("workers/new", "ctx:ctx-agent");
      expect(statusOf(mgr, "new-worker")?.scopeRef).toBe("ctx:ctx-agent");
    });

    it("honors explicit context refs for runtime-managed workers", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker({
        source: "workers/new",
        key: "new-worker",
        contextId: "ctx-agent",
        ref: "ctx:ctx-agent",
      });

      expect(deps.bindRuntimeImage).toHaveBeenCalledWith("workers/new", "ctx:ctx-agent");
      expect(statusOf(mgr, "new-worker")?.scopeRef).toBe("ctx:ctx-agent");
    });

    it("binds runtime-managed DOs to their owning context by default", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.ensureDurableObjectEntity({
        source: "workers/new-do",
        className: "NewDO",
        key: "k1",
        contextId: "ctx-agent",
      });

      expect(deps.bindRuntimeImage).toHaveBeenCalledWith("workers/new-do", "ctx:ctx-agent");
    });

    it("restores an internal entity directly from its sealed service identity", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);
      const prepared = await mgr.ensureDurableObjectEntity({
        source: "vibestudio/internal",
        className: "BrowserVaultDO",
        key: "browser-environment",
        contextId: "ctx-internal",
      });

      await expect(
        mgr.restoreDurableObjectEntity({
          id: "do:vibestudio/internal:BrowserVaultDO:browser-environment",
          kind: "do",
          source: {
            repoPath: "vibestudio/internal",
            effectiveVersion: prepared.effectiveVersion,
          },
          activeBuildKey: prepared.buildKey,
          activeExecutionDigest: prepared.executionDigest,
          activeAuthority: prepared.authority,
          contextId: "ctx-internal",
          className: "BrowserVaultDO",
          key: "browser-environment",
          createdAt: 1,
          status: "active",
          cleanupComplete: false,
        })
      ).resolves.toBeUndefined();
      expect(deps.bindRuntimeImage).not.toHaveBeenCalled();
      expect(
        mgr
          .listRuntimeImages()
          .some(({ id }) => id === "do:vibestudio/internal:BrowserVaultDO:browser-environment")
      ).toBe(false);
    });

    ledgerTest("execution.workerd-start-worker", async () => {
      const deps = createMockDeps();
      const first = new WorkerdManager(deps);
      const prepared = await first.ensureDurableObjectEntity({
        source: "workers/new-do",
        className: "NewDO",
        key: "k1",
        contextId: "ctx-agent",
      });
      const sealedArtifact = runtimeArtifact("workers/new-do", "ctx:ctx-agent");
      vi.mocked(deps.getBuildByExecution).mockImplementation((buildKey, executionDigest) =>
        buildKey === sealedArtifact.buildKey && executionDigest === sealedArtifact.executionDigest
          ? mockWorkerBuildFor("workers/new-do", sealedArtifact)
          : null
      );
      vi.mocked(deps.bindRuntimeImage).mockClear();
      const restored = new WorkerdManager(deps);
      const record = {
        id: "do:workers/new-do:NewDO:k1",
        kind: "do" as const,
        source: {
          repoPath: "workers/new-do",
          effectiveVersion: prepared.effectiveVersion,
        },
        activeBuildKey: prepared.buildKey,
        activeExecutionDigest: prepared.executionDigest,
        activeAuthority: { ...prepared.authority },
        contextId: "ctx-agent",
        className: "NewDO",
        key: "k1",
        createdAt: 1,
        status: "active" as const,
        cleanupComplete: false,
      };

      await expect(restored.restoreDurableObjectEntity(record)).resolves.toBeUndefined();
      const version = restored.getDoVersion("workers/new-do", "NewDO", "k1");
      await expect(restored.restoreDurableObjectEntity(record)).resolves.toBeUndefined();
      expect(restored.getDoVersion("workers/new-do", "NewDO", "k1")).toBe(version);
      expect(restored.listRuntimeImages().some(({ id }) => id === record.id)).toBe(false);
      expect(deps.bindRuntimeImage).not.toHaveBeenCalled();
      const code = await restored.getDoCode("workers/new-do", "NewDO", "k1");
      expect(code).not.toBeNull();
    });

    it("restores and retires a sealed DO after its workspace source ref changes", async () => {
      const recordLifecycleEvent = vi.fn();
      const deps = createMockDeps({ recordLifecycleEvent });
      const first = new WorkerdManager(deps);
      const prepared = await first.ensureDurableObjectEntity({
        source: "workers/new-do",
        className: "NewDO",
        key: "k1",
        contextId: "ctx-agent",
      });
      const sealedArtifact = runtimeArtifact("workers/new-do", "ctx:ctx-agent");
      const changedSource = runtimeArtifact("workers/new-do", "changed");
      const changedUnsigned = {
        ...changedSource,
        recipeDigest: sealedArtifact.recipeDigest,
        buildKey: sealedArtifact.buildKey,
        artifactDigest: sealedArtifact.artifactDigest,
      };
      const changedArtifact = verifyExecutionArtifactRef({
        ...changedUnsigned,
        executionDigest: executionArtifactDigest(changedUnsigned),
      });
      vi.mocked(deps.getBuildByKey).mockImplementation((buildKey) =>
        buildKey === sealedArtifact.buildKey
          ? mockWorkerBuildFor("workers/new-do", changedArtifact)
          : null
      );
      deps.getBuildByExecution = vi.fn((buildKey, executionDigest) =>
        buildKey === sealedArtifact.buildKey && executionDigest === sealedArtifact.executionDigest
          ? mockWorkerBuildFor("workers/new-do", sealedArtifact)
          : null
      );
      vi.mocked(deps.bindRuntimeImage).mockImplementation(async (unitPath: string) => ({
        source: unitPath,
        unitName: unitPath,
        artifact: runtimeArtifact(unitPath, "changed"),
        authority: { provides: [], requests: [], serviceRequests: [] },
      }));
      vi.mocked(deps.bindRuntimeImage).mockClear();
      const restored = new WorkerdManager(deps);

      await restored.restoreDurableObjectEntity({
        id: "do:workers/new-do:NewDO:k1",
        kind: "do",
        source: {
          repoPath: "workers/new-do",
          effectiveVersion: prepared.effectiveVersion,
        },
        activeBuildKey: prepared.buildKey,
        activeExecutionDigest: prepared.executionDigest,
        activeAuthority: {
          ...prepared.authority,
        },
        contextId: "ctx-agent",
        className: "NewDO",
        key: "k1",
        createdAt: 1,
        status: "active",
        cleanupComplete: false,
      });

      expect(deps.bindRuntimeImage).not.toHaveBeenCalled();
      expect(deps.getBuildByExecution).toHaveBeenCalledWith(
        sealedArtifact.buildKey,
        sealedArtifact.executionDigest
      );
      expect(recordLifecycleEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          entityId: "do:workers/new-do:NewDO:k1",
          kind: "do",
          fields: expect.objectContaining({
            event: "runtime-image-attached",
            buildKey: sealedArtifact.buildKey,
            executionDigest: sealedArtifact.executionDigest,
          }),
        })
      );
      await expect(
        restored.retireDOEntity({
          source: "workers/new-do",
          className: "NewDO",
          objectKey: "k1",
        })
      ).resolves.toBeUndefined();
      expect(recordLifecycleEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          entityId: "do:workers/new-do:NewDO:k1",
          fields: expect.objectContaining({ event: "runtime-image-evicted" }),
        })
      );
    });

    it("fails a requested fault abort when workerd is not running", async () => {
      const manager = new WorkerdManager(createMockDeps());

      await expect(
        manager.faultAbortUserlandDOFacet({
          source: "workers/agent-worker",
          className: "AiChatWorker",
          objectKey: "agent:test",
        })
      ).rejects.toThrow("workerd is not running");
    });

    it("registers every userland DO egress caller with its complete sealed image", async () => {
      const registerEgressCaller = vi.fn();
      const deps = createMockDeps({ registerEgressCaller });
      const mgr = new WorkerdManager(deps);

      await mgr.registerAllDOClasses([
        { source: "workers/agent-worker", className: "AiChatWorker" },
      ]);

      expect(registerEgressCaller).toHaveBeenCalledWith(
        "workers/agent-worker:AiChatWorker",
        expect.objectContaining({
          code: expect.objectContaining({
            repoPath: "workers/agent-worker",
            executionDigest: runtimeArtifact("workers/agent-worker", "main").executionDigest,
            requested: [],
          }),
        })
      );
    });

    it("serves object-specific stateArgs in userland DO env", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      const prepared = await mgr.ensureDurableObjectEntity({
        source: "workers/new-do",
        className: "NewDO",
        key: "subagent-object",
        contextId: "ctx-agent",
        stateArgs: {
          subagent: {
            runId: "run-1",
            parentRef: "do:workers/agent-worker:AiChatWorker:ai-chat",
            parentChannelId: "ch-parent",
          },
        },
      });
      const sealedArtifact = runtimeArtifact("workers/new-do", "ctx:ctx-agent");
      vi.mocked(deps.getBuildByExecution).mockImplementation((buildKey, executionDigest) =>
        buildKey === sealedArtifact.buildKey && executionDigest === sealedArtifact.executionDigest
          ? mockWorkerBuildFor("workers/new-do", sealedArtifact)
          : null
      );
      await mgr.restoreDurableObjectEntity({
        id: prepared.targetId,
        kind: "do",
        source: {
          repoPath: "workers/new-do",
          effectiveVersion: prepared.effectiveVersion,
        },
        activeBuildKey: prepared.buildKey,
        activeExecutionDigest: prepared.executionDigest,
        activeAuthority: prepared.authority,
        contextId: "ctx-agent",
        className: "NewDO",
        key: "subagent-object",
        stateArgs: {
          subagent: {
            runId: "run-1",
            parentRef: "do:workers/agent-worker:AiChatWorker:ai-chat",
            parentChannelId: "ch-parent",
          },
        },
        createdAt: 1,
        status: "active",
        cleanupComplete: false,
      });

      const code = await mgr.getDoCode("workers/new-do", "NewDO", "subagent-object");
      expect(code?.env["WORKER_EFFECTIVE_VERSION"]).toBe(prepared.effectiveVersion);
      expect(code?.env["WORKER_SOURCE_REF"]).toMatch(/^state:[0-9a-f]{64}$/);
      expect(code?.env["STATE_ARGS"]).toEqual({
        subagent: {
          runId: "run-1",
          parentRef: "do:workers/agent-worker:AiChatWorker:ai-chat",
          parentChannelId: "ch-parent",
        },
      });
      expect(mgr.getDoVersion("workers/new-do", "NewDO", "subagent-object")).toMatch(
        /^[a-f0-9]{64}$/
      );
    });

    it("honors explicit context refs for runtime-managed DO object images", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.ensureDurableObjectEntity({
        source: "workers/new-do",
        className: "NewDO",
        key: "main-object",
        contextId: "ctx-agent",
      });
      vi.mocked(deps.bindRuntimeImage).mockClear();

      await mgr.ensureDurableObjectEntity({
        source: "workers/new-do",
        className: "NewDO",
        key: "branch-object",
        contextId: "ctx-agent",
        ref: "ctx:ctx-agent",
      });

      expect(deps.bindRuntimeImage).toHaveBeenCalledTimes(1);
      expect(deps.bindRuntimeImage).toHaveBeenCalledWith("workers/new-do", "ctx:ctx-agent");
      expect(mgr.getDoVersion("workers/new-do", "NewDO", "branch-object")).not.toBeNull();
    });

    it("binds bootstrap-style singleton DOs to explicit main instead of synthetic context refs", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);
      const syntheticContextId = "5b0784b0a6d5b81c3ba856394cb1eb6e456e4716ab43030e62d2e8de77a6d2de";

      const prepared = await mgr.ensureDurableObjectEntity({
        source: "workers/model-settings",
        className: "ModelSettingsDO",
        key: "workspace-model-settings",
        contextId: syntheticContextId,
        ref: "main",
      });

      expect(prepared.targetId).toBe(
        "do:workers/model-settings:ModelSettingsDO:workspace-model-settings"
      );
      expect(deps.bindRuntimeImage).toHaveBeenCalledWith("workers/model-settings", "main");
    });
  });

  describe("authority-first workspace stage", () => {
    it("fails closed for every workspace runtime before provider binding", async () => {
      const deps = createMockDeps();
      const mgr = new ProductWorkerdManager(deps);

      expect(mgr.getStage()).toBe("control-plane");
      await expect(mgr.ensureDOClass("workers/agent", "AgentDO")).rejects.toThrow(
        /sealed control-plane stage/
      );
      await expect(mgr.startWorker(startArgs())).rejects.toThrow(/sealed control-plane stage/);
      await expect(
        mgr.ensureDurableObjectEntity({
          source: "workers/workspace-source",
          className: "GadWorkspaceDO",
          key: "alternate-authority",
          contextId: "control-plane:test",
        })
      ).rejects.toThrow(/sealed control-plane stage/);
    });

    it("registers the manifest-declared source provider after bootstrap binding", async () => {
      const deps = createMockDeps();
      const mgr = new ProductWorkerdManager(deps);
      mgr.bindWorkspaceProvider(deps);

      await mgr.ensureDOClass("workers/workspace-source", "GadWorkspaceDO");

      expect(mgr.getStage()).toBe("workspace");
      expect(deps.bindRuntimeImage).toHaveBeenCalled();
    });

    it("prepares the source provider from the bootstrap workspace image", async () => {
      const deps = createMockDeps();
      const mgr = new ProductWorkerdManager(deps);
      mgr.bindWorkspaceProvider(deps);

      const prepared = await mgr.ensureDurableObjectEntity({
        source: "workers/workspace-source",
        className: "GadWorkspaceDO",
        key: "workspace",
        contextId: "control-plane:workspace",
      });

      expect(prepared).toMatchObject({
        targetId: "do:workers/workspace-source:GadWorkspaceDO:workspace",
        effectiveVersion: expect.stringMatching(/^[0-9a-f]{64}$/),
        buildKey: expect.stringMatching(/^[0-9a-f]{64}$/),
        executionDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        authority: { provides: [], requests: [], serviceRequests: [] },
      });
      expect(deps.bindRuntimeImage).toHaveBeenCalled();
    });

    it("binds the semantic-main-backed workspace provider exactly once", () => {
      const deps = createMockDeps();
      const mgr = new ProductWorkerdManager(deps);

      mgr.bindWorkspaceProvider(deps);

      expect(mgr.getStage()).toBe("workspace");
      expect(() => mgr.bindWorkspaceProvider(deps)).toThrow(/already bound/);
    });
  });

  // -------------------------------------------------------------------------
  // updateInstance (internal: codeVersion bump / ref retarget, no userland RPC)
  // -------------------------------------------------------------------------
  describe("updateInstance", () => {
    it("updates env", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs({ ref: "main" }));
      const updated = await mgr.updateInstance("hello", {
        env: { FOO: "bar" },
      });

      expect(updated.env).toEqual({ FOO: "bar" });
    });

    it("sets ref on update", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs({ ref: "main" }));
      const updated = await mgr.updateInstance("hello", { ref: "state:feature-x" });

      expect(updated.scopeRef).toBe("state:feature-x");
    });

    it("restores owning-context tracking on update with an empty selector", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs({ ref: "state:abc123" }));
      const updated = await mgr.updateInstance("hello", { ref: "" });

      expect(updated.scopeRef).toBe("ctx:ctx-1");
    });
  });

  // -------------------------------------------------------------------------
  // listInstances
  // -------------------------------------------------------------------------
  describe("listing", () => {
    it("listInstances strips tokens", async () => {
      const mgr = new WorkerdManager(createMockDeps());
      await mgr.startWorker(startArgs());

      const list = mgr.listInstances();
      expect(list).toHaveLength(1);
      expect(list[0]).not.toHaveProperty("token");
      expect(list[0]!.name).toBe("hello");
    });

    it("listInstances has no entry for an unknown name", () => {
      const mgr = new WorkerdManager(createMockDeps());
      expect(statusOf(mgr, "nope")).toBeNull();
    });

    it("starts workerd with a dev inspector and exposes it for running workers", async () => {
      const mgr = new WorkerdManager(createMockDeps());

      await mgr.startWorker(startArgs());

      expect(spawn).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.arrayContaining(["--inspector-addr=127.0.0.1:49652"]),
        expect.any(Object)
      );
      expect(mgr.getWorkerInspectorUrl("workers/runtime-fixture")).toBe("http://127.0.0.1:49652");
      expect(mgr.getWorkerInspectorUrl("workers/missing")).toBeNull();
    });

    it("retries startup on a fresh port when the router never becomes ready", async () => {
      let workerdPortCalls = 0;
      vi.mocked(findServicePort).mockImplementation(
        async (service: Parameters<typeof findServicePort>[0]) => {
          if (service === "workerdInspector") return 49652;
          return workerdPortCalls++ === 0 ? 49552 : 49553;
        }
      );
      const fetchMock = vi.fn(async (url: string | URL | Request) => {
        const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (href.includes(":49552/")) throw new TypeError("fetch failed");
        return new Response(null, { status: 204 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const mgr = new WorkerdManager(createMockDeps());
      await mgr.startWorker(startArgs());

      expect(mgr.getPort()).toBe(49553);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:49552/__vibestudio_workerd_ready",
        expect.any(Object)
      );
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:49553/__vibestudio_workerd_ready",
        expect.any(Object)
      );
    });
  });

  // -------------------------------------------------------------------------
  // reconcileMutableSourceBuild
  // -------------------------------------------------------------------------
  describe("reconcileMutableSourceBuild", () => {
    ledgerTest("execution.worker-push-rebuild", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs({ ref: "main" }));
      const before = mgr.getWorkerVersion("hello");
      await mgr.reconcileMutableSourceBuild(
        "workers/runtime-fixture",
        null,
        {
          publicationId: "publication:next",
          resultHostRefsBasisDigest: "host-refs:next",
          appliedAt: 42,
          workspaceStateHash: "state:next",
          changedPaths: ["workers/runtime-fixture/index.ts"],
          repositories: [
            {
              repoPath: "workers/runtime-fixture",
              previousStateHash: "state:prev",
              nextStateHash: "state:next",
              fileChanges: [],
            },
          ],
        },
        "build:workers/runtime-fixture:main"
      );

      // No restart — the worker host reloads on its next request because the
      // loader-cache version bumped. The instance stays "running" throughout.
      expect(statusOf(mgr, "hello")?.status).toBe("running");
      expect(mgr.getWorkerVersion("hello")).toBe((before ?? 0) + 1);
    });

    it("keeps rebuild codeVersion strictly above prior env-only updates", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs({ ref: "main" }));
      await mgr.updateInstance("hello", { env: { FEATURE: "enabled" } });
      const beforeRebuild = mgr.getWorkerVersion("hello");

      await mgr.reconcileMutableSourceBuild(
        "workers/runtime-fixture",
        null,
        {
          publicationId: "publication:next",
          resultHostRefsBasisDigest: "host-refs:next",
          appliedAt: 42,
          workspaceStateHash: "state:next",
          changedPaths: ["workers/runtime-fixture/index.ts"],
          repositories: [
            {
              repoPath: "workers/runtime-fixture",
              previousStateHash: "state:prev",
              nextStateHash: "state:next",
              fileChanges: [],
            },
          ],
        },
        "build:workers/runtime-fixture:main"
      );

      expect(mgr.getWorkerVersion("hello")).toBe((beforeRebuild ?? 0) + 1);
    });

    it("marks failed runtime image rebinds terminal after the warm attempt fails", async () => {
      const bindRuntimeImage = vi
        .fn()
        .mockResolvedValueOnce({
          source: "workers/runtime-fixture",
          unitName: "workers/runtime-fixture",
          artifact: runtimeArtifact("workers/runtime-fixture", "main"),
          authority: { provides: [], requests: [], serviceRequests: [] },
        })
        .mockRejectedValueOnce(new Error("Unknown vcs ref: ctx:deleted"));
      const deps = createMockDeps({
        bindRuntimeImage,
        getBuildByKey: vi.fn(() => null),
        statePath: fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-runtime-image-error-")),
      });
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs());

      await expect(mgr.getWorkerCode("hello")).rejects.toMatchObject({
        code: "RUNTIME_IMAGE_WARMING",
      });
      await vi.waitFor(() => expect(bindRuntimeImage).toHaveBeenCalledTimes(2));
      await expect(mgr.getWorkerCode("hello")).rejects.toMatchObject({
        code: "RUNTIME_IMAGE_UNAVAILABLE",
        message: expect.stringContaining("Unknown vcs ref: ctx:deleted"),
      });
    });

    it("skips ref-targeted instances", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs({ ref: "state:abc123" }));
      const callsBefore = vi.mocked(deps.bindRuntimeImage).mock.calls.length;

      // Ref-targeted instance should not restart on HEAD push
      await mgr.reconcileMutableSourceBuild(
        "workers/runtime-fixture",
        null,
        {
          publicationId: "publication:next",
          resultHostRefsBasisDigest: "host-refs:next",
          appliedAt: 42,
          workspaceStateHash: "state:next",
          changedPaths: ["workers/runtime-fixture/index.ts"],
          repositories: [
            {
              repoPath: "workers/runtime-fixture",
              previousStateHash: "state:prev",
              nextStateHash: "state:next",
              fileChanges: [],
            },
          ],
        },
        "build:workers/runtime-fixture:main"
      );

      const status = statusOf(mgr, "hello");
      expect(status?.status).toBe("running");
      // No additional bind calls — rebuild was skipped
      expect(deps.bindRuntimeImage).toHaveBeenCalledTimes(callsBefore);
    });

    it("does not restart workerd on a source rebuild", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs());
      const spawnsBefore = vi.mocked(spawn).mock.calls.length;

      await mgr.reconcileMutableSourceBuild("workers/runtime-fixture", null);

      // Dynamic loading: a rebuild is a loader-cache eviction, never a restart.
      expect(vi.mocked(spawn).mock.calls.length).toBe(spawnsBefore);
      expect(statusOf(mgr, "hello")?.status).toBe("running");
    });

    it("ignores unrelated sources", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs());
      const callsBefore = vi.mocked(deps.bindRuntimeImage).mock.calls.length;

      await mgr.reconcileMutableSourceBuild("workers/other", null);

      // No additional bind calls (no restart triggered)
      expect(vi.mocked(deps.bindRuntimeImage).mock.calls.length).toBe(callsBefore);
    });

    it("tears down stale DO services when a class is removed from the manifest", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      // Pre-register two DO classes from the same source.
      await mgr.registerAllDOClasses([
        { source: "workers/agent", className: "AgentDO" },
        { source: "workers/agent", className: "LegacyDO" },
      ]);

      const revokeSpy = vi.spyOn(deps.tokenManager, "revokeToken");

      // Manifest is re-read after a rebuild and now only declares AgentDO.
      await mgr.reconcileMutableSourceBuild("workers/agent", [{ className: "AgentDO" }]);

      // LegacyDO's service-level token was revoked.
      expect(revokeSpy).toHaveBeenCalledWith("do-service:workers/agent:LegacyDO");
      // The entry is gone from the map — config regeneration won't emit it.
      expect(revokeSpy).not.toHaveBeenCalledWith("do-service:workers/agent:AgentDO");
    });

    it("reconciles provider definitions and receiver classes before activating a rebuilt source", async () => {
      const resourceHandleLifecycle = {
        reconcileProviderDefinitions: vi.fn(),
        reconcileReceiverClasses: vi.fn(),
      };
      const deps = createMockDeps({ resourceHandleLifecycle });
      const mgr = new WorkerdManager(deps);

      await mgr.reconcileMutableSourceBuild(
        "workers/agent",
        [{ className: "AgentDO" }],
        undefined,
        "build:workers/agent:main"
      );

      expect(resourceHandleLifecycle.reconcileProviderDefinitions).toHaveBeenCalledWith(
        "workers/agent",
        []
      );
      expect(resourceHandleLifecycle.reconcileReceiverClasses).toHaveBeenCalledWith(
        "workers/agent",
        ["AgentDO"]
      );
    });

    it("leaves DO services alone for a non-authoritative rebuild", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.registerAllDOClasses([{ source: "workers/agent", className: "AgentDO" }]);

      const revokeSpy = vi.spyOn(deps.tokenManager, "revokeToken");
      await mgr.reconcileMutableSourceBuild("workers/agent", null);

      // No revokes — null explicitly means this rebuild does not own the main manifest.
      expect(revokeSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("do-service:workers/agent")
      );
    });

    it("tears down all DO services when manifest drops the durable block entirely", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.registerAllDOClasses([
        { source: "workers/agent", className: "A" },
        { source: "workers/agent", className: "B" },
      ]);

      const revokeSpy = vi.spyOn(deps.tokenManager, "revokeToken");
      // Empty array = "manifest declares no DO classes now" → remove all.
      await mgr.reconcileMutableSourceBuild("workers/agent", []);

      expect(revokeSpy).toHaveBeenCalledWith("do-service:workers/agent:A");
      expect(revokeSpy).toHaveBeenCalledWith("do-service:workers/agent:B");
    });

    it("keeps DO routes for lazily registered userland classes", async () => {
      const routeRegistry = new RouteRegistry();
      const singletonRegistry = new SingletonRegistry([
        { source: "workers/agent", className: "AgentDO", key: "agent" },
      ]);
      const deps = createMockDeps({
        routeRegistry,
        singletonRegistry,
        getManifestRoutes: (source) =>
          source === "workers/agent"
            ? [
                {
                  source: "workers/agent",
                  path: "/agent",
                  methods: ["POST"],
                  durableObject: { className: "AgentDO" },
                },
              ]
            : [],
      });
      const mgr = new WorkerdManager(deps);

      await mgr.reconcileMutableSourceBuild("workers/agent", [{ className: "AgentDO" }]);

      expect(vi.mocked(deps.bindRuntimeImage)).not.toHaveBeenCalled();
      expect(routeRegistry.lookup("/_r/w/workers/agent/agent", "POST", false)).toMatchObject({
        kind: "worker-do",
        source: "workers/agent",
        className: "AgentDO",
        objectKey: "agent",
      });
    });

    it("reconciles route table changes from meta-only manifest reloads", () => {
      const routeRegistry = new RouteRegistry();
      const singletonRegistry = new SingletonRegistry([
        { source: "workers/agent", className: "AgentDO", key: "agent" },
      ]);
      let routes = [
        {
          source: "workers/agent",
          path: "/agent",
          methods: ["POST" as const],
          durableObject: { className: "AgentDO" },
        },
      ];
      const deps = createMockDeps({
        routeRegistry,
        singletonRegistry,
        getManifestRoutes: (source) => (source === "workers/agent" ? routes : []),
        getManifestDoClasses: (source) =>
          source === "workers/agent" ? [{ className: "AgentDO" }] : [],
      });
      const mgr = new WorkerdManager(deps);

      mgr.reconcileManifestRoutes(["workers/agent"]);

      expect(vi.mocked(deps.bindRuntimeImage)).not.toHaveBeenCalled();
      expect(routeRegistry.lookup("/_r/w/workers/agent/agent", "POST", false)).toMatchObject({
        kind: "worker-do",
        source: "workers/agent",
        className: "AgentDO",
        objectKey: "agent",
      });

      routes = [
        {
          source: "workers/agent",
          path: "/poems",
          methods: ["POST" as const],
          durableObject: { className: "AgentDO" },
        },
      ];
      mgr.reconcileManifestRoutes(["workers/agent"]);

      expect(routeRegistry.lookup("/_r/w/workers/agent/agent", "POST", false)).toBeNull();
      expect(routeRegistry.lookup("/_r/w/workers/agent/poems", "POST", false)).toMatchObject({
        kind: "worker-do",
        objectKey: "agent",
      });

      routes = [];
      mgr.reconcileManifestRoutes([]);

      expect(routeRegistry.lookup("/_r/w/workers/agent/poems", "POST", false)).toBeNull();
    });

    it("rejects mutable userland ensureDO attachment", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      // Bring workerd up first (a worker create starts the static host); then
      // register a userland DO class — which by itself never restarts.
      await mgr.startWorker(startArgs());
      await mgr.registerAllDOClasses([{ source: "workers/agent", className: "AgentDO" }]);

      const restartBegin = vi.fn();
      mgr.onRestartBegin(restartBegin);

      // Route and lifecycle callers must attach through the sealed entity
      // record; this legacy API remains only for host-owned internal DOs.
      const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
      vi.stubGlobal("fetch", fetchMock);

      try {
        await expect(mgr.ensureDO("workers/agent", "AgentDO", "object-1")).rejects.toThrow(
          /requires a sealed entity record/
        );
      } finally {
        vi.unstubAllGlobals();
      }

      expect(fetchMock).not.toHaveBeenCalled();
      expect(restartBegin).not.toHaveBeenCalled();
    });
  });

  describe("universal DO host", () => {
    it("makes object-specific module graphs facet-owned instead of process-cache-owned", () => {
      expect(compiledWorkerdPrograms.universalDo).toContain(
        "const worker = this.env.LOADER.load({"
      );
      expect(compiledWorkerdPrograms.universalDo).not.toContain("this.env.LOADER.get(");
      expect(compiledWorkerdPrograms.universalDo).toContain(
        "if (this.loadedFacet?.version === args.version) return this.loadedFacet"
      );
      expect(compiledWorkerdPrograms.universalDo).toContain("Runtime entity retired");
      expect(compiledWorkerdPrograms.universalDo).toContain('this.ctx.facets.abort("do"');
      expect(compiledWorkerdPrograms.universalDo).toContain(
        'this.ctx.facets.abort("do", new Error("System-test injected vessel crash"))'
      );
      expect(compiledWorkerdPrograms.universalDo).toContain(
        "const egressIdentity = `do:${identity}:${userKey}`"
      );
    });
  });

  describe("restart lifecycle hooks and boot generation", () => {
    it("skips restart hooks on initial start but emits them for real restarts", async () => {
      const statePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-workerd-test-"));
      const mgr = new WorkerdManager(createMockDeps({ statePath }));
      const begin = vi.fn();
      const ready = vi.fn();
      mgr.onRestartBegin(begin);
      mgr.onRestartReady(ready);

      await mgr.startWorker(startArgs());
      expect(begin).not.toHaveBeenCalled();
      expect(ready).not.toHaveBeenCalled();
      expect(mgr.getBootGeneration()).toBe(1);

      // Worker update no longer restarts (the host is static); a real restart
      // (e.g. an internal-config change) still emits the begin/ready hooks and
      // bumps the boot generation. restartWorkerd is the internal restart entry.
      await (mgr as unknown as { restartWorkerd(): Promise<void> }).restartWorkerd();

      expect(begin).toHaveBeenCalledTimes(1);
      expect(ready).toHaveBeenCalledTimes(1);
      expect(ready.mock.calls[0]?.[0]).toMatchObject({
        generation: 2,
        previousGeneration: 1,
        reason: "planned",
      });
      expect(fs.readFileSync(path.join(statePath, ".boot-generation"), "utf8").trim()).toBe("2");

      const nextMgr = new WorkerdManager(createMockDeps({ statePath }));
      expect(nextMgr.getBootGeneration()).toBe(2);
    });

    it("replaces an unresponsive sandbox without a graceful begin RPC and reports crash recovery", async () => {
      const mgr = new WorkerdManager(createMockDeps());
      const begin = vi.fn();
      const ready = vi.fn();
      mgr.onRestartBegin(begin);
      mgr.onRestartReady(ready);

      await mgr.startWorker(startArgs());
      const initialGeneration = mgr.getBootGeneration();
      await Promise.all([
        mgr.recoverUnresponsiveSandbox("eval inv-loop exceeded its deadline"),
        mgr.recoverUnresponsiveSandbox("eval inv-other observed the same stalled runtime"),
      ]);

      expect(begin).not.toHaveBeenCalled();
      expect(ready).toHaveBeenCalledOnce();
      expect(ready).toHaveBeenCalledWith(
        expect.objectContaining({
          generation: initialGeneration + 1,
          previousGeneration: initialGeneration,
          reason: "crash",
        })
      );
      expect(mgr.getBootGeneration()).toBe(initialGeneration + 1);
    });

    it("lets crash recovery preempt a hung graceful prepare", async () => {
      const mgr = new WorkerdManager(createMockDeps());
      const ready = vi.fn();
      mgr.onRestartReady(ready);
      await mgr.startWorker(startArgs());

      let entered!: () => void;
      const beginEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      mgr.onRestartBegin(() => {
        entered();
        return new Promise<void>(() => {});
      });

      const planned = (mgr as unknown as { restartWorkerd(): Promise<void> }).restartWorkerd();
      await beginEntered;
      const crash = mgr.recoverUnresponsiveSandbox("liveness probe failed during prepare");

      await expect(Promise.all([planned, crash])).resolves.toBeDefined();
      expect(ready).toHaveBeenCalledOnce();
      expect(ready).toHaveBeenCalledWith(expect.objectContaining({ reason: "crash" }));
    });

    it("retries a queued crash recovery in its own transition after the owner transition fails", async () => {
      const mgr = new WorkerdManager(createMockDeps());
      const ready = vi.fn();
      mgr.onRestartReady(ready);
      await mgr.startWorker(startArgs());
      const internal = mgr as unknown as {
        restartWorkerd(): Promise<void>;
        startWorkerdOnce(): Promise<void>;
        restartRequests: Map<number, unknown>;
      };
      const originalStart = internal.startWorkerdOnce.bind(mgr);
      let starts = 0;
      vi.spyOn(internal, "startWorkerdOnce").mockImplementation(async () => {
        starts += 1;
        if (starts <= 3) throw new Error(`first transition start failure ${starts}`);
        await originalStart();
      });
      let queued: Promise<void> | null = null;
      mgr.onGenerationClosing(() => {
        queued ??= mgr.recoverUnresponsiveSandbox("crash queued during stopping");
      });

      await expect(internal.restartWorkerd()).rejects.toThrow(/first transition start failure 3/);
      expect(queued).not.toBeNull();
      await expect(queued!).resolves.toBeUndefined();
      expect(starts).toBe(4);
      expect(internal.restartRequests.size).toBe(0);
      expect(mgr.getPort()).not.toBeNull();
      expect(ready).toHaveBeenCalledWith(expect.objectContaining({ reason: "crash" }));
    });

    it("refuses to overlap generations when SIGKILL cannot be confirmed", async () => {
      const mgr = new WorkerdManager(
        createMockDeps({ workerdStopTimeoutsMs: { sigtermMs: 1, sigkillMs: 1 } })
      );
      await mgr.startWorker(startArgs());
      const spawnCount = vi.mocked(spawn).mock.calls.length;
      const internal = mgr as unknown as {
        process: { kill: ReturnType<typeof vi.fn> } | null;
        restartWorkerd(): Promise<void>;
        isPidAlive(pid: number): boolean;
      };
      internal.process!.kill = vi.fn(() => true);
      vi.spyOn(internal, "isPidAlive").mockReturnValue(true);

      await expect(internal.restartWorkerd()).rejects.toThrow(/refusing to overlap/u);
      expect(vi.mocked(spawn)).toHaveBeenCalledTimes(spawnCount);
    });

    it("recovers an unexpectedly exited runtime and reports a crash generation", async () => {
      const mgr = new WorkerdManager(createMockDeps());
      const begin = vi.fn();
      const ready = vi.fn();
      mgr.onRestartBegin(begin);
      mgr.onRestartReady(ready);

      await mgr.startWorker(startArgs());
      const initialGeneration = mgr.getBootGeneration();
      const crashed = vi.mocked(spawn).mock.results.at(-1)?.value as {
        emit(event: string, ...args: unknown[]): void;
      };

      crashed.emit("exit", 1, null);

      await vi.waitFor(() => {
        expect(mgr.getBootGeneration()).toBe(initialGeneration + 1);
      });
      expect(begin).not.toHaveBeenCalled();
      expect(ready).toHaveBeenCalledOnce();
      expect(ready).toHaveBeenCalledWith(
        expect.objectContaining({
          generation: initialGeneration + 1,
          previousGeneration: initialGeneration,
          reason: "crash",
        })
      );
    });

    it("closes restart admission before shutdown takes process ownership", async () => {
      const mgr = new WorkerdManager(createMockDeps());
      await mgr.startWorker(startArgs());
      const spawnCountBeforeRestart = vi.mocked(spawn).mock.calls.length;
      let releaseBegin!: () => void;
      let markBeginEntered!: () => void;
      const beginEntered = new Promise<void>((resolve) => {
        markBeginEntered = resolve;
      });
      const holdBegin = new Promise<void>((resolve) => {
        releaseBegin = resolve;
      });
      mgr.onRestartBegin(async () => {
        markBeginEntered();
        await holdBegin;
      });

      const restart = (mgr as unknown as { restartWorkerd(): Promise<void> }).restartWorkerd();
      await beginEntered;
      const shutdown = mgr.shutdown();
      releaseBegin();

      await Promise.all([restart, shutdown]);
      expect(vi.mocked(spawn)).toHaveBeenCalledTimes(spawnCountBeforeRestart);
      expect(mgr.getPort()).toBeNull();
      await expect(
        (mgr as unknown as { restartWorkerd(): Promise<void> }).restartWorkerd()
      ).rejects.toThrow("WorkerdManager is shutting down");
    });
  });

  describe("router generation", () => {
    it("routes source-scoped DO requests with arbitrary-depth source paths", async () => {
      const mgr = new WorkerdManager(createMockDeps());
      const router = await loadCompiledRouter();
      const fetchedUrls: string[] = [];
      const fetchedHeaders: Headers[] = [];
      const env = {
        WORKERD_GATEWAY_TOKEN: "mock-workerd-gateway-token",
        WORKERD_DISPATCH_SECRET: mgr.getDispatchSecret(),
        WORKERD_DO_BINDINGS: {
          "workspace/workers/example-store:EventStore":
            "do_workspace_workers_example_store_EventStore",
        },
        do_workspace_workers_example_store_EventStore: {
          idFromName: vi.fn((name: string) => ({ name })),
          get: vi.fn(() => ({
            fetch: vi.fn(async (request: Request) => {
              fetchedUrls.push(request.url);
              fetchedHeaders.push(new Headers(request.headers));
              return new Response("ok");
            }),
          })),
        },
      };

      const response = await router.fetch(
        new Request(
          "http://router/_w/workspace/workers/example-store/EventStore/ctx%2Fchat/appendEvents?x=1",
          {
            headers: {
              Authorization: "Bearer mock-workerd-gateway-token",
              "X-Vibestudio-Dispatch-Secret": mgr.getDispatchSecret(),
              [DIRECT_AUTHORITY_ACCEPTED_AT_HEADER]: "1",
            },
          }
        ),
        env
      );

      expect(response.status).toBe(200);
      expect(env.do_workspace_workers_example_store_EventStore.idFromName).toHaveBeenCalledWith(
        "ctx/chat"
      );
      expect(fetchedUrls).toEqual(["http://router/ctx%2Fchat/appendEvents?x=1"]);
      expect(fetchedHeaders[0]?.has("X-Vibestudio-Dispatch-Secret")).toBe(false);
      expect(Number(fetchedHeaders[0]?.get(DIRECT_AUTHORITY_ACCEPTED_AT_HEADER))).toBeGreaterThan(
        1
      );
    });

    it("rejects source-scoped DO requests without the dispatch secret", async () => {
      const mgr = new WorkerdManager(createMockDeps());
      const router = await loadCompiledRouter();
      const doFetch = vi.fn(async () => new Response("ok"));
      const env = {
        WORKERD_GATEWAY_TOKEN: "mock-workerd-gateway-token",
        WORKERD_DISPATCH_SECRET: mgr.getDispatchSecret(),
        WORKERD_DO_BINDINGS: {
          "workspace/workers/example-store:EventStore":
            "do_workspace_workers_example_store_EventStore",
        },
        do_workspace_workers_example_store_EventStore: {
          idFromName: vi.fn((name: string) => ({ name })),
          get: vi.fn(() => ({ fetch: doFetch })),
        },
      };

      const response = await router.fetch(
        new Request(
          "http://router/_w/workspace/workers/example-store/EventStore/ctx/appendEvents",
          {
            headers: { Authorization: "Bearer mock-workerd-gateway-token" },
          }
        ),
        env
      );

      expect(response.status).toBe(403);
      expect(doFetch).not.toHaveBeenCalled();
    });

    it("preserves a regular worker named _w when no static DO bindings exist", async () => {
      const router = await loadCompiledRouter();
      const workerHostFetch = vi.fn(async (request: Request) => {
        expect(request.headers.has("Authorization")).toBe(false);
        return new Response("regular worker");
      });

      const response = await router.fetch(
        new Request("http://router/_w/__rpc", {
          headers: {
            Authorization: "Bearer mock-workerd-gateway-token",
            "X-Vibestudio-Dispatch-Secret": "dispatch-secret",
          },
        }),
        {
          WORKERD_GATEWAY_TOKEN: "mock-workerd-gateway-token",
          WORKERD_DISPATCH_SECRET: "dispatch-secret",
          WORKERD_DO_BINDINGS: {},
          WORKER_HOST: { fetch: workerHostFetch },
        }
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("regular worker");
      expect(workerHostFetch).toHaveBeenCalledOnce();
    });
  });
});
