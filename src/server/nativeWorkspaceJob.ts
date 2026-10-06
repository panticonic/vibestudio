import type { ProcessAdapter } from "@vibestudio/process-adapter";

export interface NativeWorkspaceJob {
  /** Installed build driver, executed inside the existing workspace domain. */
  script: string;
  bundle: string;
  dependencies: string;
}
export type RunNativeWorkspaceJob = (input: NativeWorkspaceJob) => Promise<void>;

export interface NativeDependencyAdmission {
  key: string;
  nodeModulesDir: string;
  workspacePackages: Record<string, string>;
}

export interface NativeDependencyResources {
  nodeModulesPaths: string[];
  workspacePackages: Record<string, string>;
}

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 16_384;
const consumeLateError = (): void => {};

/** The command owns completion; failure kills and joins it before storage retires. */
export function waitForNativeJob(process: ProcessAdapter): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let bytes = 0;
    let stderr = "";
    let exitCode: number | null | undefined;
    let stdoutEnded = process.stdout == null;
    let stderrEnded = process.stderr == null;
    let failure: Error | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      process.off("exit", onExit);
      process.on("error", consumeLateError);
      process.off("error", onError);
      process.stdout?.off("data", output);
      process.stderr?.off("data", errorOutput);
      process.stdout?.off("end", onStdoutEnd);
      process.stderr?.off("end", onStderrEnd);
      process.stdout?.off("close", onStdoutEnd);
      process.stderr?.off("close", onStderrEnd);
      process.stdout?.off("error", onError);
      process.stderr?.off("error", onError);
      // The adapter owns stream lifetime. Discard subsequent output without
      // retaining this job's buffers or destroying a stream it still writes.
      process.stdout?.resume();
      process.stderr?.resume();
      if (error) reject(error);
      else resolve();
    };
    const stop = (error: Error) => {
      if (failure || settled) return;
      failure = error;
      try {
        process.kill();
      } catch (cleanupError) {
        failure = new AggregateError(
          [error, cleanupError],
          "Native job failure and termination failed",
          {
            cause: error,
          }
        );
      }
      maybeFinish();
    };
    const output = (chunk: unknown) => {
      bytes += Buffer.byteLength(String(chunk));
      if (bytes > MAX_OUTPUT_BYTES) stop(new Error("Native job output exceeds byte limit"));
    };
    const errorOutput = (chunk: unknown) => {
      stderr = (stderr + String(chunk)).slice(-MAX_STDERR_BYTES);
      output(chunk);
    };
    const maybeFinish = () => {
      if (exitCode === undefined || !stdoutEnded || !stderrEnded) return;
      finish(
        failure ??
          (exitCode === 0 ? undefined : new Error(`Native job exited ${exitCode}: ${stderr}`))
      );
    };
    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinish();
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinish();
    };
    const onExit = (code: number | null) => {
      exitCode = code;
      maybeFinish();
    };
    const onError = (error: Error) => stop(error);
    process.on("error", onError);
    process.on("exit", onExit);
    process.stdout?.on("data", output);
    process.stderr?.on("data", errorOutput);
    process.stdout?.on("end", onStdoutEnd);
    process.stderr?.on("end", onStderrEnd);
    process.stdout?.on("close", onStdoutEnd);
    process.stderr?.on("close", onStderrEnd);
    process.stdout?.on("error", onError);
    process.stderr?.on("error", onError);
    maybeFinish();
  });
}
