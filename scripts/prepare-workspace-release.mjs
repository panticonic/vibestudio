import { spawn } from "node:child_process";
import path from "node:path";
import {
  deserializeRpcFailure,
  formatRpcFailure,
  isRpcAbortedBy,
  RPC_ABORTED_CODE,
} from "@vibestudio/rpc";
import { joinChildProcess } from "./lib/join-child-process.mjs";

function isCancellationOnly(error, active = new Set()) {
  if (!error || typeof error !== "object") return false;
  if (active.has(error)) return false;
  active.add(error);
  const children = [
    ...(Array.isArray(error.errors) ? error.errors : []),
    ...(error.cause === undefined ? [] : [error.cause]),
  ];
  const code = error.code;
  const explicitCancellation = code === "ECANCELLED" || code === RPC_ABORTED_CODE;
  const aggregate = error instanceof AggregateError && code === undefined;
  let result = false;
  if (explicitCancellation) {
    result = children.every((child) => isCancellationOnly(child, active));
  } else if (aggregate && children.length > 0) {
    result = children.every((child) => isCancellationOnly(child, active));
  }
  active.delete(error);
  return result;
}

function containsCancellation(error, seen = new Set()) {
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  if (error.code === "ECANCELLED") return true;
  return (
    containsCancellation(error.cause, seen) ||
    (Array.isArray(error.errors) && error.errors.some((child) => containsCancellation(child, seen)))
  );
}

function joinedFailure(failures, message) {
  if (failures.length === 1) return failures[0];
  return new AggregateError(failures, message, { cause: failures[0] });
}

/** One producer owns source publication and exhaustive compilation. Launchers
 * may proceed at sourcesReady; packagers require completed. Every caller must
 * stop and join the producer before retiring its source or output directories.
 * @param {{ appRoot: string, output: string, scratch: string, env: NodeJS.ProcessEnv, executable: string, entry: string }} input
 */
export function prepareWorkspaceRelease(input) {
  const child = spawn(
    input.executable,
    [
      input.entry,
      "--app-root",
      input.appRoot,
      "--output",
      input.output,
      "--scratch",
      input.scratch,
    ],
    { cwd: path.dirname(input.entry), env: input.env, stdio: ["ignore", "pipe", "pipe", "ipc"] }
  );
  let resolveReady, rejectReady;
  const sourcesReady = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let ready = false,
    failure,
    cancellation,
    stopping,
    tail = "";
  for (const [stream, target] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ]) {
    stream.on("data", (chunk) => {
      tail = (tail + chunk).slice(-8192);
      target.write(chunk);
    });
  }
  child.on("message", (message) => {
    if (message?.kind === "sources-ready" && !ready && !cancellation) {
      ready = true;
      input.env["VIBESTUDIO_WORKSPACE_RELEASE_ROOT"] = input.output;
      resolveReady();
    } else if (message?.kind === "failed") {
      try {
        const received = deserializeRpcFailure(message.failure);
        failure = failure
          ? joinedFailure(
              [failure, received],
              "Workspace release producer reported multiple failures"
            )
          : received;
      } catch (error) {
        failure = failure
          ? joinedFailure(
              [failure, error],
              "Workspace release producer sent an invalid failure receipt"
            )
          : error;
      }
    }
  });
  const interrupt = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    cancellation ??= Object.assign(new Error("Workspace release preparation cancelled"), {
      code: "ECANCELLED",
    });
    child.kill("SIGTERM");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const completed = joinChildProcess(child)
    .then((result) => {
      const failures = [];
      if (failure) failures.push(failure);
      if (
        cancellation &&
        !(failure && isCancellationOnly(failure)) &&
        !containsCancellation(failure) &&
        !isRpcAbortedBy(failure, cancellation)
      ) {
        failures.push(cancellation);
      }
      if (result.error) failures.push(result.error);
      if (result.signal) {
        failures.push(
          new Error(`Workspace release preparation was terminated by ${result.signal}: ${tail}`)
        );
      } else if (result.code !== 0 && !failure) {
        failures.push(new Error(`Workspace release preparation exited (${result.code}): ${tail}`));
      } else if (result.code !== 0 && result.code !== 1) {
        failures.push(
          new Error(`Workspace release preparation exited unexpectedly (${result.code}): ${tail}`)
        );
      }
      if (failures.length > 0)
        throw joinedFailure(failures, "Workspace release preparation failed");
      if (!ready) throw new Error("Workspace release producer exited without publishing sources");
    })
    .catch((error) => {
      rejectReady(error);
      throw error;
    })
    .finally(() => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    });
  // Readiness and completion have different consumers. Keep failures observable
  // without an unhandled rejection while a caller is awaiting the other phase.
  void sourcesReady.catch(() => {});
  void completed.catch(() => {});
  return {
    sourcesReady,
    completed,
    stop() {
      if (stopping) return stopping;
      interrupt();
      stopping = (async () => {
        try {
          await completed;
        } catch (error) {
          // The parent's exact stop request may be acknowledged by the child's
          // ECANCELLED receipt. Other operation or retirement failures remain
          // visible to the owner.
          if (!cancellation || !isCancellationOnly(error)) {
            console.warn(
              `[workspace-release] Stop joined with failure: ${formatRpcFailure(error)}`
            );
            throw error;
          }
        }
      })();
      return stopping;
    },
  };
}
