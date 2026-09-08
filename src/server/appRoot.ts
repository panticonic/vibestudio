import * as path from "node:path";

export function resolveRequiredAppRoot(
  input: {
    readonly argument?: string;
    readonly env?: NodeJS.ProcessEnv;
  } = {}
): string {
  const configured = input.argument ?? (input.env ?? process.env)["VIBESTUDIO_APP_ROOT"];
  if (!configured) {
    throw new Error(
      "Vibestudio startup requires --app-root or VIBESTUDIO_APP_ROOT; the process working directory is not an execution input"
    );
  }
  return path.resolve(configured);
}

export function resolveRequiredHostArtifactRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["VIBESTUDIO_HOST_ARTIFACT_ROOT"];
  if (!configured) {
    throw new Error(
      "Vibestudio startup requires VIBESTUDIO_HOST_ARTIFACT_ROOT; compiled artifacts must come from one explicit host generation"
    );
  }
  return path.resolve(configured);
}
