export const HOST_BUILD_FINGERPRINT_PATH: string;
export const DESKTOP_HOST_BUILD_FINGERPRINT_PATH: string;

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

export function invalidateHostBuildFingerprints(cwd?: string): void;

export function readHostBuildFingerprint(
  cwd?: string,
  fingerprintPath?: string
): HostBuildFingerprint | null;

export function sameHostBuildFingerprint(
  left: HostBuildFingerprint | null | undefined,
  right: HostBuildFingerprint | null | undefined
): boolean;

export function writeHostBuildFingerprint(
  fingerprint: HostBuildFingerprint,
  cwd?: string,
  fingerprintPath?: string
): void;
