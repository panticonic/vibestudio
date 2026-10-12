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

  it("preserves independent build and publication failures", async () => {
    const compilation = new Error("compile failed");
    const publication = new Error("publish failed");
    const result = prepareWorkspaceRuntimeBuilds(
      [node("workers/first"), node("workers/second")],
      async (source) => {
        if (source === "workers/first") throw compilation;
        return binding("second");
      },
      async () => {
        throw publication;
      }
    );
    await expect(result).rejects.toMatchObject({
      errors: [compilation, publication],
      cause: compilation,
    });
  });

  it("reports each runtime's start and completion around build and publication", async () => {
    const progress = vi.fn();
    await prepareWorkspaceRuntimeBuilds(
      [node("workers/first")],
      async () => binding("first"),
      async () => undefined,
      undefined,
      progress
    );
    expect(progress.mock.calls).toEqual([
      [{ type: "started", source: "workers/first" }],
      [
        expect.objectContaining({
          type: "completed",
          source: "workers/first",
        }),
      ],
    ]);
    expect(progress.mock.calls[1]?.[0].durationMs).toEqual(expect.any(Number));
  });

  it("reports whether a runtime failed during build or publication", async () => {
    const buildError = new Error("compile failed");
    const buildProgress = vi.fn();
    await expect(
      prepareWorkspaceRuntimeBuilds(
        [node("workers/build-failure")],
        async () => {
          throw buildError;
        },
        async () => undefined,
        undefined,
        buildProgress
      )
    ).rejects.toBe(buildError);
    expect(buildProgress.mock.calls.map(([event]) => event)).toEqual([
      { type: "started", source: "workers/build-failure" },
      {
        type: "failed",
        source: "workers/build-failure",
        phase: "build",
        error: buildError,
      },
    ]);

    const publishError = new Error("export failed");
    const publishProgress = vi.fn();
    await expect(
      prepareWorkspaceRuntimeBuilds(
        [node("workers/publish-failure")],
        async () => binding("publish-failure"),
        async () => {
          throw publishError;
        },
        undefined,
        publishProgress
      )
    ).rejects.toBe(publishError);
    expect(publishProgress.mock.calls.map(([event]) => event)).toEqual([
      { type: "started", source: "workers/publish-failure" },
      {
        type: "failed",
        source: "workers/publish-failure",
        phase: "publish",
        error: publishError,
      },
    ]);
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
