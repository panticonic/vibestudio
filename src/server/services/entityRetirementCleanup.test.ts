import { describe, expect, it, vi } from "vitest";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import { createEntityRetirementCleanup } from "./entityRetirementCleanup.js";

const old: EntityRecord = {
  id: "do:workers/test:Agent:one",
  kind: "do",
  source: { repoPath: "workers/test", effectiveVersion: "one" },
  contextId: "ctx-one",
  className: "Agent",
  key: "one",
  createdAt: 1,
  status: "retired",
  cleanupComplete: false,
  authoritySessionId: "old-lifetime",
};
function fixture() {
  let current: EntityRecord | null = { ...old };
  const cleanup = vi.fn(async (_record: EntityRecord) => {});
  const complete = vi.fn(async (id: string, lifetime: string) => {
    if (
      current?.id === id &&
      current.status === "retired" &&
      current.authoritySessionId === lifetime
    )
      current = { ...current, cleanupComplete: true };
  });
  const resolveRecord = vi.fn(async (_id: string) => current);
  const owner = createEntityRetirementCleanup({ resolveRecord, cleanup, complete });
  return {
    owner,
    cleanup,
    complete,
    resolveRecord,
    get current() {
      return current;
    },
    set current(value) {
      current = value;
    },
  };
}

describe("canonical entity retirement cleanup ownership", () => {
  it("deduplicates runtime and reaper work and completes the exact lifetime only after all resource cleanup", async () => {
    const f = fixture();
    let release!: () => void;
    f.cleanup.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const first = f.owner.retire(old);
    const second = f.owner.retire({ ...old });
    expect(second).toBe(first);
    await vi.waitFor(() => expect(f.cleanup).toHaveBeenCalledOnce());
    expect(f.current?.cleanupComplete).toBe(false);
    expect(f.complete).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    expect(f.complete).toHaveBeenCalledExactlyOnceWith(old.id, "old-lifetime");
    expect(f.current?.cleanupComplete).toBe(true);
    await f.owner.retire(old);
    expect(f.cleanup).toHaveBeenCalledOnce();
    await f.owner.quiesce();
  });

  it.each(["active", "later-retired", "complete", "deleted"])(
    "rereads canonical %s state before any old-lifetime resource mutation",
    async (state) => {
      const f = fixture();
      const retirement = f.owner.retire(old);
      f.current =
        state === "deleted"
          ? null
          : {
              ...old,
              ...(state === "active"
                ? { status: "active" as const, authoritySessionId: "new-lifetime" }
                : {}),
              ...(state === "later-retired" ? { authoritySessionId: "new-lifetime" } : {}),
              ...(state === "complete" ? { cleanupComplete: true } : {}),
            };
      await retirement;
      expect(f.cleanup).not.toHaveBeenCalled();
      expect(f.complete).not.toHaveBeenCalled();
      await f.owner.quiesce();
    }
  );

  it("preserves original resource failure and incomplete ownership for an explicit retry", async () => {
    const f = fixture();
    const failure = new Error("credential revocation refused");
    f.cleanup.mockRejectedValueOnce(failure);
    await expect(f.owner.retire(old)).rejects.toBe(failure);
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.current?.cleanupComplete).toBe(false);
    await f.owner.retire(old);
    expect(f.cleanup).toHaveBeenCalledTimes(2);
    expect(f.current?.cleanupComplete).toBe(true);
    await f.owner.quiesce();
  });

  it("preserves original completion failure and retries idempotent resource cleanup", async () => {
    const f = fixture();
    const failure = new Error("completion SQL refused");
    f.complete.mockRejectedValueOnce(failure);
    await expect(f.owner.retire(old)).rejects.toBe(failure);
    expect(f.current?.cleanupComplete).toBe(false);
    await f.owner.retire(old);
    expect(f.current?.cleanupComplete).toBe(true);
    await f.owner.quiesce();
  });

  it("serializes later lifetime cleanup and prevents a late old reaper from repeating new-ID teardown", async () => {
    const f = fixture();
    const next = { ...old, authoritySessionId: "new-lifetime" };
    let release!: () => void;
    f.cleanup.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const first = f.owner.retire(old);
    await vi.waitFor(() => expect(f.cleanup).toHaveBeenCalledOnce());
    const second = f.owner.retire(next);
    expect(f.resolveRecord).toHaveBeenCalledOnce();
    release();
    await first;
    f.current = next;
    await second;
    expect(f.cleanup.mock.calls.map(([record]) => record.authoritySessionId)).toEqual([
      "old-lifetime",
      "new-lifetime",
    ]);
    await f.owner.retire(old);
    expect(f.cleanup).toHaveBeenCalledTimes(2);
    await f.owner.quiesce();
  });

  it("joins owned teardown before shutdown and rejects new cleanup admission", async () => {
    const f = fixture();
    let release!: () => void;
    f.cleanup.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const retirement = f.owner.retire(old);
    await vi.waitFor(() => expect(f.cleanup).toHaveBeenCalledOnce());
    let joined = false;
    const shutdown = f.owner.quiesce().then(() => {
      joined = true;
    });
    await expect(f.owner.retire({ ...old, id: "do:other" })).rejects.toThrow("cleanup stopped");
    expect(joined).toBe(false);
    release();
    await Promise.all([retirement, shutdown]);
    expect(f.current?.cleanupComplete).toBe(true);
  });
});
