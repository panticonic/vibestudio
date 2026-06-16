import { describe, it, expect, vi } from "vitest";
import { PublishController, type PublishVcs } from "./publishController.js";

function fakeVcs(overrides: Partial<PublishVcs> = {}): PublishVcs {
  return {
    publishStatus: vi.fn(async () => ({ ahead: 0, files: [] })),
    merge: vi.fn(async () => ({ status: "merged" as const, conflicts: [] })),
    publish: vi.fn(async () => ({ status: "merged" as const, conflicts: [] })),
    pendingMerge: vi.fn(async () => null),
    abortMerge: vi.fn(async () => ({ aborted: true })),
    ...overrides,
  };
}

describe("PublishController", () => {
  it("refresh reports the unpublished count + files", async () => {
    const vcs = fakeVcs({
      publishStatus: vi.fn(async () => ({
        ahead: 2,
        files: [
          { path: "A.mdx", kind: "changed" as const },
          { path: "B.mdx", kind: "added" as const },
        ],
      })),
    });
    const c = new PublishController(vcs);
    await c.refresh();
    expect(c.getSnapshot().ahead).toBe(2);
    expect(c.getSnapshot().files).toHaveLength(2);
  });

  it("publish pulls main then publishes ctx→main (clean fast-forward)", async () => {
    const vcs = fakeVcs();
    const c = new PublishController(vcs);
    const outcome = await c.publish();
    expect(vcs.merge).toHaveBeenCalledWith("main");
    expect(vcs.publish).toHaveBeenCalled();
    expect(outcome).toEqual({ status: "published" });
    expect(c.getSnapshot().publishing).toBe(false);
  });

  it("a conflicting pull surfaces a pending merge in the panel's own head — publish is NOT called", async () => {
    const vcs = fakeVcs({
      merge: vi.fn(async () => ({
        status: "conflicted" as const,
        conflicts: [{ path: "A.mdx", kind: "content" }],
      })),
      pendingMerge: vi.fn(async () => ({
        theirsHead: "main",
        conflicts: [{ path: "A.mdx", kind: "content" }],
      })),
    });
    const c = new PublishController(vcs);
    const outcome = await c.publish();
    expect(outcome).toEqual({ status: "needs-resolve" });
    expect(vcs.publish).not.toHaveBeenCalled();
    expect(c.getSnapshot().pending).toMatchObject({ theirsHead: "main" });
  });

  it("up-to-date publish reports up-to-date", async () => {
    const vcs = fakeVcs({
      merge: vi.fn(async () => ({ status: "up-to-date" as const, conflicts: [] })),
      publish: vi.fn(async () => ({ status: "up-to-date" as const, conflicts: [] })),
    });
    const c = new PublishController(vcs);
    expect(await c.publish()).toEqual({ status: "up-to-date" });
  });

  it("abort clears the pending merge and refreshes", async () => {
    const vcs = fakeVcs({
      pendingMerge: vi.fn(async () => null),
    });
    const c = new PublishController(vcs);
    await c.abort();
    expect(vcs.abortMerge).toHaveBeenCalled();
    expect(c.getSnapshot().pending).toBeNull();
  });

  it("notifies subscribers on change", async () => {
    const c = new PublishController(fakeVcs());
    const listener = vi.fn();
    const off = c.subscribe(listener);
    await c.refresh();
    expect(listener).toHaveBeenCalled();
    off();
  });

  it("surfaces errors without throwing", async () => {
    const vcs = fakeVcs({
      merge: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const c = new PublishController(vcs);
    const outcome = await c.publish();
    expect(outcome).toEqual({ status: "error", message: "boom" });
    expect(c.getSnapshot().lastError).toBe("boom");
    expect(c.getSnapshot().publishing).toBe(false);
  });
});
