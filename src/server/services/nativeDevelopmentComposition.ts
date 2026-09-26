import type { ExactRepositorySnapshotPlan } from "../vcsHost/workspaceVcs.js";
import {
  NativeDevelopmentExecutor,
  ReviewedNativeDevelopmentTools,
  UnavailableNativeDevelopmentToolDriver,
  type NativeDevelopmentSemanticAdapter,
} from "./nativeDevelopmentExecutor.js";

export async function createNativeDevelopmentController(input: {
  executorId: string;
  root: string;
  blobsDir: string;
  semantic: NativeDevelopmentSemanticAdapter;
  planSource(args: {
    developmentContextId: string;
    repositoryId: string;
  }): Promise<ExactRepositorySnapshotPlan>;
  materializeSource(plan: ExactRepositorySnapshotPlan, destination: string): Promise<void>;
}): Promise<NativeDevelopmentExecutor<ExactRepositorySnapshotPlan>> {
  return new NativeDevelopmentExecutor({
    executorId: input.executorId,
    root: input.root,
    blobsDir: input.blobsDir,
    tools: new ReviewedNativeDevelopmentTools([
      new UnavailableNativeDevelopmentToolDriver(
        "system-editor",
        input.executorId,
        "checkpoint-protocol-unavailable"
      ),
    ]),
    semantic: input.semantic,
    planSource: input.planSource,
    materializeSource: input.materializeSource,
  });
}
