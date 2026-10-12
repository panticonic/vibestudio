import type { BuildSystemV2 } from "./buildV2/index.js";
import type { GraphNode } from "./buildV2/packageGraph.js";

type RuntimeBuild = Awaited<ReturnType<BuildSystemV2["getBuild"]>>;

/** Submit the release's runtimes to the builder's existing concurrency budget.
 * Every admitted build and export settles before the caller retires its workers. */
export async function prepareWorkspaceRuntimeBuilds(
  nodes: readonly GraphNode[],
  build: (source: string) => Promise<RuntimeBuild>,
  publish: (binding: RuntimeBuild) => Promise<void>,
  signal?: AbortSignal
): Promise<Array<{ source: string; binding: RuntimeBuild }>> {
  signal?.throwIfAborted();
  const runtimes = nodes.filter(
    (node) =>
      node.kind !== "package" &&
      node.kind !== "template" &&
      !(node.kind === "app" && node.manifest.app?.target === "react-native")
  );
  const outcomes = await Promise.allSettled(
    runtimes.map(async (node) => {
      signal?.throwIfAborted();
      const binding = await build(node.relativePath);
      signal?.throwIfAborted();
      await publish(binding);
      return { source: node.relativePath, binding };
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
