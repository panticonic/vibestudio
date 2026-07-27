import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VcsImportSnapshotResult, VcsStateNodeRef } from "@vibestudio/service-schemas/vcs";
import { ensureLayout, getBytes } from "./blobstoreService.js";
import {
  NativeDevelopmentExecutor,
  ReviewedNativeDevelopmentTools,
  UnavailableNativeDevelopmentToolDriver,
  scanNativeSnapshot,
  type NativeDevelopmentSemanticAdapter,
  type NativeDevelopmentSourcePlan,
  type NativeDevelopmentToolHandle,
  type NativeSnapshotDescriptor,
} from "./nativeDevelopmentExecutor.js";

const roots: string[] = [];
const baseEvent = { kind: "event", eventId: "event:child-base" } as const;
const ingress = {
  causalParent: null,
  contextIntegrity: {
    class: "external" as const,
    externalKeys: ["development-native-test"],
  },
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

interface Fixture {
  root: string;
  blobsDir: string;
  executor: NativeDevelopmentExecutor<NativeDevelopmentSourcePlan>;
  handle: NativeDevelopmentToolHandle;
  commitChildBase: ReturnType<typeof vi.fn>;
  importSnapshot: ReturnType<typeof vi.fn>;
  importedDescriptors: NativeSnapshotDescriptor[];
  materializeSource: ReturnType<typeof vi.fn>;
  launch: ReturnType<typeof vi.fn>;
}

async function fixture(options: { importFailsOnce?: boolean } = {}): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vibestudio-native-development-"));
  roots.push(root);
  const blobsDir = path.join(root, "blobs");
  ensureLayout(blobsDir);
  const sessionsRoot = path.join(root, "sessions");
  let working: VcsStateNodeRef = { kind: "application", applicationId: "application:dirty" };
  const importedDescriptors: NativeSnapshotDescriptor[] = [];
  const commitChildBase = vi.fn(async (input: { developmentContextId: string }) => {
    expect(input.developmentContextId).toBe("context:child");
    working = baseEvent;
    return baseEvent;
  });
  let shouldFailImport = options.importFailsOnce ?? false;
  const importSnapshot = vi.fn(
    async (input: {
      developmentContextId: string;
      repositoryId: string;
      expectedWorkingHead: VcsStateNodeRef;
      commandId: string;
      descriptor: NativeSnapshotDescriptor;
    }): Promise<VcsImportSnapshotResult> => {
      importedDescriptors.push(structuredClone(input.descriptor));
      if (shouldFailImport) {
        shouldFailImport = false;
        throw Object.assign(new Error("ambiguous transport loss"), { code: "ECONNRESET" });
      }
      const eventId = `event:checkpoint:${input.descriptor.source.snapshotRevision}`;
      working = { kind: "event", eventId };
      return {
        contextId: input.developmentContextId,
        eventId,
        workUnitId: `work-unit:${input.commandId}`,
        applicationId: `application:${input.commandId}`,
        externalSnapshot: {
          sourceKind: "filesystem",
          sourceUri: input.descriptor.source.uri,
          snapshotRevision: input.descriptor.source.snapshotRevision,
          snapshotDigest: input.descriptor.descriptorDigest,
          targetRepositoryIds: [input.repositoryId],
        },
        importedRepositoryIds: [input.repositoryId],
      };
    }
  );
  const handle: NativeDevelopmentToolHandle = {
    identity: { ownershipToken: "ownership:exact-job", processId: "process:42" },
    freezeForCheckpoint: vi.fn(async () => {}),
    resumeCheckpoint: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    retire: vi.fn(async () => {}),
  };
  const launch = vi.fn(async () => handle);
  const materializeSource = vi.fn(
    async (_plan: NativeDevelopmentSourcePlan, destination: string) => {
      await fs.mkdir(path.join(destination, "src"), { recursive: true });
      await fs.writeFile(path.join(destination, "src", "b.ts"), "b\n", { mode: 0o644 });
      await fs.writeFile(path.join(destination, "a.ts"), "a\n", { mode: 0o644 });
      await fs.writeFile(path.join(destination, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    }
  );
  const semantic: NativeDevelopmentSemanticAdapter = {
    commitChildBase,
    importSnapshot,
  };
  const executor = new NativeDevelopmentExecutor({
    root: sessionsRoot,
    blobsDir,
    executorId: "executor:local",
    tools: new ReviewedNativeDevelopmentTools([
      {
        toolId: "system-editor",
        executorId: "executor:local",
        availability: async () => ({ available: true }),
        launch,
      },
    ]),
    semantic,
    planSource: async () => ({
      version: 1,
      contextId: "context:child",
      repositoryId: "repository:vibestudio",
      repoPath: "projects/vibestudio",
      sourceState: working,
      planDigest: `plan:${working.kind === "event" ? working.eventId : working.applicationId}`,
    }),
    materializeSource,
    now: (() => {
      let now = 1_000;
      return () => ++now;
    })(),
  });
  return {
    root,
    blobsDir,
    executor,
    handle,
    commitChildBase,
    importSnapshot,
    importedDescriptors,
    materializeSource,
    launch,
  };
}

async function open(fx: Fixture) {
  return fx.executor.open({
    sessionId: "session-1",
    developmentContextId: "context:child",
    repositoryId: "repository:vibestudio",
    childWorkingHead: { kind: "application", applicationId: "application:dirty" },
    toolId: "system-editor",
    idempotencyKey: "open-1",
    ingress,
  });
}

describe("NativeDevelopmentExecutor", () => {
  it("returns typed executor-unavailable before committing or materializing", async () => {
    const fx = await fixture();
    const unavailable = new NativeDevelopmentExecutor({
      root: path.join(fx.root, "unavailable-sessions"),
      blobsDir: fx.blobsDir,
      executorId: "executor:local",
      tools: new ReviewedNativeDevelopmentTools([
        new UnavailableNativeDevelopmentToolDriver(
          "claude-code",
          "executor:local",
          "checkpoint-protocol-unavailable"
        ),
      ]),
      semantic: {
        commitChildBase: fx.commitChildBase,
        importSnapshot: fx.importSnapshot,
      },
      planSource: async () => {
        throw new Error("unavailable tool must not plan source");
      },
      materializeSource: fx.materializeSource,
    });

    await expect(
      unavailable.open({
        sessionId: "unavailable-session",
        developmentContextId: "context:child",
        repositoryId: "repository:vibestudio",
        childWorkingHead: { kind: "application", applicationId: "application:dirty" },
        toolId: "claude-code",
        idempotencyKey: "open-unavailable",
        ingress,
      })
    ).rejects.toMatchObject({
      name: "NativeDevelopmentExecutorUnavailableError",
      code: "EEXECUTOR_UNAVAILABLE",
      toolId: "claude-code",
      reason: "checkpoint-protocol-unavailable",
    });
    expect(fx.commitChildBase).not.toHaveBeenCalled();
    expect(fx.materializeSource).not.toHaveBeenCalled();
  });

  it("commits only the child base, materializes a marker-proven private tree, and launches a reviewed tool", async () => {
    const fx = await fixture();
    const result = await open(fx);

    expect(fx.commitChildBase).toHaveBeenCalledWith(
      expect.objectContaining({
        developmentContextId: "context:child",
        expectedWorkingHead: {
          kind: "application",
          applicationId: "application:dirty",
        },
        message: "Development session base session-1",
      })
    );
    expect(fx.materializeSource).toHaveBeenCalledTimes(1);
    expect(fx.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        ownedRootId: result.ownedRootId,
        repositoryRoot: path.join(fx.root, "sessions", "session-1", "repository"),
      })
    );
    expect(result).toMatchObject({
      state: "ready",
      baseEvent,
      pendingChanges: "unknown",
      process: fx.handle.identity,
    });
    const marker = JSON.parse(
      await fs.readFile(path.join(fx.root, "sessions", "session-1", "SESSION.json"), "utf8")
    ) as Record<string, unknown>;
    expect(marker).toMatchObject({ repoPath: "projects/vibestudio" });
    expect(marker).not.toHaveProperty("repositoryRoot");
    expect(
      await fs.readFile(path.join(fx.root, "sessions", "session-1", "repository", "a.ts"), "utf8")
    ).toBe("a\n");
  });

  it("freezes, imports one strictly ordered exact descriptor, resumes, and returns the cached retry", async () => {
    const fx = await fixture();
    await open(fx);

    const first = await fx.executor.checkpoint({
      sessionId: "session-1",
      idempotencyKey: "checkpoint-1",
      ingress,
    });
    const second = await fx.executor.checkpoint({
      sessionId: "session-1",
      idempotencyKey: "checkpoint-1",
      ingress,
    });

    expect(second).toEqual(first);
    expect(fx.handle.freezeForCheckpoint).toHaveBeenCalledTimes(1);
    expect(fx.handle.resumeCheckpoint).toHaveBeenCalledTimes(1);
    expect(fx.importSnapshot).toHaveBeenCalledTimes(1);
    const descriptor = fx.importedDescriptors[0]!;
    expect(descriptor.repositoryId).toBe("repository:vibestudio");
    expect(descriptor.repoPath).toBe("projects/vibestudio");
    expect(descriptor.source.uri).toBe("vibestudio-development://session/session-1");
    expect(descriptor.files.map((file) => file.path)).toEqual(["a.ts", "run.sh", "src/b.ts"]);
    expect(descriptor.files.map((file) => file.mode)).toEqual([0o644, 0o755, 0o644]);
    for (const file of descriptor.files) {
      expect(await getBytes(fx.blobsDir, file.contentHash)).not.toBeNull();
    }
  });

  it("retries the persisted frozen descriptor after an ambiguous import without rescanning changed bytes", async () => {
    const fx = await fixture({ importFailsOnce: true });
    await open(fx);
    await expect(
      fx.executor.checkpoint({
        sessionId: "session-1",
        idempotencyKey: "checkpoint-ambiguous",
        ingress,
      })
    ).rejects.toThrow("ambiguous transport loss");
    const firstDescriptor = fx.importedDescriptors[0]!;
    await fs.writeFile(
      path.join(fx.root, "sessions", "session-1", "repository", "a.ts"),
      "changed after ambiguous import\n",
      { mode: 0o644 }
    );

    const receipt = await fx.executor.checkpoint({
      sessionId: "session-1",
      idempotencyKey: "checkpoint-ambiguous",
      ingress,
    });

    expect(fx.importedDescriptors).toHaveLength(2);
    expect(fx.importedDescriptors[1]).toEqual(firstDescriptor);
    expect(receipt.snapshotRevision).toBe(firstDescriptor.source.snapshotRevision);
    expect(fx.handle.freezeForCheckpoint).toHaveBeenCalledTimes(2);
    expect(fx.handle.resumeCheckpoint).toHaveBeenCalledTimes(2);
  });

  it("rejects unsupported entries before semantic import and resumes the tool", async () => {
    const fx = await fixture();
    await open(fx);
    await fs.symlink("a.ts", path.join(fx.root, "sessions", "session-1", "repository", "link.ts"));

    await expect(
      fx.executor.checkpoint({
        sessionId: "session-1",
        idempotencyKey: "checkpoint-symlink",
        ingress,
      })
    ).rejects.toMatchObject({ code: "EUNSUPPORTED_NATIVE_ENTRY" });

    expect(fx.importSnapshot).not.toHaveBeenCalled();
    expect(fx.handle.resumeCheckpoint).toHaveBeenCalledTimes(1);
    expect(await fx.executor.inspect("session-1")).toMatchObject({
      state: "ready",
      process: fx.handle.identity,
    });
  });

  it("rejects unsupported modes before semantic import", async () => {
    if (process.platform === "win32") return;
    const fx = await fixture();
    await open(fx);
    const file = path.join(fx.root, "sessions", "session-1", "repository", "a.ts");
    await fs.chmod(file, 0o4644);

    await expect(
      fx.executor.checkpoint({
        sessionId: "session-1",
        idempotencyKey: "checkpoint-mode",
        ingress,
      })
    ).rejects.toThrow("rejects file mode 0o4644");
    expect(fx.importSnapshot).not.toHaveBeenCalled();
  });

  it("assesses pending changes only on demand with a cooperative freeze", async () => {
    const fx = await fixture();
    const opened = await open(fx);
    const clean = await fx.executor.inspect("session-1", { assessPendingChanges: true });
    expect(clean.pendingChanges).toBe("none");
    await fs.writeFile(
      path.join(fx.root, "sessions", "session-1", "repository", "a.ts"),
      "changed\n",
      { mode: 0o644 }
    );
    const dirty = await fx.executor.inspect("session-1", { assessPendingChanges: true });
    expect(dirty.pendingChanges).toBe("present");
    expect(opened.baseSnapshotRevision).not.toBe("");
    expect(fx.importSnapshot).not.toHaveBeenCalled();
  });

  it("records requires-repair when pending-change inspection cannot resume the tool", async () => {
    const fx = await fixture();
    await open(fx);
    vi.mocked(fx.handle.resumeCheckpoint).mockRejectedValueOnce(new Error("resume failed"));

    const inspected = await fx.executor.inspect("session-1", {
      assessPendingChanges: true,
    });

    expect(inspected).toMatchObject({
      state: "requires-repair",
      repair: {
        phase: "pending-change-resume",
        primaryError: "resume failed",
        knownEffects: { process: "unknown" },
      },
    });
  });

  it("fails closed on cold recovery and preserves a tree whose process ownership cannot be proven", async () => {
    const fx = await fixture();
    await open(fx);
    const cold = new NativeDevelopmentExecutor({
      root: path.join(fx.root, "sessions"),
      blobsDir: fx.blobsDir,
      executorId: "executor:local",
      tools: new ReviewedNativeDevelopmentTools([]),
      semantic: {
        commitChildBase: fx.commitChildBase,
        importSnapshot: fx.importSnapshot,
      },
      planSource: async () => {
        throw new Error("cold recovery must not consult mutable source");
      },
      materializeSource: async () => {
        throw new Error("cold recovery must not materialize");
      },
    });

    const recovered = await cold.recover("session-1");
    expect(recovered).toMatchObject({
      state: "requires-repair",
      repair: {
        phase: "cold-recovery",
        knownEffects: { nativeTree: "owned", process: "unknown" },
      },
    });
    const retired = await cold.forceRetire("session-1");
    expect(retired.retired).toBe(false);
    expect(retired.cleanupErrors[0]).toContain("no exact live handle");
    await expect(
      fs.stat(path.join(fx.root, "sessions", "session-1", "repository"))
    ).resolves.toBeDefined();
  });

  it("stops the exact owned handle before deleting the owned tree", async () => {
    const fx = await fixture();
    await open(fx);
    const retired = await fx.executor.forceRetire("session-1");

    expect(retired).toEqual({ retired: true, cleanupErrors: [] });
    expect(fx.handle.stop).toHaveBeenCalledTimes(1);
    await expect(fs.stat(path.join(fx.root, "sessions", "session-1"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("persists cleanup diagnostics when owned-tree deletion fails", async () => {
    const fx = await fixture();
    await open(fx);
    const originalRm = fs.rm.bind(fs);
    const repositoryRoot = path.join(fx.root, "sessions", "session-1", "repository");
    const rm = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (String(target) === repositoryRoot) throw new Error("filesystem busy");
      return originalRm(target, options);
    });
    try {
      const retired = await fx.executor.forceRetire("session-1");
      expect(retired).toEqual({
        retired: false,
        cleanupErrors: ["repository: filesystem busy"],
      });
      await expect(fx.executor.inspect("session-1")).resolves.toMatchObject({
        state: "requires-repair",
        repair: {
          phase: "force-retire",
          cleanupErrors: ["repository: filesystem busy"],
        },
      });
    } finally {
      rm.mockRestore();
    }
  });
});

describe("scanNativeSnapshot", () => {
  it("derives the same revision regardless of directory enumeration order", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vibestudio-native-scan-"));
    roots.push(root);
    const blobsDir = path.join(root, "blobs");
    ensureLayout(blobsDir);
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    await Promise.all([fs.mkdir(first), fs.mkdir(second)]);
    await fs.writeFile(path.join(first, "z.ts"), "z\n", { mode: 0o644 });
    await fs.writeFile(path.join(first, "a.ts"), "a\n", { mode: 0o644 });
    await fs.writeFile(path.join(second, "a.ts"), "a\n", { mode: 0o644 });
    await fs.writeFile(path.join(second, "z.ts"), "z\n", { mode: 0o644 });
    const common = {
      repositoryId: "repository:vibestudio",
      repoPath: "projects/vibestudio",
      sessionId: "session-deterministic",
      blobsDir,
      persist: false,
    };
    const [left, right] = await Promise.all([
      scanNativeSnapshot({ ...common, repositoryRoot: first }),
      scanNativeSnapshot({ ...common, repositoryRoot: second }),
    ]);
    expect(left).toEqual(right);
  });

  it("validates the complete tree before persisting any checkpoint blob", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vibestudio-native-two-phase-"));
    roots.push(root);
    const blobsDir = path.join(root, "blobs");
    ensureLayout(blobsDir);
    const repositoryRoot = path.join(root, "repository");
    await fs.mkdir(repositoryRoot);
    const acceptedBytes = `unique-before-unsupported-${root}\n`;
    await fs.writeFile(path.join(repositoryRoot, "a.ts"), acceptedBytes, { mode: 0o644 });
    await fs.symlink("a.ts", path.join(repositoryRoot, "z-link.ts"));
    const expectedDigest = await import("node:crypto").then(({ createHash }) =>
      createHash("sha256").update(acceptedBytes).digest("hex")
    );

    await expect(
      scanNativeSnapshot({
        repositoryRoot,
        repositoryId: "repository:vibestudio",
        repoPath: "projects/vibestudio",
        sessionId: "session-two-phase",
        blobsDir,
        persist: true,
      })
    ).rejects.toMatchObject({ code: "EUNSUPPORTED_NATIVE_ENTRY" });
    expect(await getBytes(blobsDir, expectedDigest)).toBeNull();
  });

  it("rejects a directory identity change observed across recursive traversal", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vibestudio-native-directory-race-"));
    roots.push(root);
    const blobsDir = path.join(root, "blobs");
    ensureLayout(blobsDir);
    const repositoryRoot = path.join(root, "repository");
    const directory = path.join(repositoryRoot, "src");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "a.ts"), "a\n", { mode: 0o644 });
    const originalLstat = fs.lstat.bind(fs);
    let directoryObservations = 0;
    const lstat = vi.spyOn(fs, "lstat").mockImplementation(async (target, options) => {
      const stat = await originalLstat(target, options as never);
      if (String(target) === directory && ++directoryObservations === 3) {
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
          ino: Number(stat.ino) + 1,
        });
      }
      return stat;
    });
    try {
      await expect(
        scanNativeSnapshot({
          repositoryRoot,
          repositoryId: "repository:vibestudio",
          repoPath: "projects/vibestudio",
          sessionId: "session-directory-race",
          blobsDir,
          persist: false,
        })
      ).rejects.toThrow("Native directory changed during checkpoint: src");
    } finally {
      lstat.mockRestore();
    }
  });
});
