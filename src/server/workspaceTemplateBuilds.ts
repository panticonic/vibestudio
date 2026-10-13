import type { BuildSystemV2 } from "./buildV2/index.js";
import type { GraphNode } from "./buildV2/packageGraph.js";

type RuntimeBuild = Awaited<ReturnType<BuildSystemV2["getBuild"]>>;

export type WorkspaceRuntimeProgressEvent =
  | { type: "planned"; count: number }
  | { type: "started"; source: string }
  | { type: "completed"; source: string; durationMs: number }
  | {
      type: "failed";
      source: string;
      phase: "build" | "publish";
      error: unknown;
    };

/** Submit the release's runtimes to the builder's existing concurrency budget.
 * Every admitted build and export settles before the caller retires its workers. */
export async function prepareWorkspaceRuntimeBuilds(
  nodes: readonly GraphNode[],
  build: (source: string) => Promise<RuntimeBuild>,
  publish: (binding: RuntimeBuild) => Promise<void>,
  signal?: AbortSignal,
  reportProgress?: (event: WorkspaceRuntimeProgressEvent) => void
): Promise<Array<{ source: string; binding: RuntimeBuild }>> {
  signal?.throwIfAborted();
  const runtimes = nodes.filter(
    (node) =>
      node.kind !== "package" &&
      node.kind !== "template" &&
      !(node.kind === "app" && node.manifest.app?.target === "react-native")
  );
  reportProgress?.({ type: "planned", count: runtimes.length });
  const outcomes = await Promise.allSettled(
    runtimes.map(async (node) => {
      signal?.throwIfAborted();
      const source = node.relativePath;
      const startedAt = Date.now();
      reportProgress?.({ type: "started", source });
      let phase: "build" | "publish" = "build";
      try {
        const binding = await build(source);
        signal?.throwIfAborted();
        phase = "publish";
        await publish(binding);
        reportProgress?.({
          type: "completed",
          source,
          durationMs: Date.now() - startedAt,
        });
        return { source, binding };
      } catch (error) {
        reportProgress?.({ type: "failed", source, phase, error });
        throw error;
      }
    })
  );
  const builds: Array<{ source: string; binding: RuntimeBuild }> = [];
  const failures: unknown[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") failures.push(outcome.reason);
    else builds.push(outcome.value);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Workspace runtime preparation failed", {
      cause: failures[0],
    });
  }
  return builds;
}
