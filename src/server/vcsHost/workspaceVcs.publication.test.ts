import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProtectedPublicationEvent } from "@vibestudio/shared/protectedPublicationEvents";
import { hostRefBasisDigest } from "@vibestudio/shared/vcs/publication";
import {
  ensureLayout,
  mirrorWorktreeTree,
  putBytes,
  readFileAtTree,
  getBytes,
} from "../services/blobstoreService.js";
import {
  readWorkspaceHostLaunchRecord,
  writeWorkspaceHostLaunchRecord,
} from "@vibestudio/workspace/hostLaunchRecord";
import { parseWorkspaceSystemEpochEnvelope } from "@vibestudio/workspace/configParser";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import { createProtectedRefStore } from "../services/protectedRefStore.js";
import { createWorkspaceSemanticPort } from "../workspaceSourceProvider.js";
import { WorkspaceVcs } from "./workspaceVcs.js";

describe("WorkspaceVcs protected publication notification", () => {
  let root: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (root) await fsp.rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function interruptedPublication(semanticAcknowledged: boolean) {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "vcs-launch-recovery-"));
    const blobsDir = path.join(root, "blobs");
    const statePath = path.join(root, "state");
    const refsPath = path.join(statePath, "refs");
    ensureLayout(blobsDir);
    const contentHash = (
      await putBytes(blobsDir, Buffer.from(`systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\n`))
    ).digest;
    const meta = (
      await mirrorWorktreeTree(blobsDir, [{ path: "vibestudio.yml", contentHash, mode: 0o100644 }])
    ).stateHash;
    const original = createProtectedRefStore({ statePath: refsPath, gate: async () => undefined });
    const interruption = new Error("publication observer interrupted");
    original.onRefsChanged(() => {
      throw interruption;
    });
    const input = {
      entries: [{ repoPath: "meta", expectedOld: null, next: meta }],
      evidence: {
        publicationId: "publication:launch",
        previousEventId: "event:genesis",
        publishedEventId: "event:main",
        hostRefsBasisDigest: hostRefBasisDigest([]),
      },
    };
    await expect(original.updateMains(input)).rejects.toBe(interruption);
    if (semanticAcknowledged) {
      // The historical host defect persisted acknowledgement before observers.
      // Model that exact existing v6 journal, not a synthesized launch record.
      const file = path.join(refsPath, "protected-publication-state.json");
      const journal = JSON.parse(await fsp.readFile(file, "utf8"));
      journal.appliedPublications[0].semanticAcknowledgedAt = 84;
      await fsp.writeFile(file, JSON.stringify(journal));
    }
    const gate = vi.fn(async () => undefined);
    const refs = createProtectedRefStore({ statePath: refsPath, gate });
    const vcs = new WorkspaceVcs({
      workspaceId: "workspace:test",
      blobsDir,
      workspaceRoot: path.join(root, "source"),
      contextProjectionsRoot: path.join(root, "contexts"),
      buildSourcesRoot: path.join(root, "build-sources"),
      refs,
    });
    const effect = {
      effectId: input.evidence.publicationId,
      scopeKind: "context",
      scopeId: "workspace-initialization:workspace:test",
      commandId: "command:initial",
      kind: "publish-main",
      payload: {
        previousEventId: "event:genesis",
        publishedEventId: "event:main",
        repositories: [],
      },
      payloadDigest: "digest:initial",
      status: "pending",
      receipt: null,
      createdAt: "2026-07-16T12:00:00.000Z",
    };
    let pending = !semanticAcknowledged;
    const dispatch = vi.fn(async (_target: unknown, method: string) => {
      if (method === "vcsPendingSemanticEffects") return pending ? [effect] : [];
      if (method === "vcsSemanticEffectAck") {
        expect(readWorkspaceHostLaunchRecord(statePath)).not.toBeNull();
        expect(refs.readHeadPublication()?.observersAppliedAt).not.toBeNull();
        pending = false;
        return { kind: "complete", result: null };
      }
      throw new Error(`unexpected semantic method ${method}`);
    });
    await vcs.attachGad(
      createWorkspaceSemanticPort({ dispatch } as never, {
        source: "test/provider",
        className: "TestProvider",
        objectKey: "test",
      })
    );
    const writeLaunch = async (event: ProtectedPublicationEvent) => {
      const file = await readFileAtTree(blobsDir, event.workspaceStateHash, "meta/vibestudio.yml");
      if (!file) throw new Error("published manifest is missing");
      const manifest = await getBytes(blobsDir, file.contentHash);
      if (!manifest) throw new Error("published manifest bytes are missing");
      writeWorkspaceHostLaunchRecord(statePath, {
        version: 1,
        workspaceId: "workspace:test",
        stateHash: event.workspaceStateHash,
        publicationId: event.publicationId,
        systemEpoch: parseWorkspaceSystemEpochEnvelope(manifest.toString("utf8")),
      });
    };
    return { refs, vcs, statePath, gate, dispatch, writeLaunch };
  }

  for (const acknowledged of [false, true]) {
    it(`replays and joins the durable launch observer before semantic recovery completes (already acknowledged=${acknowledged})`, async () => {
      const { refs, vcs, statePath, gate, dispatch, writeLaunch } =
        await interruptedPublication(acknowledged);
      let enter!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let release!: () => void;
      const join = new Promise<void>((resolve) => {
        release = resolve;
      });
      const observer = vi.fn(async (event: ProtectedPublicationEvent) => {
        enter();
        await join;
        await writeLaunch(event);
      });
      vcs.onProtectedPublication(observer);
      const recovery = vcs.recoverPendingSemanticEffects();
      try {
        expect(await Promise.race([entered.then(() => true), recovery.then(() => false)])).toBe(
          true
        );
        expect(readWorkspaceHostLaunchRecord(statePath)).toBeNull();
        expect(dispatch).not.toHaveBeenCalledWith(
          expect.anything(),
          "vcsSemanticEffectAck",
          expect.anything()
        );
      } finally {
        release();
      }
      await expect(recovery).resolves.toBe(acknowledged ? 0 : 1);
      expect(observer).toHaveBeenCalledOnce();
      expect(gate).not.toHaveBeenCalled();
      expect(readWorkspaceHostLaunchRecord(statePath)).toMatchObject({
        publicationId: refs.readHeadPublication()?.publicationId,
        systemEpoch: WORKSPACE_SYSTEM_EPOCH,
      });
      await expect(vcs.recoverPendingSemanticEffects()).resolves.toBe(0);
      expect(observer).toHaveBeenCalledOnce();
    });
  }

  it("preserves observer failure and never acknowledges an incomplete launch publication", async () => {
    const { refs, vcs, statePath, dispatch } = await interruptedPublication(false);
    const failure = new Error("durable launch observer failed");
    vcs.onProtectedPublication(() => {
      throw failure;
    });
    await expect(vcs.recoverPendingSemanticEffects()).rejects.toBe(failure);
    expect(refs.readHeadPublication()?.observersAppliedAt).toBeNull();
    expect(refs.readHeadPublication()?.semanticAcknowledgedAt).toBeNull();
    expect(readWorkspaceHostLaunchRecord(statePath)).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("emits the complete CAS batch even when source mirroring fails", async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "vcs-publication-"));
    const blobsDir = path.join(root, "blobs");
    const workspaceRoot = path.join(root, "source");
    ensureLayout(blobsDir);
    await fsp.mkdir(workspaceRoot, { recursive: true });
    // A file where the repository parent directory belongs forces the
    // non-authoritative source mirror to fail after notification.
    await fsp.writeFile(path.join(workspaceRoot, "packages"), "blocked\n");
    const contentHash = (await putBytes(blobsDir, Buffer.from("published\n"))).digest;
    const stateHash = (
      await mirrorWorktreeTree(blobsDir, [{ path: "index.ts", contentHash, mode: 0o100644 }])
    ).stateHash;
    const refs = createProtectedRefStore({
      statePath: path.join(root, "refs"),
      gate: async () => undefined,
    });
    const vcs = new WorkspaceVcs({
      workspaceId: "workspace:test",
      blobsDir,
      workspaceRoot,
      contextProjectionsRoot: path.join(root, ".context-projections", "v5"),
      buildSourcesRoot: path.join(root, "build-sources"),
      extractMainToSource: true,
      refs,
    });
    await vcs.attachGad(
      createWorkspaceSemanticPort({ dispatch: async () => undefined as never } as never, {
        source: "test/provider",
        className: "TestProvider",
        objectKey: "test",
      })
    );
    let releaseListener!: () => void;
    const listenerGate = new Promise<void>((resolve) => {
      releaseListener = resolve;
    });
    let listenerEntered!: () => void;
    const listenerReady = new Promise<void>((resolve) => {
      listenerEntered = resolve;
    });
    const observed: ProtectedPublicationEvent[] = [];
    const listener = vi.fn(async (event: ProtectedPublicationEvent) => {
      observed.push(event);
      listenerEntered();
      await listenerGate;
    });
    vcs.onProtectedPublication(listener);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    let publicationSettled = false;
    const publication = refs.updateMains({
      entries: [{ repoPath: "packages/app", expectedOld: null, next: stateHash }],
      evidence: {
        publicationId: "publication:test",
        previousEventId: "event:genesis",
        publishedEventId: "event:test",
        hostRefsBasisDigest: hostRefBasisDigest([]),
      },
    });
    const publicationCompletion = publication.then(() => {
      publicationSettled = true;
      throw new Error("Publication completed without joining its listener");
    });
    try {
      await Promise.race([listenerReady, publicationCompletion]);
      expect(listener).toHaveBeenCalledOnce();
      expect(publicationSettled).toBe(false);
    } finally {
      releaseListener();
      await publication;
    }

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        publicationId: "publication:test",
        resultHostRefsBasisDigest: hostRefBasisDigest([
          { repoPath: "packages/app", contentRoot: stateHash },
        ]),
        changedPaths: ["packages/app/index.ts"],
        repositories: [
          expect.objectContaining({
            repoPath: "packages/app",
            previousStateHash: null,
            nextStateHash: stateHash,
            fileChanges: [
              {
                kind: "added",
                path: "packages/app/index.ts",
                oldContentHash: null,
                newContentHash: contentHash,
                oldExecutable: null,
                newExecutable: false,
              },
            ],
          }),
        ],
      })
    );

    // A new semantic main event can be published without changing any
    // repository roots. Its publication identity still advances, so observers
    // that persist the exact host launch coordinate must receive it.
    await refs.updateMains({
      entries: [],
      evidence: {
        publicationId: "publication:empty-roots",
        previousEventId: "event:test",
        publishedEventId: "event:empty-roots",
        hostRefsBasisDigest: hostRefBasisDigest([
          { repoPath: "packages/app", contentRoot: stateHash },
        ]),
      },
    });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        publicationId: "publication:empty-roots",
        workspaceStateHash: expect.any(String),
        changedPaths: [],
        repositories: [],
        resultHostRefsBasisDigest: hostRefBasisDigest([
          { repoPath: "packages/app", contentRoot: stateHash },
        ]),
      })
    );
    expect(observed[1]?.workspaceStateHash).toBe(observed[0]?.workspaceStateHash);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("protected publication source mirror failed"),
      expect.anything()
    );
  });

  it("joins bounded independent repo diffs and retains every failure before notification", async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "vcs-publication-diffs-"));
    const blobsDir = path.join(root, "blobs");
    ensureLayout(blobsDir);
    const contentHash = (await putBytes(blobsDir, Buffer.from("published\n"))).digest;
    const stateHash = (
      await mirrorWorktreeTree(blobsDir, [{ path: "index.ts", contentHash, mode: 0o100644 }])
    ).stateHash;
    const refs = createProtectedRefStore({
      statePath: path.join(root, "refs"),
      gate: async () => undefined,
    });
    const vcs = new WorkspaceVcs({
      workspaceId: "workspace:test",
      blobsDir,
      workspaceRoot: path.join(root, "source"),
      contextProjectionsRoot: path.join(root, ".context-projections", "v5"),
      buildSourcesRoot: path.join(root, "build-sources"),
      refs,
    });
    await vcs.attachGad(
      createWorkspaceSemanticPort({ dispatch: async () => undefined as never } as never, {
        source: "test/provider",
        className: "TestProvider",
        objectKey: "test",
      })
    );
    const notification = vi.fn();
    vcs.onProtectedPublication(notification);

    const expectedFailures = [
      new Error("first repository diff failed"),
      new Error("later repository diff failed"),
    ];
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    let releaseBatch!: () => void;
    const batchGate = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    let initialBatchStarted!: () => void;
    const initialBatch = new Promise<void>((resolve) => {
      initialBatchStarted = resolve;
    });
    vi.spyOn(vcs, "diffStates").mockImplementation(async () => {
      const index = calls++;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (calls === 32) initialBatchStarted();
      await batchGate;
      active -= 1;
      if (index === 0) throw expectedFailures[0];
      if (index === 7) throw expectedFailures[1];
      return { added: [], removed: [], changed: [] };
    });

    const entries = Array.from({ length: 36 }, (_, index) => ({
      repoPath: `packages/repo-${String(index).padStart(2, "0")}`,
      expectedOld: null,
      next: stateHash,
    }));
    const publication = refs.updateMains({
      entries,
      evidence: {
        publicationId: "publication:parallel-diffs",
        previousEventId: "event:genesis",
        publishedEventId: "event:parallel-diffs",
        hostRefsBasisDigest: hostRefBasisDigest([]),
      },
    });
    let timeoutHandle!: ReturnType<typeof setTimeout>;
    const reachedBound = await Promise.race([
      initialBatch.then(() => true),
      new Promise<boolean>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(false), 1_000);
      }),
    ]);
    clearTimeout(timeoutHandle);
    releaseBatch();
    const failure = await publication.then(
      () => undefined,
      (error: unknown) => error
    );

    expect(reachedBound).toBe(true);
    expect(maximumActive).toBe(32);
    expect(calls).toBe(entries.length);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw failure;
    expect(failure.errors).toEqual(expectedFailures);
    expect(failure.cause).toBe(expectedFailures[0]);
    expect(notification).not.toHaveBeenCalled();
  });

  it("keeps published repository order when independent diffs finish out of order", async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "vcs-publication-order-"));
    const blobsDir = path.join(root, "blobs");
    ensureLayout(blobsDir);
    const contentHash = (await putBytes(blobsDir, Buffer.from("published\n"))).digest;
    const stateHash = (
      await mirrorWorktreeTree(blobsDir, [{ path: "index.ts", contentHash, mode: 0o100644 }])
    ).stateHash;
    const refs = createProtectedRefStore({
      statePath: path.join(root, "refs"),
      gate: async () => undefined,
    });
    const vcs = new WorkspaceVcs({
      workspaceId: "workspace:test",
      blobsDir,
      workspaceRoot: path.join(root, "source"),
      contextProjectionsRoot: path.join(root, ".context-projections", "v5"),
      buildSourcesRoot: path.join(root, "build-sources"),
      refs,
    });
    await vcs.attachGad(
      createWorkspaceSemanticPort({ dispatch: async () => undefined as never } as never, {
        source: "test/provider",
        className: "TestProvider",
        objectKey: "test",
      })
    );
    const observed: ProtectedPublicationEvent[] = [];
    vcs.onProtectedPublication((event) => {
      observed.push(event);
    });
    const completionOrder: number[] = [];
    let diffIndex = 0;
    vi.spyOn(vcs, "diffStates").mockImplementation(async () => {
      const index = diffIndex++;
      await new Promise<void>((resolve) => setTimeout(resolve, [20, 10, 1][index]));
      completionOrder.push(index);
      return { added: [], removed: [], changed: [] };
    });

    const entries = ["zeta", "alpha", "mu"].map((name) => ({
      repoPath: `packages/${name}`,
      expectedOld: null,
      next: stateHash,
    }));
    await refs.updateMains({
      entries,
      evidence: {
        publicationId: "publication:ordered-diffs",
        previousEventId: "event:genesis",
        publishedEventId: "event:ordered-diffs",
        hostRefsBasisDigest: hostRefBasisDigest([]),
      },
    });

    expect(observed[0]?.repositories.map((repository) => repository.repoPath)).toEqual([
      "packages/alpha",
      "packages/mu",
      "packages/zeta",
    ]);
    expect(completionOrder).toEqual([2, 1, 0]);
  });

  it("serializes every protected-main author while allowing one authoring lease to publish", async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "vcs-publication-lease-"));
    const blobsDir = path.join(root, "blobs");
    ensureLayout(blobsDir);
    const vcs = new WorkspaceVcs({
      workspaceId: "workspace:test",
      blobsDir,
      workspaceRoot: path.join(root, "source"),
      contextProjectionsRoot: path.join(root, ".context-projections", "v5"),
      buildSourcesRoot: path.join(root, "build-sources"),
      refs: createProtectedRefStore({
        statePath: path.join(root, "refs"),
        gate: async () => undefined,
      }),
    });
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = vcs.withProtectedMainMutation(async () => {
      order.push("first:start");
      await gate;
      await vcs.withProtectedMainMutation(async () => {
        order.push("first:publish");
      });
      order.push("first:end");
    });
    await vi.waitFor(() => expect(order).toEqual(["first:start"]));
    const second = vcs.withProtectedMainMutation(async () => {
      order.push("second");
    });
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:publish", "first:end", "second"]);
  });
});
