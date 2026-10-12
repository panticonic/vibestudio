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
