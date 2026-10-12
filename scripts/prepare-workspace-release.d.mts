export interface WorkspaceReleasePreparation {
  completed: Promise<void>;
  stop(): Promise<void>;
}
export function isCancellationOnly(error: unknown, active?: Set<object>): boolean;
export function prepareWorkspaceRelease(input: {
  appRoot: string;
  output: string;
  scratch: string;
  env: NodeJS.ProcessEnv;
  executable: string;
  entry: string;
}): WorkspaceReleasePreparation;
