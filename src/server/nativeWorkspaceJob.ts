import type { ProcessAdapter } from "@vibestudio/process-adapter";

export interface NativeWorkspaceJob {
  /** Installed build driver, executed inside the existing workspace domain. */
  script: string;
  bundle: string;
  dependencies: string;
}
export type RunNativeWorkspaceJob = (input: NativeWorkspaceJob) => Promise<void>;

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 16_384;
const OUTPUT_DRAIN_TIMEOUT_MS = 1_000;
const consumeLateError = (): void => {};

/** Bound output and lifetime even when native code ignores cancellation. */
export function waitForNativeJob(process: ProcessAdapter, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let bytes = 0;
    let stderr = "";
    let exitCode: number | null | undefined;
    let stdoutEnded = process.stdout == null;
    let stderrEnded = process.stderr == null;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      process.off("exit", onExit);
      process.on("error", consumeLateError);
      process.off("error", onError);
      process.stdout?.off("data", output);
      process.stderr?.off("data", errorOutput);
      process.stdout?.off("end", onStdoutEnd);
      process.stderr?.off("end", onStderrEnd);
      // The adapter owns stream lifetime. Discard subsequent output without
      // retaining this job's buffers or destroying a stream it still writes.
      process.stdout?.resume();
      process.stderr?.resume();
      if (error) {
        process.kill();
        reject(error);
      } else resolve();
    };
    const output = (chunk: unknown) => {
      bytes += Buffer.byteLength(String(chunk));
      if (bytes > MAX_OUTPUT_BYTES) finish(new Error("Native job output exceeds byte limit"));
    };
    const errorOutput = (chunk: unknown) => {
      stderr = (stderr + String(chunk)).slice(-MAX_STDERR_BYTES);
      output(chunk);
    };
    const maybeFinish = () => {
      if (exitCode === undefined || !stdoutEnded || !stderrEnded) return;
      finish(exitCode === 0 ? undefined : new Error(`Native job exited ${exitCode}: ${stderr}`));
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
      if (stdoutEnded && stderrEnded) {
        maybeFinish();
        return;
      }
      drainTimer = setTimeout(() => {
        finish(exitCode === 0 ? undefined : new Error(`Native job exited ${exitCode}: ${stderr}`));
      }, OUTPUT_DRAIN_TIMEOUT_MS);
    };
    const timer = setTimeout(() => finish(new Error(`Native job timed out: ${stderr}`)), timeoutMs);
    const onError = (error: Error) => finish(error);
    process.on("error", onError);
    process.on("exit", onExit);
    process.stdout?.on("data", output);
    process.stderr?.on("data", errorOutput);
    process.stdout?.on("end", onStdoutEnd);
    process.stderr?.on("end", onStderrEnd);
    maybeFinish();
  });
}
