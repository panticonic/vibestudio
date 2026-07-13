import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";
import {
  createProtectedRefStore,
  isRefConflictError,
  RefBatchConflictError,
  RefValidationError,
  type RefChange,
  type RefGate,
  type RefGateBatch,
  type UpdateMainsInput,
} from "./protectedRefStore.js";

const STATE_A = `state:${"a".repeat(64)}`;
const STATE_B = `state:${"b".repeat(64)}`;
const STATE_C = `state:${"c".repeat(64)}`;
const MANIFEST_D = `manifest:${"d".repeat(64)}`;

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-ref-service-"));
}

function makeService(
  opts: {
    statePath?: string;
    gate?: RefGate;
    now?: () => number;
    assertTreeComplete?: (stateHash: string) => Promise<void>;
  } = {}
) {
  const statePath = opts.statePath ?? tempDir();
  const gateCalls: RefGateBatch[] = [];
  let clock = 1_000;
  const service = createProtectedRefStore({
    statePath,
    gate:
      opts.gate ??
      (async (batch) => {
        gateCalls.push(batch);
      }),
    now: opts.now ?? (() => ++clock),
    ...(opts.assertTreeComplete ? { assertTreeComplete: opts.assertTreeComplete } : {}),
  });
  return { service, statePath, gateCalls };
}

function update(overrides: Partial<UpdateMainsInput> = {}): UpdateMainsInput {
  return {
    entries: [{ repoPath: "packages/journal", expectedOld: null, next: STATE_A }],
    operation: "push",
    ...overrides,
  };
}

describe("protectedRefStore.updateMains", () => {
  it("creates a main via expectedOld:null CAS and reads it back", async () => {
    const { service } = makeService();
    expect(service.readMain("packages/journal")).toBeNull();

    const result = await service.updateMains(update());
    expect(result.updated).toEqual([{ repoPath: "packages/journal", stateHash: STATE_A, seq: 1 }]);
    expect(service.readMain("packages/journal")).toEqual({
      repoPath: "packages/journal",
      stateHash: STATE_A,
      updatedAt: 1_001,
    });
  });

  it("advances with matching expectedOld, using the injected clock", async () => {
    const { service } = makeService();
    await service.updateMains(update());
    const result = await service.updateMains(
      update({
        entries: [{ repoPath: "packages/journal", expectedOld: STATE_A, next: STATE_B }],
      })
    );
    expect(result.updated[0]).toMatchObject({ stateHash: STATE_B });
    expect(service.readMain("packages/journal")).toMatchObject({ updatedAt: 1_002 });
  });

  it("accepts manifest: values as well as state: values", async () => {
    const { service } = makeService();
    await service.updateMains(
      update({ entries: [{ repoPath: "packages/r", expectedOld: null, next: MANIFEST_D }] })
    );
    expect(service.readMain("packages/r")?.stateHash).toBe(MANIFEST_D);
  });

  it("rejects a stale CAS with per-entry conflict data and leaves state untouched", async () => {
    const { service } = makeService();
    await service.updateMains(update());

    const stale = update({
      entries: [{ repoPath: "packages/journal", expectedOld: STATE_B, next: STATE_C }],
    });
    await expect(service.updateMains(stale)).rejects.toBeInstanceOf(RefBatchConflictError);
    await service.updateMains(stale).catch((err: RefBatchConflictError) => {
      expect(err.conflicts).toEqual([
        { repoPath: "packages/journal", expectedOld: STATE_B, actual: STATE_A },
      ]);
    });

    expect(service.readMain("packages/journal")?.stateHash).toBe(STATE_A);
  });

  it("conflicts when expectedOld is set but the main is absent", async () => {
    const { service } = makeService();
    await expect(
      service.updateMains(
        update({ entries: [{ repoPath: "packages/journal", expectedOld: STATE_A, next: STATE_B }] })
      )
    ).rejects.toMatchObject({ code: "REF_CONFLICT" });
  });

  it("conflicts when expectedOld is null but the main already exists", async () => {
    const { service } = makeService();
    await service.updateMains(update());
    await expect(
      service.updateMains(
        update({ entries: [{ repoPath: "packages/journal", expectedOld: null, next: STATE_B }] })
      )
    ).rejects.toMatchObject({ code: "REF_CONFLICT" });
  });

  it("listMains returns every repo's main, sorted by repoPath", async () => {
    const { service } = makeService();
    await service.updateMains(
      update({ entries: [{ repoPath: "panels/todo", expectedOld: null, next: STATE_A }] })
    );
    await service.updateMains(
      update({ entries: [{ repoPath: "packages/journal", expectedOld: null, next: STATE_B }] })
    );
    expect(service.listMains().map((r) => r.repoPath)).toEqual(["packages/journal", "panels/todo"]);
  });

  describe("atomic batch", () => {
    it("commits a mixed batch (advance + removal) in one persist", async () => {
      const { service, statePath } = makeService();
      await service.updateMains(
        update({ entries: [{ repoPath: "packages/a", expectedOld: null, next: STATE_A }] })
      );
      await service.updateMains(
        update({ entries: [{ repoPath: "packages/b", expectedOld: null, next: STATE_B }] })
      );

      const result = await service.updateMains(
        update({
          entries: [
            { repoPath: "packages/a", expectedOld: STATE_A, next: STATE_C },
            { repoPath: "packages/b", expectedOld: STATE_B, next: null },
          ],
        })
      );
      expect(result.updated).toEqual([
        { repoPath: "packages/a", stateHash: STATE_C, seq: 3 },
        { repoPath: "packages/b", stateHash: null, seq: 4 },
      ]);
      expect(service.readMain("packages/a")?.stateHash).toBe(STATE_C);
      expect(service.readMain("packages/b")).toBeNull();

      // The whole batch landed in one atomic store — a reload matches.
      const reloaded = makeService({ statePath }).service;
      expect(reloaded.readMain("packages/a")?.stateHash).toBe(STATE_C);
      expect(reloaded.readMain("packages/b")).toBeNull();
    });

    it("one entry's conflict fails the WHOLE batch — no partial persist", async () => {
      const { service } = makeService();
      await service.updateMains(
        update({ entries: [{ repoPath: "packages/a", expectedOld: null, next: STATE_A }] })
      );
      await service.updateMains(
        update({ entries: [{ repoPath: "packages/b", expectedOld: null, next: STATE_B }] })
      );

      await expect(
        service.updateMains(
          update({
            entries: [
              { repoPath: "packages/a", expectedOld: STATE_A, next: STATE_C }, // ok
              { repoPath: "packages/b", expectedOld: STATE_A, next: STATE_C }, // stale → conflict
            ],
          })
        )
      ).rejects.toBeInstanceOf(RefBatchConflictError);

      // NEITHER entry moved (nothing to roll back — nothing was written).
      expect(service.readMain("packages/a")?.stateHash).toBe(STATE_A);
      expect(service.readMain("packages/b")?.stateHash).toBe(STATE_B);
    });

    it("rejects a batch with a duplicate repoPath", async () => {
      const { service } = makeService();
      await expect(
        service.updateMains(
          update({
            entries: [
              { repoPath: "packages/a", expectedOld: null, next: STATE_A },
              { repoPath: "packages/a", expectedOld: null, next: STATE_B },
            ],
          })
        )
      ).rejects.toBeInstanceOf(RefValidationError);
    });
  });

  describe("removal + re-create", () => {
    it("a removal drops the ref and a re-creation is an ordinary expectedOld:null CAS", async () => {
      const { service } = makeService();
      await service.updateMains(
        update({ entries: [{ repoPath: "packages/r", expectedOld: null, next: STATE_A }] })
      );
      await service.updateMains(
        update({ entries: [{ repoPath: "packages/r", expectedOld: STATE_A, next: null }] })
      );
      expect(service.readMain("packages/r")).toBeNull();
      await service.updateMains(
        update({ entries: [{ repoPath: "packages/r", expectedOld: null, next: STATE_B }] })
      );
      expect(service.readMain("packages/r")?.stateHash).toBe(STATE_B);
    });
  });

  describe("content-store validity check", () => {
    it("runs BEFORE the gate and fails closed when a candidate tree is missing", async () => {
      const gateSeen: RefGateBatch[] = [];
      const { service } = makeService({
        gate: async (b) => {
          gateSeen.push(b);
        },
        assertTreeComplete: async (stateHash) => {
          if (stateHash === STATE_B) throw new Error("missing objects");
        },
      });
      await service.updateMains(update()); // STATE_A ok
      await expect(
        service.updateMains(
          update({
            entries: [{ repoPath: "packages/journal", expectedOld: STATE_A, next: STATE_B }],
          })
        )
      ).rejects.toThrow("missing objects");
      // The gate never ran for the invalid batch (validity precedes approval).
      expect(gateSeen).toHaveLength(1);
      expect(service.readMain("packages/journal")?.stateHash).toBe(STATE_A);
    });
  });

  describe("gate", () => {
    it("runs the gate once per batch with resolved old + next per entry (no VCS semantics)", async () => {
      const { service, gateCalls } = makeService();
      await service.updateMains(
        update({ entries: [{ repoPath: "packages/r", expectedOld: null, next: STATE_A }] })
      );
      gateCalls.length = 0;
      await service.updateMains(
        update({ entries: [{ repoPath: "packages/r", expectedOld: STATE_A, next: STATE_B }] })
      );
      expect(gateCalls).toHaveLength(1);
      expect(gateCalls[0]!.entries).toEqual([
        { repoPath: "packages/r", old: STATE_A, next: STATE_B },
      ]);
    });

    it("forwards the opaque gateContext verbatim", async () => {
      const { service, gateCalls } = makeService();
      const gateContext = { kind: "caller", token: "opaque" };
      await service.updateMains(update({ gateContext }));
      expect(gateCalls[0]!.gateContext).toEqual(gateContext);
    });

    it("aborts the batch with no state change when the gate throws", async () => {
      const { service } = makeService({
        gate: async () => {
          throw new Error("denied by user");
        },
      });
      await expect(service.updateMains(update())).rejects.toThrow("denied by user");
      expect(service.readMain("packages/journal")).toBeNull();
    });

    it("does not consult the gate before the CAS check fails", async () => {
      const { service, gateCalls } = makeService();
      await expect(
        service.updateMains(
          update({ entries: [{ repoPath: "packages/r", expectedOld: STATE_B, next: STATE_C }] })
        )
      ).rejects.toMatchObject({ code: "REF_CONFLICT" });
      expect(gateCalls).toEqual([]);
    });

    it("does not block advances to other repos while one gate is pending", async () => {
      let releaseGate!: () => void;
      const blocked = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      const { service } = makeService({
        gate: (batch) =>
          batch.entries[0]!.repoPath === "panels/slow" ? blocked : Promise.resolve(),
      });
      const slow = service.updateMains(
        update({ entries: [{ repoPath: "panels/slow", expectedOld: null, next: STATE_A }] })
      );
      await service.updateMains(
        update({ entries: [{ repoPath: "panels/fast", expectedOld: null, next: STATE_A }] })
      );
      expect(service.readMain("panels/fast")?.stateHash).toBe(STATE_A);
      expect(service.readMain("panels/slow")).toBeNull();
      releaseGate();
      await slow;
      expect(service.readMain("panels/slow")?.stateHash).toBe(STATE_A);
    });
  });

  describe("onRefsChanged (dumb post-commit signal)", () => {
    it("emits only the changed repoPath→stateHash pairs after a successful commit", async () => {
      const { service } = makeService();
      const seen: RefChange[][] = [];
      service.onRefsChanged((changes) => {
        seen.push(changes);
      });
      await service.updateMains(update());
      await service.updateMains(
        update({
          entries: [
            { repoPath: "packages/journal", expectedOld: STATE_A, next: null },
            { repoPath: "panels/todo", expectedOld: null, next: STATE_B },
          ],
        })
      );
      expect(seen).toEqual([
        [{ repoPath: "packages/journal", stateHash: STATE_A }],
        [
          { repoPath: "packages/journal", stateHash: null },
          { repoPath: "panels/todo", stateHash: STATE_B },
        ],
      ]);
    });

    it("does not fire when the batch produced no genuine change (no-op removal)", async () => {
      const { service } = makeService();
      const seen: RefChange[][] = [];
      service.onRefsChanged((changes) => {
        seen.push(changes);
      });
      await service.updateMains(
        update({ entries: [{ repoPath: "packages/absent", expectedOld: null, next: null }] })
      );
      expect(seen).toEqual([]);
    });

    it("a listener failure never fails the committed advance; unsubscribe stops delivery", async () => {
      const { service } = makeService();
      const seen: RefChange[][] = [];
      const unsub = service.onRefsChanged(() => {
        throw new Error("listener boom");
      });
      service.onRefsChanged((changes) => {
        seen.push(changes);
      });
      await expect(service.updateMains(update())).resolves.toBeDefined();
      expect(seen).toHaveLength(1);
      expect(service.readMain("packages/journal")?.stateHash).toBe(STATE_A);

      unsub();
      seen.length = 0;
      await service.updateMains(
        update({ entries: [{ repoPath: "packages/journal", expectedOld: STATE_A, next: STATE_B }] })
      );
      expect(seen).toHaveLength(1); // only the surviving listener fires
    });
  });

  describe("concurrency", () => {
    it("exactly one of N concurrent same-expectedOld advances wins; the rest conflict", async () => {
      const { service } = makeService();
      await service.updateMains(update());
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          service.updateMains(
            update({
              entries: [{ repoPath: "packages/journal", expectedOld: STATE_A, next: STATE_B }],
            })
          )
        )
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results.filter((r) => r.status === "rejected")) {
        expect(isRefConflictError((r as PromiseRejectedResult).reason)).toBe(true);
      }
      expect(service.readMain("packages/journal")).toMatchObject({ stateHash: STATE_B });
    });

    it("concurrent pushes to DISJOINT repos both succeed (serialized per-repo, no cross-repo conflict)", async () => {
      // §10 atomicity: gad's optimistic retry converges — two contexts pushing
      // unrelated repos at once must NOT conflict each other (disjoint repoPath
      // queues never contend). Both advances land.
      const { service } = makeService();
      const [a, b] = await Promise.all([
        service.updateMains(
          update({ entries: [{ repoPath: "packages/a", expectedOld: null, next: STATE_A }] })
        ),
        service.updateMains(
          update({ entries: [{ repoPath: "packages/b", expectedOld: null, next: STATE_B }] })
        ),
      ]);
      expect(a.updated[0]).toMatchObject({ repoPath: "packages/a", stateHash: STATE_A });
      expect(b.updated[0]).toMatchObject({ repoPath: "packages/b", stateHash: STATE_B });
      expect(service.readMain("packages/a")?.stateHash).toBe(STATE_A);
      expect(service.readMain("packages/b")?.stateHash).toBe(STATE_B);
    });
  });

  describe("seedMain", () => {
    it("creates the main when absent through the updateMains path, gated as a system advance", async () => {
      const { service, gateCalls } = makeService();
      const seeded = await service.seedMain({ repoPath: "packages/journal", value: STATE_A });
      expect(seeded.created).toBe(true);
      expect(seeded.record).toMatchObject({ stateHash: STATE_A });
      expect(gateCalls).toHaveLength(1);
      expect(gateCalls[0]).toMatchObject({
        entries: [{ repoPath: "packages/journal", old: null, next: STATE_A }],
        gateContext: { kind: "system" },
      });
    });

    it("is a no-op when the main already exists (never moves it)", async () => {
      const { service } = makeService();
      await service.seedMain({ repoPath: "packages/journal", value: STATE_A });
      const again = await service.seedMain({ repoPath: "packages/journal", value: STATE_B });
      expect(again.created).toBe(false);
      expect(again.record.stateHash).toBe(STATE_A);
    });

    it("validates the seeded value", async () => {
      const { service } = makeService();
      await expect(
        service.seedMain({ repoPath: "packages/journal", value: "state:nothex" })
      ).rejects.toBeInstanceOf(RefValidationError);
    });
  });

  describe("durability", () => {
    it("survives a restart: mains reload identically", async () => {
      const { service, statePath } = makeService();
      await service.updateMains(update());
      await service.updateMains(
        update({ entries: [{ repoPath: "packages/journal", expectedOld: STATE_A, next: STATE_B }] })
      );
      await service.seedMain({ repoPath: "panels/todo", value: STATE_C });

      const reloaded = makeService({ statePath }).service;
      expect(reloaded.listMains()).toEqual(service.listMains());
      // CAS semantics survive the reload.
      await expect(
        reloaded.updateMains(
          update({
            entries: [{ repoPath: "packages/journal", expectedOld: STATE_A, next: STATE_C }],
          })
        )
      ).rejects.toMatchObject({ code: "REF_CONFLICT" });
    });

    it("fails loudly on a corrupt store instead of silently resetting", async () => {
      const { service, statePath } = makeService();
      await service.updateMains(update());
      fs.writeFileSync(path.join(statePath, "refs.json"), "{ not json", "utf8");
      expect(() => makeService({ statePath })).toThrow(/Corrupt ref store/);
    });

    it("leaves no temp files behind after a batch", async () => {
      const { service, statePath } = makeService();
      await service.updateMains(update());
      expect(fs.readdirSync(statePath).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    });
  });

  describe("main-ref movement log (§2)", () => {
    const ON_BEHALF_OF = { runtime: { id: "chat-1", kind: "panel" } };
    const WRITER = "do:workers/gad-store:GadStore:vcs";

    it("records a row per movement with operation/writer/onBehalfOf/reason/old→new/seq", async () => {
      const { service } = makeService();
      await service.updateMains(
        update({
          entries: [{ repoPath: "packages/notes", expectedOld: null, next: STATE_A }],
          operation: "push",
          reason: "initial push",
          writer: WRITER,
          onBehalfOf: ON_BEHALF_OF,
        })
      );
      const rows = service.listMainRefLog("packages/notes");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: 1,
        repoPath: "packages/notes",
        ref: "main",
        operation: "push",
        old: null,
        new: STATE_A,
        writer: WRITER,
        onBehalfOf: ON_BEHALF_OF,
        reason: "initial push",
      });
      expect(typeof rows[0]!.createdAt).toBe("number");
    });

    it("filters by repo and pages movements after sinceId (oldest first)", async () => {
      const { service } = makeService();
      await service.updateMains(
        update({
          entries: [{ repoPath: "packages/a", expectedOld: null, next: STATE_A }],
          operation: "push",
        })
      ); // seq 1
      await service.updateMains(
        update({
          entries: [{ repoPath: "packages/b", expectedOld: null, next: STATE_B }],
          operation: "push",
        })
      ); // seq 2
      await service.updateMains(
        update({
          entries: [{ repoPath: "packages/a", expectedOld: STATE_A, next: STATE_C }],
          operation: "push",
        })
      ); // seq 3
      expect(service.listMainRefLog("packages/a").map((r) => r.id)).toEqual([1, 3]);
      expect(service.listMainRefLog("packages/a", 1).map((r) => r.id)).toEqual([3]);
      expect(service.listMainRefLog("packages/b").map((r) => r.new)).toEqual([STATE_B]);
    });

    it("logs a removal with new:null but records nothing for a no-op removal", async () => {
      const { service } = makeService();
      await service.updateMains(
        update({
          entries: [{ repoPath: "packages/r", expectedOld: null, next: STATE_A }],
          operation: "push",
        })
      ); // seq 1
      await service.updateMains(
        update({
          entries: [{ repoPath: "packages/r", expectedOld: STATE_A, next: null }],
          operation: "delete",
        })
      ); // seq 2
      const result = await service.updateMains(
        update({
          entries: [{ repoPath: "packages/absent", expectedOld: null, next: null }],
          operation: "delete",
        })
      ); // no movement
      expect(result.updated).toEqual([{ repoPath: "packages/absent", stateHash: null, seq: 2 }]);
      expect(service.listMainRefLog("packages/absent")).toEqual([]);
      expect(service.listMainRefLog("packages/r").map((r) => [r.operation, r.old, r.new])).toEqual([
        ["push", null, STATE_A],
        ["delete", STATE_A, null],
      ]);
    });

    it("persists the log across a reload and continues the seq", async () => {
      const { service, statePath } = makeService();
      await service.updateMains(
        update({
          entries: [{ repoPath: "packages/r", expectedOld: null, next: STATE_A }],
          operation: "push",
        })
      ); // seq 1
      const reloaded = makeService({ statePath }).service;
      expect(reloaded.listMainRefLog("packages/r").map((r) => r.id)).toEqual([1]);
      const result = await reloaded.updateMains(
        update({
          entries: [{ repoPath: "packages/r", expectedOld: STATE_A, next: STATE_B }],
          operation: "push",
        })
      );
      expect(result.updated[0]!.seq).toBe(2);
      expect(reloaded.listMainRefLog("packages/r").map((r) => r.id)).toEqual([1, 2]);
    });

    it("logs host-internal seeding as operation 'seed' with a null writer", async () => {
      const { service } = makeService();
      await service.seedMain({ repoPath: "packages/r", value: STATE_A });
      const rows = service.listMainRefLog("packages/r");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ operation: "seed", old: null, new: STATE_A, writer: null });
    });

    it("writes no log row when the batch fails the CAS (nothing persisted)", async () => {
      const { service } = makeService();
      await service.updateMains(
        update({
          entries: [{ repoPath: "packages/r", expectedOld: null, next: STATE_A }],
          operation: "push",
        })
      ); // seq 1
      await expect(
        service.updateMains(
          update({
            entries: [{ repoPath: "packages/r", expectedOld: STATE_B, next: STATE_C }],
            operation: "push",
          })
        )
      ).rejects.toBeInstanceOf(RefBatchConflictError);
      expect(service.listMainRefLog("packages/r").map((r) => r.id)).toEqual([1]);
    });

    it("caps the log at 1000 rows per repo, evicting the oldest and never a quiet repo", async () => {
      const statePath = tempDir();
      const makeRow = (id: number, repoPath: string) => ({
        id,
        repoPath,
        ref: "main",
        operation: "push",
        old: STATE_A,
        new: STATE_B,
        writer: null,
        onBehalfOf: null,
        reason: null,
        createdAt: 1,
      });
      // Seed an at-cap chatty repo (1000 rows) alongside a quiet repo (3 rows).
      const chattyRows = Array.from({ length: 1000 }, (_, i) => makeRow(i + 1, "packages/chatty"));
      const quietRows = [1001, 1002, 1003].map((id) => makeRow(id, "packages/quiet"));
      fs.writeFileSync(
        path.join(statePath, "refs.json"),
        JSON.stringify({
          version: 3,
          mains: [
            { repoPath: "packages/chatty", stateHash: STATE_A, updatedAt: 1 },
            { repoPath: "packages/quiet", stateHash: STATE_B, updatedAt: 1 },
          ],
          log: [...chattyRows, ...quietRows],
          seq: 1003,
        })
      );

      const { service } = makeService({ statePath });
      expect(service.listMainRefLog("packages/chatty")).toHaveLength(1000);

      // One more movement on the chatty repo tips it past the cap.
      const result = await service.updateMains(
        update({
          entries: [{ repoPath: "packages/chatty", expectedOld: STATE_A, next: STATE_C }],
          operation: "push",
        })
      );
      // seq keeps advancing monotonically regardless of pruning.
      expect(result.updated[0]!.seq).toBe(1004);

      const chatty = service.listMainRefLog("packages/chatty");
      expect(chatty).toHaveLength(1000);
      expect(chatty[0]!.id).toBe(2); // the oldest overflow row (id 1) was evicted
      expect(chatty[chatty.length - 1]!.id).toBe(1004); // the new movement is kept
      // The quiet repo's history is untouched by the chatty repo's overflow.
      expect(service.listMainRefLog("packages/quiet").map((r) => r.id)).toEqual([1001, 1002, 1003]);

      // The cap was persisted (not just an in-memory view): a reload sees it too.
      const reloaded = makeService({ statePath }).service;
      expect(reloaded.listMainRefLog("packages/chatty")).toHaveLength(1000);
      expect(reloaded.listMainRefLog("packages/chatty")[0]!.id).toBe(2);
      expect(reloaded.listMainRefLog("packages/quiet").map((r) => r.id)).toEqual([
        1001, 1002, 1003,
      ]);
    });
  });

  describe("validation", () => {
    it("accepts only taxonomy-valid repo ids", async () => {
      const { service } = makeService();
      await service.updateMains(
        update({ entries: [{ repoPath: "meta", expectedOld: null, next: STATE_A }] })
      );
      await service.updateMains(
        update({ entries: [{ repoPath: "projects/vault", expectedOld: null, next: STATE_B }] })
      );
      expect(service.readMain("meta")?.stateHash).toBe(STATE_A);
      expect(service.readMain("projects/vault")?.stateHash).toBe(STATE_B);
    });

    const badNames = [
      "",
      "..",
      "../evil",
      "a//b",
      "/leading",
      "trailing/",
      "has space",
      "packages",
      "panels",
      "agents/foo",
      "src",
      "packages/foo/bar",
      "packages\\foo",
      "x".repeat(257),
    ];
    it.each(badNames.map((n) => [JSON.stringify(n), n]))(
      "rejects malformed repoPath %s",
      async (_l, repoPath) => {
        const { service } = makeService();
        await expect(
          service.updateMains(update({ entries: [{ repoPath, expectedOld: null, next: STATE_A }] }))
        ).rejects.toBeInstanceOf(RefValidationError);
        expect(() => service.readMain(repoPath)).toThrow(RefValidationError);
      }
    );

    const badValues = ["", "abc123", "state:", `state:${"A".repeat(64)}`, `blob:${"a".repeat(64)}`];
    it.each(badValues.map((v) => [JSON.stringify(v), v]))(
      "rejects non-state/manifest next %s",
      async (_l, next) => {
        const { service } = makeService();
        await expect(
          service.updateMains(
            update({ entries: [{ repoPath: "packages/r", expectedOld: null, next }] })
          )
        ).rejects.toBeInstanceOf(RefValidationError);
      }
    );

    it("rejects an empty batch", async () => {
      const { service } = makeService();
      await expect(service.updateMains(update({ entries: [] }))).rejects.toBeInstanceOf(
        RefValidationError
      );
    });
  });
});
