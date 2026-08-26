export interface HistoricalHostSnapshotInput {
  centralDataPath: string;
  artifactRoot: string;
  appRoot: string;
  serverEntry: string;
  executable: string;
  appVersion: string;
}

export interface HistoricalHostMarker {
  version: 1;
  systemEpoch: number;
  appVersion: string;
  executable: string;
  serverEntry: string;
  appRoot: string;
}

export function semverMajor(version: string): number;
export function defaultCentralDataPath(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string;
export function publishHistoricalHostSnapshot(input: HistoricalHostSnapshotInput): {
  destination: string;
  marker: HistoricalHostMarker;
};
