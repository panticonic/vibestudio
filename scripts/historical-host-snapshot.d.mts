export interface HistoricalHostSnapshotInput {
  centralDataPath: string;
  artifactRoot: string;
  appRoot: string;
  serverEntry: string;
  executable: string;
  appVersion: string;
  platform?: NodeJS.Platform;
}

export interface HistoricalHostMarker {
  version: 2;
  systemEpoch: number;
  appVersion: string;
  executable: string;
  runtimeMode: "node" | "electron-node";
  serverEntry: string;
  appRoot: string;
}

export function semverMajor(version: string): number;
export function defaultCentralDataPath(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string;
export function artifactRootFromModuleUrl(moduleUrl?: string): string;
export function publishHistoricalHostSnapshot(input: HistoricalHostSnapshotInput): {
  destination: string;
  marker: HistoricalHostMarker;
};
