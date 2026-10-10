export function prepareWorkspaceRelease(input: {
  appRoot: string;
  output: string;
  scratch: string;
  env: NodeJS.ProcessEnv;
}): Promise<void>;
