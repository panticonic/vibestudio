export interface HostBuildFingerprint {
  version: number;
  mode: string;
  fingerprint: string;
  inputCount: number;
}

export function computeHostBuildFingerprint(options?: {
  cwd?: string;
  mode?: string;
}): HostBuildFingerprint;

export function readHostBuildFingerprint(cwd?: string): HostBuildFingerprint | null;

export function sameHostBuildFingerprint(
  left: HostBuildFingerprint | null | undefined,
  right: HostBuildFingerprint | null | undefined
): boolean;

export function writeHostBuildFingerprint(
  fingerprint: HostBuildFingerprint,
  cwd?: string
): void;
