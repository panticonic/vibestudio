export function exportReleaseBuild(
  source: string,
  destination: string,
  expectedKey: string
): Promise<void>;
export function verifyReleaseBuildDirectory(
  directory: string,
  expectedKey: string,
  exactContents: boolean
): Promise<string[]>;
export function readReleaseBuildDescriptor(
  directory: string,
  expectedKey: string
): Promise<{
  metadata: {
    buildKey: string;
    sourcePath?: unknown;
    ev?: unknown;
    builtAt?: unknown;
    [field: string]: unknown;
  };
  artifacts: Array<{ path: string; byteLength: number; integrity: string }>;
  files: Set<string>;
}>;
export function assertExactReleaseBuildFiles(
  directory: string,
  expectedFiles: ReadonlySet<string>
): Promise<void>;
