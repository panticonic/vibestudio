export function resolveDevelopmentTemplates(options: {
  repoRoot: string;
  checkpointRoot: string;
  productionTemplates?: boolean;
  explicitRoot?: string | null;
}): ReturnType<
  typeof import("../../../src/dev/developmentTemplateSet.js").resolveDevelopmentTemplateSet
>;

export function assertTemplateCheckoutBootable(options: {
  repoRoot: string;
  checkout: string;
}): Promise<void>;

export function createRemoteServeArgs(repoRoot: string, readyFile: string, port: number): string[];

export function createRemoteSmokeServerEnvironment(
  base: NodeJS.ProcessEnv,
  instanceRoot: string,
  sharedDerivedCacheDir: string
): NodeJS.ProcessEnv &
  Record<
    | "HOME"
    | "USERPROFILE"
    | "XDG_CONFIG_HOME"
    | "APPDATA"
    | "LOCALAPPDATA"
    | "VIBESTUDIO_INSTANCE_ROOT"
    | "VIBESTUDIO_SHARED_DERIVED_CACHE_DIR",
    string
  >;

export function waitForRootInvite(options: {
  readyFile: string;
  timeoutMs?: number;
}): Promise<{ pairUrl: string }>;
