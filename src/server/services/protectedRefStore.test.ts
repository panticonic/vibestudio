import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostRefBasisDigest } from "@vibestudio/shared/vcs/publication";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import {
  createProtectedRefStore,
  RefBasisConflictError,
  RefBatchConflictError,
  RefEventConflictError,
  RefValidationError,
} from "./protectedRefStore.js";

const A = `state:${"a".repeat(64)}`;
const B = `state:${"b".repeat(64)}`;
const C = `state:${"c".repeat(64)}`;
const roots: string[] = [];
const EMPTY_BASIS = hostRefBasisDigest([]);
const basis = (refs: Array<{ repoPath: string; contentRoot: string }>) => hostRefBasisDigest(refs);

async function makeStore() {
  const statePath = await fsp.mkdtemp(path.join(os.tmpdir(), "protected-main-"));
  roots.push(statePath);
  const gate = vi.fn(async () => undefined);
  const store = createProtectedRefStore({ statePath, gate, now: () => 42 });
  return { statePath, gate, store };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe("ProtectedRefStore", () => {
  it("atomically applies one exact batch with durable evidence", async () => {
    const { statePath, store, gate } = await makeStore();
    const listener = vi.fn();
    store.onRefsChanged(listener);
    const result = await store.updateMains({
      entries: [
        { repoPath: "packages/a", expectedOld: null, next: A },
        { repoPath: "packages/b", expectedOld: null, next: B },
      ],
      evidence: {
        publicationId: "publication:1",
        previousEventId: "event:before:1",
        publishedEventId: "event:after:1",
        hostRefsBasisDigest: EMPTY_BASIS,
      },
      gateContext: { approved: true },
    });
    expect(result.replayed).toBe(false);
    expect(
      store.listMains().map(({ repoPath, contentRoot }) => ({ repoPath, contentRoot }))
    ).toEqual([
      { repoPath: "packages/a", contentRoot: A },
      { repoPath: "packages/b", contentRoot: B },
    ]);
    expect(store.readAppliedPublication("publication:1")).toMatchObject({
      hostRefsBasisDigest: EMPTY_BASIS,
      resultHostRefsBasisDigest: basis([
        { repoPath: "packages/a", contentRoot: A },
        { repoPath: "packages/b", contentRoot: B },
      ]),
      appliedAt: 42,
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      publicationId: "publication:1",
      previousEventId: "event:before:1",
      publishedEventId: "event:after:1",
      resultHostRefsBasisDigest: basis([
        { repoPath: "packages/a", contentRoot: A },
        { repoPath: "packages/b", contentRoot: B },
      ]),
      appliedAt: 42,
      changes: [
        { repoPath: "packages/a", previousContentRoot: null, nextContentRoot: A },
        { repoPath: "packages/b", previousContentRoot: null, nextContentRoot: B },
      ],
    });
    expect(gate).toHaveBeenCalledOnce();

    const persisted = await fsp.readFile(
      path.join(statePath, "protected-publication-state.json"),
      "utf8"
    );
    expect(persisted).not.toContain("hostRefsDigest");
  });

  it("replays the exact publication after restart without approving or emitting twice", async () => {
    const { statePath, store } = await makeStore();
    const listener = vi.fn();
    store.onRefsChanged(listener);
    const input = {
      entries: [{ repoPath: "packages/a", expectedOld: null, next: A }],
      evidence: {
        publicationId: "publication:1",
        previousEventId: "event:before:1",
        publishedEventId: "event:after:1",
        hostRefsBasisDigest: EMPTY_BASIS,
      },
    };
    await store.updateMains(input);
    const gate = vi.fn(async () => undefined);
    const reloaded = createProtectedRefStore({ statePath, gate });
    await expect(reloaded.updateMains(input)).resolves.toMatchObject({ replayed: true });
    expect(gate).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("replays observers after a post-CAS failure and compacts acknowledged evidence", async () => {
    const { statePath, store } = await makeStore();
    const input = {
      entries: [{ repoPath: "packages/a", expectedOld: null, next: A }],
      evidence: {
        publicationId: "publication:observer-retry",
        previousEventId: "event:before:retry",
        publishedEventId: "event:after:retry",
        hostRefsBasisDigest: EMPTY_BASIS,
      },
    };
    store.onRefsChanged(async () => {
      throw new Error("observer interrupted");
    });
    await expect(store.updateMains(input)).rejects.toThrow("observer interrupted");
    expect(store.listMains()).toHaveLength(1);
    expect(
      store.readAppliedPublication(input.evidence.publicationId)?.observersAppliedAt
    ).toBeNull();

    const reopened = createProtectedRefStore({
      statePath,
      gate: async () => undefined,
      now: () => 84,
    });
    const recovered = vi.fn(async () => undefined);
    reopened.onRefsChanged(recovered);
    await expect(reopened.updateMains(input)).resolves.toMatchObject({ replayed: true });
    expect(recovered).toHaveBeenCalledOnce();
    expect(reopened.readAppliedPublication(input.evidence.publicationId)?.observersAppliedAt).toBe(
      84
    );
    reopened.acknowledgePublication(input.evidence.publicationId);

    await reopened.updateMains({
      entries: [{ repoPath: "packages/a", expectedOld: A, next: B }],
      evidence: {
        publicationId: "publication:next",
        previousEventId: "event:after:retry",
        publishedEventId: "event:after:next",
        hostRefsBasisDigest: hostRefBasisDigest([{ repoPath: "packages/a", contentRoot: A }]),
      },
    });
    expect(reopened.readAppliedPublication(input.evidence.publicationId)).toBeNull();
    expect(reopened.readAppliedPublication("publication:next")).not.toBeNull();
  });

  it("rejects altered basis evidence or a different ref set under an applied publication id", async () => {
    const { store } = await makeStore();
    await store.updateMains({
      entries: [{ repoPath: "packages/a", expectedOld: null, next: A }],
      evidence: {
        publicationId: "publication:1",
        previousEventId: "event:before:1",
        publishedEventId: "event:after:1",
        hostRefsBasisDigest: EMPTY_BASIS,
      },
    });
    await expect(
      store.updateMains({
        entries: [{ repoPath: "packages/a", expectedOld: null, next: A }],
        evidence: {
          publicationId: "publication:1",
          previousEventId: "event:before:1",
          publishedEventId: "event:after:1",
          hostRefsBasisDigest: basis([{ repoPath: "packages/unrelated", contentRoot: B }]),
        },
      })
    ).rejects.toBeInstanceOf(RefValidationError);
    await expect(
      store.updateMains({
        entries: [{ repoPath: "packages/a", expectedOld: null, next: B }],
        evidence: {
          publicationId: "publication:1",
          previousEventId: "event:before:1",
          publishedEventId: "event:after:1",
          hostRefsBasisDigest: EMPTY_BASIS,
        },
      })
    ).rejects.toBeInstanceOf(RefValidationError);
  });

  it("fails replay when durable evidence and current refs disagree", async () => {
    const { store } = await makeStore();
    await store.updateMains({
      entries: [{ repoPath: "packages/a", expectedOld: null, next: A }],
      evidence: {
        publicationId: "publication:1",
        previousEventId: "event:before:1",
        publishedEventId: "event:after:1",
        hostRefsBasisDigest: EMPTY_BASIS,
      },
    });
    await store.updateMains({
      entries: [{ repoPath: "packages/a", expectedOld: A, next: B }],
      evidence: {
        publicationId: "publication:2",
        previousEventId: "event:after:1",
        publishedEventId: "event:after:2",
        hostRefsBasisDigest: basis([{ repoPath: "packages/a", contentRoot: A }]),
      },
    });
    const replay = store.updateMains({
      entries: [{ repoPath: "packages/a", expectedOld: null, next: A }],
      evidence: {
        publicationId: "publication:1",
        previousEventId: "event:before:1",
        publishedEventId: "event:after:1",
        hostRefsBasisDigest: EMPTY_BASIS,
      },
    });
    await expect(replay).rejects.toBeInstanceOf(RefBasisConflictError);
    await expect(replay).rejects.toMatchObject({
      actualHostRefsBasisDigest: basis([{ repoPath: "packages/a", contentRoot: B }]),
      winningPublicationId: "publication:2",
    });
  });

  it("rejects stale all-or-nothing batches", async () => {
    const { store } = await makeStore();
    await store.updateMains({
      entries: [{ repoPath: "packages/a", expectedOld: null, next: A }],
      evidence: {
        publicationId: "publication:1",
        previousEventId: "event:before:1",
        publishedEventId: "event:after:1",
        hostRefsBasisDigest: EMPTY_BASIS,
      },
    });
    await expect(
      store.updateMains({
        entries: [
          { repoPath: "packages/a", expectedOld: C, next: B },
          { repoPath: "packages/b", expectedOld: null, next: C },
        ],
        evidence: {
          publicationId: "publication:2",
          previousEventId: "event:after:1",
          publishedEventId: "event:after:2",
          hostRefsBasisDigest: basis([{ repoPath: "packages/a", contentRoot: A }]),
        },
      })
    ).rejects.toBeInstanceOf(RefBatchConflictError);
    expect(store.readMain("packages/b")).toBeNull();
  });

  it("CASes disjoint batches against one aggregate basis and names the winning publication", async () => {
    const { statePath, store } = await makeStore();
    const outcomes = await Promise.allSettled([
      store.updateMains({
        entries: [{ repoPath: "packages/a", expectedOld: null, next: A }],
        evidence: {
          publicationId: "publication:a",
          previousEventId: "event:before:a",
          publishedEventId: "event:after:a",
          hostRefsBasisDigest: EMPTY_BASIS,
        },
      }),
      store.updateMains({
        entries: [{ repoPath: "packages/b", expectedOld: null, next: B }],
        evidence: {
          publicationId: "publication:b",
          previousEventId: "event:before:b",
          publishedEventId: "event:after:b",
          hostRefsBasisDigest: EMPTY_BASIS,
        },
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const refused = outcomes.find((outcome) => outcome.status === "rejected");
    expect(refused?.status === "rejected" ? refused.reason : null).toBeInstanceOf(
      RefEventConflictError
    );
    const conflict = refused?.status === "rejected" ? refused.reason : null;
    expect((conflict as RefEventConflictError).winningPublicationId).toMatch(/^publication:[ab]$/);

    const reopened = createProtectedRefStore({ statePath, gate: async () => undefined });
    expect(reopened.listMains()).toHaveLength(1);
    expect(
      ["publication:a", "publication:b"].filter(
        (publicationId) => reopened.readAppliedPublication(publicationId) !== null
      )
    ).toHaveLength(1);
  });

  it("records and replays empty aggregate transitions through the same CAS", async () => {
    const { statePath, store, gate } = await makeStore();
    const input = {
      entries: [],
      evidence: {
        publicationId: "publication:semantic-only",
        previousEventId: "event:before:semantic-only",
        publishedEventId: "event:after:semantic-only",
        hostRefsBasisDigest: EMPTY_BASIS,
      },
    };
    await expect(store.updateMains(input)).resolves.toMatchObject({ replayed: false });
    expect(gate).toHaveBeenCalledOnce();
    expect(gate).toHaveBeenCalledWith({
      entries: [],
      publication: {
        publicationId: "publication:semantic-only",
        previousEventId: "event:before:semantic-only",
        publishedEventId: "event:after:semantic-only",
      },
    });
    expect(store.readAppliedPublication("publication:semantic-only")).toMatchObject({
      resultHostRefsBasisDigest: EMPTY_BASIS,
      entries: [],
    });
    const replayGate = vi.fn(async () => undefined);
    const reopened = createProtectedRefStore({ statePath, gate: replayGate });
    await expect(reopened.updateMains(input)).resolves.toMatchObject({ replayed: true });
    expect(replayGate).not.toHaveBeenCalled();
  });

  it("rejects protected refs from another destructive workspace epoch", async () => {
    const { statePath, store } = await makeStore();
    await store.updateMains({
      entries: [{ repoPath: "packages/a", expectedOld: null, next: A }],
      evidence: {
        publicationId: "publication:old-epoch",
        previousEventId: "event:old-before",
        publishedEventId: "event:old-after",
        hostRefsBasisDigest: EMPTY_BASIS,
      },
    });
    const filePath = path.join(statePath, "protected-publication-state.json");
    const persisted = JSON.parse(await fsp.readFile(filePath, "utf8")) as Record<string, unknown>;
    await fsp.writeFile(
      filePath,
      JSON.stringify({ ...persisted, systemEpoch: WORKSPACE_SYSTEM_EPOCH - 1 })
    );

    expect(() => createProtectedRefStore({ statePath, gate: async () => undefined })).toThrow(
      /epoch .* is incompatible with host epoch .*recreate this pre-release workspace/
    );
  });

  it("refuses legacy or partial persistence shapes", async () => {
    const { statePath } = await makeStore();
    await fsp.writeFile(
      path.join(statePath, "protected-publication-state.json"),
      JSON.stringify({ version: 1, mains: [] })
    );
    expect(() => createProtectedRefStore({ statePath, gate: async () => undefined })).toThrow(
      "Unsupported or corrupt"
    );
    await fsp.writeFile(
      path.join(statePath, "protected-publication-state.json"),
      JSON.stringify({
        version: 4,
        systemEpoch: WORKSPACE_SYSTEM_EPOCH,
        headPublicationId: null,
        mainEventId: "event:orphan",
        mains: [],
        appliedPublications: [],
      })
    );
    expect(() => createProtectedRefStore({ statePath, gate: async () => undefined })).toThrow(
      "Unsupported or corrupt"
    );
  });
});
