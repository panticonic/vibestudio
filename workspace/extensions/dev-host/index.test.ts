import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@vibestudio/extension";
import type {
  DevHostProviderLaunchInput,
  DevLaunchStatus,
} from "@vibestudio/service-schemas/devHost";
import { DEV_HOST_PROVIDER_METHOD_NAMES } from "@vibestudio/service-schemas/devHost";
import { sha256 } from "@vibestudio/shared/execution/identity";
import { isEvalRunChallenge, NativeDevHostExecutor } from "./index.js";
import type { PendingCapabilityApproval } from "@vibestudio/shared/approvals";
import type { DevGeneration } from "./lifecycle.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("dev-host provider contract", () => {
  it("declares exactly the host schema methods", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("./package.json", import.meta.url), "utf8")
    ) as {
      vibestudio: { extension: { providerContracts: { devHost: { methods: string[] } } } };
    };
    expect(manifest.vibestudio.extension.providerContracts.devHost.methods).toEqual(
      DEV_HOST_PROVIDER_METHOD_NAMES
    );
  });
});

describe("child eval challenge correlation", () => {
  it("uses the canonical operation group when presentation details are service-specific", () => {
    const challenge = {
      approvalId: "approval-1",
      callerId: "worker:agent",
      callerKind: "worker",
      requestedAt: 1,
      decisionDeadlineAt: 2,
      operation: {
        kind: "inspection",
        verb: "Inspect workerd",
        object: { type: "workerd-inspector", label: "Target", value: "worker:one" },
        groupKey: "run-1:workerd-inspector:worker:one",
      },
      kind: "capability",
      capability: "workerd-inspector",
      title: "Inspect worker:one",
      details: [{ label: "Target", value: "worker:one" }],
    } satisfies PendingCapabilityApproval;

    expect(isEvalRunChallenge(challenge, "run-1")).toBe(true);
    expect(isEvalRunChallenge(challenge, "run-2")).toBe(false);
  });
});

function devGeneration(launchId: string, hostBuildId: string): DevGeneration {
  return {
    hostBuildId,
    readinessIdentity: {
      launchId,
      hostBuildId,
      serverId: `server-${hostBuildId}`,
      endpoint: "http://127.0.0.1:1",
      evalAuthorityRecipientKey: null,
    },
    childWorkspaceId: "child",
    childContextId: null,
    clientReadinessIdentity: null,
    processIdentity: `process-${hostBuildId}`,
  };
}

function retainedInput(root: string): DevHostProviderLaunchInput {
  return {
    launchId: "dev_retained",
    idempotencyKey: "same",
    owner: { principal: `code:panels/dev@${"a".repeat(64)}`, workspaceId: "ws", contextId: "ctx" },
    sourceRepoPath: "projects/vibestudio",
    sourceStateHash: "b".repeat(64),
    dirtyCount: 2,
    target: { kind: "isolated-host", client: "none", persistence: "retained" },
    snapshot: {
      snapshotId: "snapshot",
      executionInputHash: "c".repeat(64),
      recipeDigest: "d".repeat(64),
      sourceRoot: path.join(root, "source"),
      scratchRoot: path.join(root, "scratch"),
      manifestPath: path.join(root, "manifest.json"),
      createdAt: 1,
    },
    executionGrant: { resource: `repo/execution:${"c".repeat(64)}`, authorizedAt: 1 },
    evalAuthorityBridge: { parentHostId: "parent-host", publicKeySpki: "public-key" },
  };
}

function statusOf(input: DevHostProviderLaunchInput, hostBuildId: string): DevLaunchStatus {
  return {
    launchId: input.launchId,
    owner: input.owner,
    sourceRepoPath: "projects/vibestudio",
    sourceStateHash: input.sourceStateHash,
    dirtyCount: input.dirtyCount,
    executionInputHash: input.snapshot.executionInputHash,
    recipeDigest: input.snapshot.recipeDigest,
    activeSnapshotId: input.snapshot.snapshotId,
    candidateSourceStateHash: null,
    candidateDirtyCount: null,
    candidateExecutionInputHash: null,
    candidateRecipeDigest: null,
    candidateSnapshotId: null,
    target: input.target,
    state: "ready",
    activeHostBuildId: hostBuildId,
    candidateHostBuildId: null,
    readinessIdentity: {
      launchId: input.launchId,
      hostBuildId,
      serverId: "old-server",
      endpoint: "http://127.0.0.1:1",
      evalAuthorityRecipientKey: null,
    },
    childWorkspaceId: "child",
    childContextId: null,
    clientReadinessIdentity: null,
    processIdentity: null,
    restartCount: 0,
    startedAt: 1,
    updatedAt: 1,
    lastError: null,
  };
}

async function makeOwnedInput(
  snapshotRoot: string,
  stateHash: string
): Promise<DevHostProviderLaunchInput> {
  const result = retainedInput(snapshotRoot);
  result.sourceStateHash = stateHash;
  result.snapshot.snapshotId = `snapshot-${stateHash.slice(0, 4)}`;
  result.snapshot.executionInputHash = stateHash;
  result.snapshot.sourceRoot = path.join(snapshotRoot, "source");
  result.snapshot.scratchRoot = path.join(snapshotRoot, "scratch");
  result.snapshot.manifestPath = path.join(snapshotRoot, "snapshot.json");
  result.executionGrant.resource = `repo/execution:${stateHash}`;
  await mkdir(result.snapshot.sourceRoot, { recursive: true });
  await mkdir(path.join(result.snapshot.scratchRoot, "worktree"), { recursive: true });
  await writeFile(
    result.snapshot.manifestPath,
    JSON.stringify({
      version: 1,
      ownershipNonce: `owner-${stateHash.slice(0, 4)}`,
      snapshotId: result.snapshot.snapshotId,
      executionInputHash: result.snapshot.executionInputHash,
      recipeDigest: result.snapshot.recipeDigest,
    })
  );
  return result;
}

describe("NativeDevHostExecutor retained recovery", () => {
  it("quiesces a retained generation and restores verified data on candidate rollback", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "dev-host-handoff-"));
    roots.push(root);
    const storageRoot = path.join(root, "storage");
    const oldInput = await makeOwnedInput(path.join(root, "old-snapshot"), "a".repeat(64));
    const nextInput = await makeOwnedInput(path.join(root, "next-snapshot"), "b".repeat(64));
    const executor = new NativeDevHostExecutor({
      storage: { resolvePath: (relative: string) => path.join(storageRoot, relative) },
      log: { error: vi.fn(), info: vi.fn() },
    } as unknown as ExtensionContext);
    const internal = executor as unknown as {
      generations: Map<string, Record<string, unknown>>;
      builds: Map<string, { root: string; hostBuildId: string }>;
      startPrepared: (
        input: DevHostProviderLaunchInput,
        hostBuildId: string
      ) => Promise<Record<string, unknown>>;
    };
    const oldGeneration = {
      ...devGeneration(oldInput.launchId, "old-build"),
      launchId: oldInput.launchId,
      input: oldInput,
      buildRoot: path.join(oldInput.snapshot.scratchRoot, "worktree"),
      children: [],
      root: path.join(oldInput.snapshot.scratchRoot, "generation-old"),
      readyFile: path.join(oldInput.snapshot.scratchRoot, "ready-old.json"),
      client: null,
      running: true,
    };
    internal.generations.set(oldGeneration.processIdentity, oldGeneration);
    internal.builds.set(oldInput.launchId, {
      root: path.join(nextInput.snapshot.scratchRoot, "worktree"),
      hostBuildId: "new-build",
    });
    const dataRoot = path.join(storageRoot, "retained-data", sha256(oldInput.launchId));
    await mkdir(dataRoot, { recursive: true });
    await writeFile(path.join(dataRoot, "state.txt"), "last-good");

    internal.startPrepared = vi.fn(async (request, hostBuildId) => {
      const next = {
        ...(hostBuildId === "old-build"
          ? oldGeneration
          : devGeneration(request.launchId, hostBuildId)),
        launchId: request.launchId,
        input: request,
        buildRoot: path.join(request.snapshot.scratchRoot, "worktree"),
        children: [],
        root: path.join(request.snapshot.scratchRoot, `generation-${hostBuildId}`),
        readyFile: path.join(request.snapshot.scratchRoot, `ready-${hostBuildId}.json`),
        client: null,
        running: true,
        processIdentity:
          hostBuildId === "old-build" ? "restored-old:process" : "candidate-new:process",
      };
      if (hostBuildId === "new-build") {
        await writeFile(path.join(dataRoot, "state.txt"), "candidate-mutated");
      }
      internal.generations.set(next.processIdentity, next);
      return next;
    });

    const candidate = await executor.start(nextInput, "new-build");
    expect(await readFile(path.join(dataRoot, "state.txt"), "utf8")).toBe("candidate-mutated");
    const restored = await executor.rollbackCandidate(candidate, oldGeneration);
    expect(restored.hostBuildId).toBe("old-build");
    expect(await readFile(path.join(dataRoot, "state.txt"), "utf8")).toBe("last-good");
    await expect(
      access(path.join(storageRoot, "retained-handoffs", sha256(oldInput.launchId)))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("redacts credentials before exposing supervised logs", () => {
    const executor = new NativeDevHostExecutor({
      storage: { resolvePath: (relative: string) => relative },
      log: { error: vi.fn() },
    } as unknown as ExtensionContext);
    executor.appendLog(
      "launch",
      "info",
      "Bearer super-secret admin_token=top-secret https://host/?invite=one-time"
    );
    const [entry] = executor.logs("launch", 0);
    expect(entry?.message).not.toContain("super-secret");
    expect(entry?.message).not.toContain("top-secret");
    expect(entry?.message).not.toContain("one-time");
    expect(entry?.message).toContain("[REDACTED]");
  });

  it("releases only the exact host-owned snapshot layout", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "dev-host-snapshot-"));
    roots.push(root);
    await mkdir(path.join(root, "source"), { recursive: true });
    await mkdir(path.join(root, "scratch"), { recursive: true });
    const candidate = retainedInput(root);
    candidate.snapshot.manifestPath = path.join(root, "snapshot.json");
    await writeFile(
      candidate.snapshot.manifestPath,
      JSON.stringify({
        version: 1,
        ownershipNonce: "owned",
        snapshotId: candidate.snapshot.snapshotId,
        executionInputHash: candidate.snapshot.executionInputHash,
        recipeDigest: candidate.snapshot.recipeDigest,
      })
    );
    const executor = new NativeDevHostExecutor({
      storage: { resolvePath: (relative: string) => path.join(root, "storage", relative) },
      log: { error: vi.fn() },
    } as unknown as ExtensionContext);

    await executor.discard(candidate);
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restarts the exact retained last-good build when no old process remains", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "dev-host-recovery-"));
    roots.push(root);
    const input = retainedInput(root);
    const hostBuildId = "e".repeat(64);
    const retainedFile = path.join(root, "retained", sha256(input.launchId), `${hostBuildId}.json`);
    await mkdir(path.dirname(retainedFile), { recursive: true });
    await writeFile(
      retainedFile,
      JSON.stringify({
        version: 1,
        launchId: input.launchId,
        hostBuildId,
        buildRoot: path.join(root, "build"),
        input,
      })
    );
    const generation: DevGeneration = {
      hostBuildId,
      readinessIdentity: {
        launchId: input.launchId,
        hostBuildId,
        serverId: "recovered-server",
        endpoint: "http://127.0.0.1:2",
        evalAuthorityRecipientKey: null,
      },
      childWorkspaceId: "child",
      childContextId: null,
      clientReadinessIdentity: null,
      processIdentity: "4242:recovered",
    };
    const ctx = {
      storage: { resolvePath: (relative: string) => path.join(root, relative) },
      log: { error: vi.fn() },
    } as unknown as ExtensionContext;
    const executor = new NativeDevHostExecutor(ctx);
    executor.validate = vi.fn(async () => undefined);
    executor.start = vi.fn(async () => generation);

    await expect(executor.reconcilePersisted(statusOf(input, hostBuildId))).resolves.toEqual({
      status: "recovered",
      generation,
    });
    expect(executor.validate).toHaveBeenCalledWith(input, hostBuildId);
    expect(executor.start).toHaveBeenCalledWith(input, hostBuildId);
  });

  it("rejects a retained journal for a different execution input", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "dev-host-recovery-"));
    roots.push(root);
    const input = retainedInput(root);
    const hostBuildId = "e".repeat(64);
    const retainedFile = path.join(root, "retained", sha256(input.launchId), `${hostBuildId}.json`);
    await mkdir(path.dirname(retainedFile), { recursive: true });
    await writeFile(
      retainedFile,
      JSON.stringify({
        version: 1,
        launchId: input.launchId,
        hostBuildId,
        buildRoot: path.join(root, "build"),
        input: { ...input, sourceStateHash: "f".repeat(64) },
      })
    );
    const errorLog = vi.fn();
    const executor = new NativeDevHostExecutor({
      storage: { resolvePath: (relative: string) => path.join(root, relative) },
      log: { error: errorLog },
    } as unknown as ExtensionContext);
    executor.start = vi.fn();

    await expect(executor.reconcilePersisted(statusOf(input, hostBuildId))).resolves.toEqual({
      status: "not-running",
    });
    expect(executor.start).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("identity does not match"));
  });

  it("finishes recovery when the candidate was selected before handoff finalization", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "dev-host-promoted-recovery-"));
    roots.push(root);
    const oldInput = retainedInput(root);
    const oldHostBuildId = "e".repeat(64);
    const candidate = structuredClone(oldInput);
    candidate.sourceStateHash = "f".repeat(64);
    candidate.snapshot.snapshotId = "candidate-snapshot";
    candidate.snapshot.executionInputHash = "1".repeat(64);
    candidate.snapshot.recipeDigest = "2".repeat(64);
    candidate.executionGrant.resource = `repo/execution:${candidate.snapshot.executionInputHash}`;
    const candidateHostBuildId = "3".repeat(64);
    const retainedFile = path.join(
      root,
      "retained",
      sha256(candidate.launchId),
      `${candidateHostBuildId}.json`
    );
    const handoffRoot = path.join(root, "retained-handoffs", sha256(candidate.launchId));
    const dataRoot = path.join(root, "retained-data", sha256(candidate.launchId));
    const backupRoot = path.join(handoffRoot, "data-backup");
    await mkdir(path.dirname(retainedFile), { recursive: true });
    await mkdir(handoffRoot, { recursive: true });
    await writeFile(
      retainedFile,
      JSON.stringify({
        version: 1,
        launchId: candidate.launchId,
        hostBuildId: candidateHostBuildId,
        buildRoot: path.join(root, "candidate-build"),
        input: candidate,
      })
    );
    await writeFile(
      path.join(handoffRoot, "journal.json"),
      JSON.stringify({
        version: 1,
        phase: "candidate-running",
        launchId: candidate.launchId,
        oldHostBuildId,
        candidateHostBuildId,
        oldBuildRoot: path.join(root, "old-build"),
        oldInput,
        oldProcessIdentity: "0:old",
        candidateProcessIdentity: "0:candidate",
        dataRoot,
        backupRoot,
        backupDigest: "not-used-after-commit",
      })
    );
    const recovered = devGeneration(candidate.launchId, candidateHostBuildId);
    const executor = new NativeDevHostExecutor({
      storage: { resolvePath: (relative: string) => path.join(root, relative) },
      log: { error: vi.fn() },
    } as unknown as ExtensionContext);
    executor.validate = vi.fn(async () => undefined);
    const startPrepared = vi
      .spyOn(
        executor as unknown as {
          startPrepared(
            input: DevHostProviderLaunchInput,
            hostBuildId: string
          ): Promise<DevGeneration>;
        },
        "startPrepared"
      )
      .mockResolvedValue(recovered);

    await expect(
      executor.reconcilePersisted(statusOf(candidate, candidateHostBuildId))
    ).resolves.toEqual({ status: "recovered", generation: recovered });
    expect(executor.validate).toHaveBeenCalledWith(candidate, candidateHostBuildId);
    expect(startPrepared).toHaveBeenCalledWith(candidate, candidateHostBuildId);
    await expect(access(path.join(handoffRoot, "journal.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
