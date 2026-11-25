import type { Ownership } from "@vibestudio/shared/ownership";
import { persistentInstanceRoot, retainedSystemTestEvidenceRoot } from "./instanceRegistry.js";
import { readNativeCaptureRetentionMode } from "../server/systemTestInstanceMode.js";

/** Runtime state retires with its owner. Only requested native capture bytes survive it. */
export async function allocateDevelopmentInstanceStorage(input: {
  ownership: Ownership;
  repoRoot: string;
  id: string;
  disposable: boolean;
  managed: boolean;
  environment: NodeJS.ProcessEnv;
}): Promise<{ root: string; captureEvidenceRoot?: string }> {
  const root = input.disposable
    ? await input.ownership.scratch(`vs-${input.id}-`)
    : persistentInstanceRoot(input.repoRoot, input.id);
  return {
    root,
    ...(input.managed && readNativeCaptureRetentionMode(input.environment)
      ? { captureEvidenceRoot: retainedSystemTestEvidenceRoot(input.repoRoot, input.id) }
      : {}),
  };
}
