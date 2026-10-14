export type HostBuildGenerationKind = "source" | "desktop";
export const HOST_PREPARATION_RECIPES: string;
export function readHostPreparationRecipe(root: string, entry: string): string;
export function admitPublishedHostBuildGeneration(
  cwd: string,
  build: {
    kind: HostBuildGenerationKind;
    mode: "development" | "production";
    fingerprint: string;
    inputCount: number;
  }
): string | null;

export function readCurrentHostBuildGeneration(
  cwd: string | undefined,
  kind: HostBuildGenerationKind
): string;
