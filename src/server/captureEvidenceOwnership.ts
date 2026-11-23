import path from "node:path";
import { createHash } from "node:crypto";
import { captureEvidenceLayout, stateLayout } from "./stateLayout.js";
import { readNativeCaptureRetentionMode } from "./systemTestInstanceMode.js";

/** Collection custody belongs to the supervisor generation, never a deletable workspace. */
export function captureEvidenceForWorkspace(
  statePath: string,
  workspaceId: string,
  environment: NodeJS.ProcessEnv = process.env
) {
  if (!readNativeCaptureRetentionMode(environment)) return stateLayout(statePath).captureEvidence;
  const instanceRoot = environment["VIBESTUDIO_INSTANCE_ROOT"]?.trim();
  if (!instanceRoot || !path.isAbsolute(instanceRoot))
    throw new Error(
      "Collection native retention requires an absolute managed supervisor instance root"
    );
  const owner = createHash("sha256").update(workspaceId).digest("hex");
  return captureEvidenceLayout(path.join(instanceRoot, "capture-evidence", "workspaces", owner));
}
