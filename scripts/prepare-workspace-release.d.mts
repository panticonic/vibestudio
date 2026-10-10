export interface WorkspaceReleasePreparation {
  sourcesReady: Promise<void>;
  completed: Promise<void>;
  stop(): Promise<void>;
}
export function prepareWorkspaceRelease(input: {
  appRoot: string;
  output: string;
  scratch: string;
  env: NodeJS.ProcessEnv;
  executable: string;
  entry: string;
}): WorkspaceReleasePreparation;
