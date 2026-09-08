export type HostBuildGenerationKind = "source" | "desktop";

export function readCurrentHostBuildGeneration(
  cwd: string | undefined,
  kind: HostBuildGenerationKind
): string;
