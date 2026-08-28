import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";

export interface StartupPanelPreparationResult {
  sources: string[];
  elapsedMs: number;
}

/**
 * Resolve the immutable runtime images for the panels the workspace declares as
 * its initial surface. This is cache preparation only: it neither creates a
 * panel entity nor executes workspace code.
 *
 * All preparations are started together so they enter the interactive build
 * queue ahead of opportunistic background reconciliation. BuildV2 still owns
 * the actual concurrency limit and coalesces these flights with a panel request
 * that arrives while preparation is in progress.
 */
export async function prepareStartupPanels(
  config: Pick<WorkspaceConfig, "initPanels">,
  primePanelRuntimeImage: (source: string, ref?: string) => Promise<void>
): Promise<StartupPanelPreparationResult> {
  const sources = [
    ...new Set(
      (config.initPanels ?? [])
        .map((entry) => entry.source.trim())
        .filter((source) => source.length > 0)
    ),
  ];
  const startedAt = performance.now();
  await Promise.all(sources.map((source) => primePanelRuntimeImage(source)));
  return { sources, elapsedMs: performance.now() - startedAt };
}
