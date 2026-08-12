import type { BuildSystemV2 } from "../buildV2/index.js";

const NEW_PANEL_SOURCE = "about/new";

export interface PostReadyBuildWarmup {
  start(options?: { includeEvalLibraries?: boolean }): Promise<void>;
  cancel(): void;
}

interface PostReadyBuildWarmupDeps {
  buildSystem: Pick<BuildSystemV2, "bindRuntimeImage" | "getBuild">;
  evalEngineSource?: string;
  evalRuntimeSource?: string;
  log?: Pick<Console, "log" | "warn">;
}

/**
 * Warm the one shell-owned launcher before lower-priority eval libraries.
 *
 * The fixed, sequential queue is deliberate: post-ready work must not recreate
 * the old workspace-wide prewarm or saturate the build lane while the user is
 * opening a panel. Cancellation stops admission of later speculative builds;
 * BuildSystem shutdown owns any single build already in flight.
 */
export function createPostReadyBuildWarmup(deps: PostReadyBuildWarmupDeps): PostReadyBuildWarmup {
  const logger = deps.log ?? console;
  let cancelled = false;
  let flight: Promise<void> | null = null;

  const runStep = async (label: string, build: () => Promise<unknown>): Promise<void> => {
    if (cancelled) return;
    try {
      await build();
      logger.log(`[BuildWarmup] pre-warmed ${label}`);
    } catch (error) {
      logger.warn(
        `[BuildWarmup] ${label} pre-warm failed (first use will build on demand): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  };

  const run = async (includeEvalLibraries: boolean): Promise<void> => {
    await runStep(NEW_PANEL_SOURCE, () => deps.buildSystem.bindRuntimeImage(NEW_PANEL_SOURCE));

    if (!includeEvalLibraries) return;
    const engineSource = deps.evalEngineSource?.trim();
    const runtimeSource = deps.evalRuntimeSource?.trim();
    if (cancelled) return;
    if (!engineSource || !runtimeSource) {
      logger.warn(
        "[eval] meta/vibestudio.yml declares no `providers.evalEngine`/`providers.evalRuntime` — eval is disabled (pre-warm skipped)"
      );
      return;
    }

    for (const specifier of [
      engineSource,
      `${runtimeSource}/hosted`,
      `${runtimeSource}/panel-runtime`,
      `${runtimeSource}/portable`,
    ]) {
      await runStep(specifier, () =>
        deps.buildSystem.getBuild(specifier, undefined, {
          library: true,
          externals: [],
          libraryTarget: "worker",
        })
      );
    }
  };

  return {
    start(options) {
      flight ??= run(options?.includeEvalLibraries === true);
      return flight;
    },
    cancel() {
      cancelled = true;
    },
  };
}
