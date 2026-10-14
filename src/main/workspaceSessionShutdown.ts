import { runOwnedCleanupSteps } from "../../scripts/lib/owned-cleanup.mjs";

/** RPC producers must settle before transports close, but a failed producer
 * must never prevent the user's explicit owned-server stop from being attempted. */
export function closeWorkspaceSession(steps: {
  joinCatalog(): void | Promise<void>;
  joinExecutor(): void | Promise<void>;
  closeRuntimes(): void | Promise<void>;
  closeTransport(): void | Promise<void>;
  retireServer(): void | Promise<void>;
}): Promise<void> {
  return runOwnedCleanupSteps(
    [
      steps.joinCatalog,
      steps.joinExecutor,
      steps.closeRuntimes,
      steps.closeTransport,
      steps.retireServer,
    ],
    "Workspace session cleanup failed"
  );
}
