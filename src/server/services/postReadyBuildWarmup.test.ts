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
      // A failed launcher build must not skip the Quickfire agent behind it.
      "workers/agent-worker",
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
    const stopping = warmup.stop();
    launcher.resolve();
    await Promise.all([running, stopping]);

    expect(getBuild).not.toHaveBeenCalled();
  });

  it("does not finish stopping while the admitted speculative build is active", async () => {
    const launcher = deferred();
    const warmup = createPostReadyBuildWarmup({
      buildSystem: {
        bindRuntimeImage: vi.fn(async () => {
          await launcher.promise;
          return {} as never;
        }),
        getBuild: vi.fn(async () => ({}) as never),
      },
      log: { log: vi.fn(), warn: vi.fn() },
    });

    void warmup.start();
    let stopped = false;
    const stopping = warmup.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    launcher.resolve();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("keeps the bounded queue moving when one speculative build fails", async () => {
    const calls: string[] = [];
    const warn = vi.fn();
    const warmup = createPostReadyBuildWarmup({
      buildSystem: {
        bindRuntimeImage: vi.fn(async (source: string) => {
          calls.push(source);
          throw new Error(`${source} build failed`);
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
      // A failed launcher build must not skip the units queued behind it.
      "workers/agent-worker",
      "packages/eval",
      "packages/runtime/hosted",
      "packages/runtime/panel-runtime",
      "packages/runtime/portable",
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("about/new build failed"));
  });

  it("warms only the launcher for ephemeral workspaces", async () => {
    const bindRuntimeImage = vi.fn(async (_source: string) => ({}) as never);
    const getBuild = vi.fn(async () => ({}) as never);
    const warmup = createPostReadyBuildWarmup({
      buildSystem: { bindRuntimeImage, getBuild },
      evalEngineSource: "packages/eval",
      evalRuntimeSource: "packages/runtime",
      log: { log: vi.fn(), warn: vi.fn() },
    });

    await warmup.start();

    // The two units a user can reach from anywhere without opening anything:
    // the launcher, and the Quickfire agent one keystroke behind the overlay.
    expect(bindRuntimeImage.mock.calls.map(([source]) => source)).toEqual([
      "about/new",
      "workers/agent-worker",
    ]);
    expect(getBuild).not.toHaveBeenCalled();
  });
});
