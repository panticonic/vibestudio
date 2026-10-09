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
  status: UnitRegistryStatus;
  lastError: string | null;
}
