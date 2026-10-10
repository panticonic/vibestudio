import { describe, expect, it, vi } from "vitest";
import type { BuildSystemV2 } from "./buildV2/index.js";
import type { GraphNode } from "./buildV2/packageGraph.js";
import { prepareWorkspaceRuntimeBuilds } from "./workspaceTemplateBuilds.js";

type Binding = Awaited<ReturnType<BuildSystemV2["getBuild"]>>;
function node(relativePath: string): GraphNode {
  return { relativePath, kind: "worker", manifest: {} } as GraphNode;
}
function binding(buildKey: string): Binding {
  return { buildKey } as Binding;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("prepareWorkspaceRuntimeBuilds", () => {
  it("admits independent builds together and publishes in completion order with stable receipts", async () => {
    const first = deferred<Binding>();
    const second = deferred<Binding>();
    const build = vi.fn((source: string) =>
      source === "workers/first" ? first.promise : second.promise
    );
    const publish = vi.fn(async () => undefined);
    const result = prepareWorkspaceRuntimeBuilds(
      [node("workers/first"), node("workers/second")],
      build,
      publish
    );
    expect(build.mock.calls).toEqual([["workers/first"], ["workers/second"]]);
    second.resolve(binding("second"));
    await Promise.resolve();
    expect(publish).toHaveBeenCalledWith(binding("second"));
    first.resolve(binding("first"));
    expect(await result).toEqual([
      { source: "workers/first", binding: binding("first") },
      { source: "workers/second", binding: binding("second") },
    ]);
  });

  it("joins admitted exports before propagating a build failure", async () => {
    const exportFinished = deferred<void>();
    const failure = new Error("compile failed");
    const build = vi.fn(async (source: string) => {
      if (source === "workers/first") throw failure;
      return binding("second");
    });
    const result = prepareWorkspaceRuntimeBuilds(
      [node("workers/first"), node("workers/second")],
      build,
      () => exportFinished.promise
    );
    let settled = false;
    void result.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    exportFinished.resolve();
    await expect(result).rejects.toBe(failure);
  });

  it("joins admitted builds when cancelled without publishing their results", async () => {
    const work = deferred<Binding>();
    const abort = new AbortController();
    const reason = new Error("cancelled");
    const publish = vi.fn(async () => undefined);
    const result = prepareWorkspaceRuntimeBuilds(
      [node("workers/first")],
      () => work.promise,
      publish,
      abort.signal
    );
    abort.abort(reason);
    let settled = false;
    void result.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    work.resolve(binding("first"));
    await expect(result).rejects.toBe(reason);
    expect(publish).not.toHaveBeenCalled();
  });
});
