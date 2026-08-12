import { describe, expect, it, vi } from "vitest";
import { createPostReadyBuildWarmup } from "./postReadyBuildWarmup.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("post-ready build warmup", () => {
  it("warms the New Panel launcher before sequential eval libraries", async () => {
    const calls: string[] = [];
    const warmup = createPostReadyBuildWarmup({
      buildSystem: {
        bindRuntimeImage: vi.fn(async (source: string) => {
          calls.push(source);
          return {} as never;
        }),
        getBuild: vi.fn(async (source: string) => {
          calls.push(source);
          return {} as never;
        }),
      },
      evalEngineSource: "packages/eval",
      evalRuntimeSource: "packages/runtime",
      log: { log: vi.fn(), warn: vi.fn() },
    });

    const first = warmup.start({ includeEvalLibraries: true });
    expect(warmup.start({ includeEvalLibraries: true })).toBe(first);
    await first;

    expect(calls).toEqual([
      "about/new",
      "packages/eval",
      "packages/runtime/hosted",
      "packages/runtime/panel-runtime",
      "packages/runtime/portable",
    ]);
  });

  it("stops admitting speculative eval builds after cancellation", async () => {
    const launcher = deferred();
    const getBuild = vi.fn(async () => ({}) as never);
    const warmup = createPostReadyBuildWarmup({
      buildSystem: {
        bindRuntimeImage: vi.fn(async () => {
          await launcher.promise;
          return {} as never;
        }),
        getBuild,
      },
      evalEngineSource: "packages/eval",
      evalRuntimeSource: "packages/runtime",
      log: { log: vi.fn(), warn: vi.fn() },
    });

    const running = warmup.start({ includeEvalLibraries: true });
    warmup.cancel();
    launcher.resolve();
    await running;

    expect(getBuild).not.toHaveBeenCalled();
  });

  it("keeps the bounded queue moving when one speculative build fails", async () => {
    const calls: string[] = [];
    const warn = vi.fn();
    const warmup = createPostReadyBuildWarmup({
      buildSystem: {
        bindRuntimeImage: vi.fn(async () => {
          calls.push("about/new");
          throw new Error("launcher build failed");
        }),
        getBuild: vi.fn(async (source: string) => {
          calls.push(source);
          return {} as never;
        }),
      },
      evalEngineSource: "packages/eval",
      evalRuntimeSource: "packages/runtime",
      log: { log: vi.fn(), warn },
    });

    await warmup.start({ includeEvalLibraries: true });

    expect(calls).toEqual([
      "about/new",
      "packages/eval",
      "packages/runtime/hosted",
      "packages/runtime/panel-runtime",
      "packages/runtime/portable",
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("launcher build failed"));
  });

  it("warms only the launcher for ephemeral workspaces", async () => {
    const bindRuntimeImage = vi.fn(async () => ({}) as never);
    const getBuild = vi.fn(async () => ({}) as never);
    const warmup = createPostReadyBuildWarmup({
      buildSystem: { bindRuntimeImage, getBuild },
      evalEngineSource: "packages/eval",
      evalRuntimeSource: "packages/runtime",
      log: { log: vi.fn(), warn: vi.fn() },
    });

    await warmup.start();

    expect(bindRuntimeImage).toHaveBeenCalledWith("about/new");
    expect(getBuild).not.toHaveBeenCalled();
  });
});
