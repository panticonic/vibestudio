import * as path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

/** Publish source-launch resources through the ordinary template preparer.
 * The launch owner retains output for its generation and owns its retirement.
 * Cancellation reaches the preparer's native owners and is joined before the
 * launch caller may remove either scratch or prepared output. */
export async function prepareWorkspaceRelease(input: {
  appRoot: string;
  output: string;
  scratch: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const loader = createRequire(import.meta.url).resolve("tsx/esm");
  const child = spawn(
    process.execPath,
    [
      "--import",
      loader,
      path.join(input.appRoot, "scripts/prepare-workspace-templates.ts"),
      "--app-root",
      input.appRoot,
      "--output",
      input.output,
      "--scratch",
      input.scratch,
    ],
    { cwd: input.appRoot, env: input.env, stdio: "inherit" }
  );
  let cancelled: Error | null = null;
  const interrupt = () => {
    cancelled ??= new Error("Workspace release preparation cancelled");
    child.kill("SIGTERM");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    await new Promise<void>((resolve, reject) => {
      let failure: Error | undefined;
      child.once("error", (error) => {
        failure = error;
      });
      child.once("close", (code, signal) => {
        if (failure) reject(failure);
        else if (cancelled) reject(cancelled);
        else if (code !== 0)
          reject(new Error(`Workspace release preparation exited (${signal ?? code})`));
        else resolve();
      });
    });
    input.env["VIBESTUDIO_WORKSPACE_RELEASE_ROOT"] = input.output;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
