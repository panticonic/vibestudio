import {
  GENERATED_WORKSPACE_SYSTEM_EPOCH,
  GENERATED_WORKSPACE_APP_VERSION,
} from "./systemEpoch.generated.js";

/** Exact workspace-host generation, derived from the application SemVer major. */
export const WORKSPACE_SYSTEM_EPOCH = GENERATED_WORKSPACE_SYSTEM_EPOCH;

export const WORKSPACE_APP_VERSION = GENERATED_WORKSPACE_APP_VERSION;
