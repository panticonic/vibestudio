import path from "node:path";
import { createHash } from "node:crypto";
import { captureEvidenceLayout, stateLayout } from "./stateLayout.js";
import { NATIVE_CAPTURE_EVIDENCE_ROOT_ENV, readNativeCaptureRetentionMode } from "./systemTestInstanceMode.js";

/** Explicit collection custody is separate from disposable instance and workspace state. */
export function captureEvidenceForWorkspace(
  statePath: string,
  workspaceId: string,
  environment: NodeJS.ProcessEnv = process.env
) {
  if (!readNativeCaptureRetentionMode(environment)) return stateLayout(statePath).captureEvidence;
  const instanceRoot = environment[NATIVE_CAPTURE_EVIDENCE_ROOT_ENV]?.trim();
  if (!instanceRoot || !path.isAbsolute(instanceRoot))
    throw new Error(
      "Collection native retention requires an absolute managed supervisor capture evidence root"
    );
  const owner = createHash("sha256").update(workspaceId).digest("hex");
  return captureEvidenceLayout(path.join(instanceRoot, "capture-evidence", "workspaces", owner));
}
