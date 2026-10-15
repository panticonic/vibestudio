export type UnitKind = "extension" | "app";

export type UnitRegistryStatus =
  | "running"
  | "available"
  | "stopped"
  | "error"
  | "pending-approval"
  | "building";

export interface UnitSource {
  kind: "workspace-repo";
  repo: string;
  ref: string;
}

/** How many superseded builds a unit keeps selectable for rollback. */
export const UNIT_ROLLBACK_HISTORY_LIMIT = 5;

/**
 * A previously adopted build that can be selected again. Fields a unit kind
 * needs to run that build as it ran then (an app's target and capabilities) are
 * named by its descriptor's `versionedFields` and live beside the base fields.
 */
export interface UnitVersionRecord {
  version: string;
  activeEv: string | null;
  activeSourceHash: string | null;
  activeBundleKey: string;
  executionDigest: string;
  activeDependencyEvs: Record<string, string>;
  activeExternalDeps: Record<string, string>;
  activeRuntimeDepsKey: string | null;
  activatedAt: number;
}

export interface UnitRegistryEntryBase {
  unitKind: UnitKind;
  name: string;
  version: string;
  source: UnitSource;
  installedAt: number;
  activeEv: string | null;
  activeSourceHash: string | null;
  activeBundleKey: string | null;
  activeDependencyEvs: Record<string, string>;
  activeExternalDeps: Record<string, string>;
  activeRuntimeDepsKey: string | null;
  /** Sealed execution identity of the adopted build. */
  activeExecutionDigest: string | null;
  /** Superseded builds, newest first, bounded by UNIT_ROLLBACK_HISTORY_LIMIT. */
  previousVersions: UnitVersionRecord[];
  status: UnitRegistryStatus;
  lastError: string | null;
}
