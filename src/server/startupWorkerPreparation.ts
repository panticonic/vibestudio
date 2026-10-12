import type { BuildSystemV2 } from "./buildV2/index.js";
import type { StoredBuildResult } from "./buildV2/buildStore.js";

export type StartupWorkerBuilds = Pick<BuildSystemV2, "listBuildUnits" | "getStoredBuild">;

/** Prepare executables and schema evidence from one immutable workspace view, without creating entities.
 * Demand joins the same content-addressed builds; speculative work yields to it.
 * Shutdown stops admission and joins the admitted build or schema operation. */
export async function prepareStartupWorkers(
  builds: StartupWorkerBuilds,
  prepareExecutable: (build: StoredBuildResult, classNames: readonly string[]) => Promise<void>,
  signal: AbortSignal
): Promise<{ sources: string[]; elapsedMs: number }> {
  const startedAt = performance.now();
  signal.throwIfAborted();
  const units = await builds.listBuildUnits(undefined, ["worker"]);
  const sources: string[] = [];
  const failures: unknown[] = [];
  for (const unit of units) {
    signal.throwIfAborted();
    try {
      const build = await builds.getStoredBuild(unit.unitPath, unit.stateHash, {
        priority: "speculative",
      });
      signal.throwIfAborted();
      await prepareExecutable(
        build,
        (unit.manifest.durable?.classes ?? []).map(({ className }) => className)
      );
      sources.push(unit.unitPath);
    } catch (error) {
      failures.push(error);
    }
  }
  signal.throwIfAborted();
  if (failures.length > 0) {
    throw new AggregateError(failures, "Workspace worker executable preparation failed");
  }
  return { sources, elapsedMs: performance.now() - startedAt };
}
