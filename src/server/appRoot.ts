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
