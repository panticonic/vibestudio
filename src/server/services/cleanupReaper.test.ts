import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCleanupReaper } from "./cleanupReaper.js";
import type { DODispatch } from "../doDispatch.js";
import type { DORef } from "@vibestudio/shared/doDispatcher";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";

function makeRecord(id: string): EntityRecord {
  return {
    id,
    kind: "panel",
    source: { repoPath: "panels/test", effectiveVersion: "v1" },
    contextId: "ctx-1",
    key: id,
    createdAt: 1,
    authoritySessionId: "lifetime-one",
    status: "retired",
    retiredAt: 2,
    cleanupComplete: false,
  };
}

const workspaceDORef: DORef = {
  source: "vibestudio/internal",
  className: "WorkspaceDO",
  objectKey: "workspace-main",
};

describe("cleanupReaper.sweep", () => {
  let cleanupCalls: string[];
  let dispatchCalls: Array<{ method: string; args: unknown[] }>;

  beforeEach(() => {
    cleanupCalls = [];
    dispatchCalls = [];
  });

  it("delegates each row to the shared completion owner without a second completion write", async () => {
    const incomplete = [makeRecord("panel:a"), makeRecord("panel:b")];
    const doDispatch = {
      dispatch: vi.fn(async (_ref: DORef, method: string, ...args: unknown[]) => {
        dispatchCalls.push({ method, args });
        if (method === "entityFindIncompleteCleanups") return incomplete;
        return undefined;
      }),
    } as unknown as DODispatch;

    const reaper = createCleanupReaper({
      doDispatch,
      workspaceDORef,
      onRetire: async (rec) => {
        cleanupCalls.push(rec.id);
      },
    });
    const processed = await reaper.sweep();
    expect(processed).toBe(2);
    expect(cleanupCalls).toEqual(["panel:a", "panel:b"]);
    const completes = dispatchCalls.filter((c) => c.method === "entityCleanupComplete");
    expect(completes).toEqual([]);
  });

  it("leaves cleanup_complete=0 and logs warn when the hook fails", async () => {
    const incomplete = [makeRecord("panel:fail")];
    const warn = vi.fn();
    const doDispatch = {
      dispatch: vi.fn(async (_ref: DORef, method: string, ..._args: unknown[]) => {
        dispatchCalls.push({ method, args: _args });
        if (method === "entityFindIncompleteCleanups") return incomplete;
        return undefined;
      }),
    } as unknown as DODispatch;

    const reaper = createCleanupReaper({
      doDispatch,
      workspaceDORef,
      onRetire: async () => {
        throw new Error("hook boom");
      },
      logger: { warn },
    });
    const processed = await reaper.sweep();
    expect(processed).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("panel:fail");
    expect(dispatchCalls.some((c) => c.method === "entityCleanupComplete")).toBe(false);
  });

  it("skips overlapping sweeps", async () => {
    const incomplete = [makeRecord("panel:slow")];
    let resolveHook: () => void = () => {};
    const doDispatch = {
      dispatch: vi.fn(async (_ref: DORef, method: string, ..._args: unknown[]) => {
        if (method === "entityFindIncompleteCleanups") return incomplete;
        return undefined;
      }),
    } as unknown as DODispatch;
    const reaper = createCleanupReaper({
      doDispatch,
      workspaceDORef,
      onRetire: () =>
        new Promise<void>((res) => {
          resolveHook = res;
        }),
    });
    const first = reaper.sweep();
    // While the first sweep is mid-flight, a second call should bail out.
    const second = await reaper.sweep();
    expect(second).toBe(0);
    resolveHook();
    await first;
  });
  it("stops scheduling and joins the exact admitted cleanup sweep", async () => {
    const pending = makeRecord("panel:joining");
    let release!: () => void;
    const onRetire = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const reaper = createCleanupReaper({
      doDispatch: { dispatch: vi.fn(async () => [pending]) } as unknown as DODispatch,
      workspaceDORef,
      onRetire,
    });
    const sweep = reaper.sweep();
    await vi.waitFor(() => expect(onRetire).toHaveBeenCalledOnce());
    let joined = false;
    const stop = reaper.stop().then(() => {
      joined = true;
    });
    expect(joined).toBe(false);
    release();
    await Promise.all([sweep, stop]);
    expect(joined).toBe(true);
  });

  it("joins a failed query and propagates its original failure to the shutdown owner", async () => {
    let reject!: (error: Error) => void;
    const query = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    const reaper = createCleanupReaper({
      doDispatch: { dispatch: vi.fn(() => query) } as unknown as DODispatch,
      workspaceDORef,
      onRetire: vi.fn(),
    });
    const sweepResult = reaper.sweep().catch((error) => error);
    const stopResult = reaper.stop().catch((error) => error);
    const failure = new Error("WorkspaceDO disconnected");
    reject(failure);
    expect(await sweepResult).toBe(failure);
    expect(await stopResult).toBe(failure);
    await reaper.stop();
  });
});
