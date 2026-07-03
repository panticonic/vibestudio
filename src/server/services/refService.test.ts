import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";
import {
  createRefService,
  isRefConflictError,
  RefBatchConflictError,
  RefValidationError,
  type RefChange,
  type RefGate,
  type RefGateBatch,
  type UpdateMainsInput,
} from "./refService.js";

const STATE_A = `state:${"a".repeat(64)}`;
const STATE_B = `state:${"b".repeat(64)}`;
const STATE_C = `state:${"c".repeat(64)}`;
const MANIFEST_D = `manifest:${"d".repeat(64)}`;

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibez1-ref-service-"));
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
  const service = createRefService({
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
    entries: [{ repoPath: "notes/journal", expectedOld: null, next: STATE_A }],
    ...overrides,
  };
}

describe("refService.updateMains", () => {
  it("creates a main via expectedOld:null CAS and reads it back", async () => {
    const { service } = makeService();
    expect(service.readMain("notes/journal")).toBeNull();

    const result = await service.updateMains(update());
    expect(result.updated).toEqual([{ repoPath: "notes/journal", stateHash: STATE_A }]);
    expect(service.readMain("notes/journal")).toEqual({
      repoPath: "notes/journal",
      stateHash: STATE_A,
      updatedAt: 1_001,
    });
  });

  it("advances with matching expectedOld, using the injected clock", async () => {
    const { service } = makeService();
    await service.updateMains(update());
    const result = await service.updateMains(
      update({
        entries: [{ repoPath: "notes/journal", expectedOld: STATE_A, next: STATE_B }],
      })
    );
    expect(result.updated[0]).toMatchObject({ stateHash: STATE_B });
    expect(service.readMain("notes/journal")).toMatchObject({ updatedAt: 1_002 });
  });

  it("accepts manifest: values as well as state: values", async () => {
    const { service } = makeService();
    await service.updateMains(
      update({ entries: [{ repoPath: "r", expectedOld: null, next: MANIFEST_D }] })
    );
    expect(service.readMain("r")?.stateHash).toBe(MANIFEST_D);
  });

  it("rejects a stale CAS with per-entry conflict data and leaves state untouched", async () => {
    const { service } = makeService();
    await service.updateMains(update());

    const stale = update({
      entries: [{ repoPath: "notes/journal", expectedOld: STATE_B, next: STATE_C }],
    });
    await expect(service.updateMains(stale)).rejects.toBeInstanceOf(RefBatchConflictError);
    await service.updateMains(stale).catch((err: RefBatchConflictError) => {
      expect(err.conflicts).toEqual([
        { repoPath: "notes/journal", expectedOld: STATE_B, actual: STATE_A },
      ]);
    });

    expect(service.readMain("notes/journal")?.stateHash).toBe(STATE_A);
  });

  it("conflicts when expectedOld is set but the main is absent", async () => {
    const { service } = makeService();
    await expect(
      service.updateMains(
        update({ entries: [{ repoPath: "notes/journal", expectedOld: STATE_A, next: STATE_B }] })
      )
    ).rejects.toMatchObject({ code: "REF_CONFLICT" });
  });

  it("conflicts when expectedOld is null but the main already exists", async () => {
    const { service } = makeService();
    await service.updateMains(update());
    await expect(
      service.updateMains(
        update({ entries: [{ repoPath: "notes/journal", expectedOld: null, next: STATE_B }] })
      )
    ).rejects.toMatchObject({ code: "REF_CONFLICT" });
  });

  it("listMains returns every repo's main, sorted by repoPath", async () => {
    const { service } = makeService();
    await service.updateMains(
      update({ entries: [{ repoPath: "panels/todo", expectedOld: null, next: STATE_A }] })
    );
    await service.updateMains(
      update({ entries: [{ repoPath: "notes/journal", expectedOld: null, next: STATE_B }] })
    );
    expect(service.listMains().map((r) => r.repoPath)).toEqual(["notes/journal", "panels/todo"]);
  });

  describe("atomic batch", () => {
    it("commits a mixed batch (advance + removal) in one persist", async () => {
      const { service, statePath } = makeService();
      await service.updateMains(
        update({ entries: [{ repoPath: "a", expectedOld: null, next: STATE_A }] })
      );
      await service.updateMains(
        update({ entries: [{ repoPath: "b", expectedOld: null, next: STATE_B }] })
      );

      const result = await service.updateMains(
        update({
          entries: [
            { repoPath: "a", expectedOld: STATE_A, next: STATE_C },
            { repoPath: "b", expectedOld: STATE_B, next: null },
          ],
        })
      );
      expect(result.updated).toEqual([
        { repoPath: "a", stateHash: STATE_C },
        { repoPath: "b", stateHash: null },
      ]);
      expect(service.readMain("a")?.stateHash).toBe(STATE_C);
      expect(service.readMain("b")).toBeNull();

      // The whole batch landed in one atomic store — a reload matches.
      const reloaded = makeService({ statePath }).service;
      expect(reloaded.readMain("a")?.stateHash).toBe(STATE_C);
      expect(reloaded.readMain("b")).toBeNull();
    });

    it("one entry's conflict fails the WHOLE batch — no partial persist", async () => {
      const { service } = makeService();
      await service.updateMains(
        update({ entries: [{ repoPath: "a", expectedOld: null, next: STATE_A }] })
      );
      await service.updateMains(
        update({ entries: [{ repoPath: "b", expectedOld: null, next: STATE_B }] })
      );

      await expect(
        service.updateMains(
          update({
            entries: [
              { repoPath: "a", expectedOld: STATE_A, next: STATE_C }, // ok
              { repoPath: "b", expectedOld: STATE_A, next: STATE_C }, // stale → conflict
            ],
          })
        )
      ).rejects.toBeInstanceOf(RefBatchConflictError);

      // NEITHER entry moved (nothing to roll back — nothing was written).
      expect(service.readMain("a")?.stateHash).toBe(STATE_A);
      expect(service.readMain("b")?.stateHash).toBe(STATE_B);
    });

    it("rejects a batch with a duplicate repoPath", async () => {
      const { service } = makeService();
      await expect(
        service.updateMains(
          update({
            entries: [
              { repoPath: "a", expectedOld: null, next: STATE_A },
              { repoPath: "a", expectedOld: null, next: STATE_B },
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
        update({ entries: [{ repoPath: "r", expectedOld: null, next: STATE_A }] })
      );
      await service.updateMains(
        update({ entries: [{ repoPath: "r", expectedOld: STATE_A, next: null }] })
      );
      expect(service.readMain("r")).toBeNull();
      await service.updateMains(
        update({ entries: [{ repoPath: "r", expectedOld: null, next: STATE_B }] })
      );
      expect(service.readMain("r")?.stateHash).toBe(STATE_B);
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
          update({ entries: [{ repoPath: "notes/journal", expectedOld: STATE_A, next: STATE_B }] })
        )
      ).rejects.toThrow("missing objects");
      // The gate never ran for the invalid batch (validity precedes approval).
      expect(gateSeen).toHaveLength(1);
      expect(service.readMain("notes/journal")?.stateHash).toBe(STATE_A);
    });
  });

  describe("gate", () => {
    it("runs the gate once per batch with resolved old + next per entry (no VCS semantics)", async () => {
      const { service, gateCalls } = makeService();
      await service.updateMains(
        update({ entries: [{ repoPath: "r", expectedOld: null, next: STATE_A }] })
      );
      gateCalls.length = 0;
      await service.updateMains(
        update({ entries: [{ repoPath: "r", expectedOld: STATE_A, next: STATE_B }] })
      );
      expect(gateCalls).toHaveLength(1);
      expect(gateCalls[0]!.entries).toEqual([{ repoPath: "r", old: STATE_A, next: STATE_B }]);
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
      expect(service.readMain("notes/journal")).toBeNull();
    });

    it("does not consult the gate before the CAS check fails", async () => {
      const { service, gateCalls } = makeService();
      await expect(
        service.updateMains(
          update({ entries: [{ repoPath: "r", expectedOld: STATE_B, next: STATE_C }] })
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
            { repoPath: "notes/journal", expectedOld: STATE_A, next: null },
            { repoPath: "panels/todo", expectedOld: null, next: STATE_B },
          ],
        })
      );
      expect(seen).toEqual([
        [{ repoPath: "notes/journal", stateHash: STATE_A }],
        [
          { repoPath: "notes/journal", stateHash: null },
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
        update({ entries: [{ repoPath: "absent", expectedOld: null, next: null }] })
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
      expect(service.readMain("notes/journal")?.stateHash).toBe(STATE_A);

      unsub();
      seen.length = 0;
      await service.updateMains(
        update({ entries: [{ repoPath: "notes/journal", expectedOld: STATE_A, next: STATE_B }] })
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
              entries: [{ repoPath: "notes/journal", expectedOld: STATE_A, next: STATE_B }],
            })
          )
        )
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results.filter((r) => r.status === "rejected")) {
        expect(isRefConflictError((r as PromiseRejectedResult).reason)).toBe(true);
      }
      expect(service.readMain("notes/journal")).toMatchObject({ stateHash: STATE_B });
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
      const seeded = await service.seedMain({ repoPath: "notes/journal", value: STATE_A });
      expect(seeded.created).toBe(true);
      expect(seeded.record).toMatchObject({ stateHash: STATE_A });
      expect(gateCalls).toHaveLength(1);
      expect(gateCalls[0]).toMatchObject({
        entries: [{ repoPath: "notes/journal", old: null, next: STATE_A }],
        gateContext: { kind: "system" },
      });
    });

    it("is a no-op when the main already exists (never moves it)", async () => {
      const { service } = makeService();
      await service.seedMain({ repoPath: "notes/journal", value: STATE_A });
      const again = await service.seedMain({ repoPath: "notes/journal", value: STATE_B });
      expect(again.created).toBe(false);
      expect(again.record.stateHash).toBe(STATE_A);
    });

    it("validates the seeded value", async () => {
      const { service } = makeService();
      await expect(
        service.seedMain({ repoPath: "notes/journal", value: "state:nothex" })
      ).rejects.toBeInstanceOf(RefValidationError);
    });
  });

  describe("durability", () => {
    it("survives a restart: mains reload identically", async () => {
      const { service, statePath } = makeService();
      await service.updateMains(update());
      await service.updateMains(
        update({ entries: [{ repoPath: "notes/journal", expectedOld: STATE_A, next: STATE_B }] })
      );
      await service.seedMain({ repoPath: "panels/todo", value: STATE_C });

      const reloaded = makeService({ statePath }).service;
      expect(reloaded.listMains()).toEqual(service.listMains());
      // CAS semantics survive the reload.
      await expect(
        reloaded.updateMains(
          update({ entries: [{ repoPath: "notes/journal", expectedOld: STATE_A, next: STATE_C }] })
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

  describe("validation", () => {
    const badNames = [
      "",
      "..",
      "../evil",
      "a//b",
      "/leading",
      "trailing/",
      "has space",
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
          service.updateMains(update({ entries: [{ repoPath: "r", expectedOld: null, next }] }))
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
