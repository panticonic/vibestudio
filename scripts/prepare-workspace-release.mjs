import { spawn } from "node:child_process";
import path from "node:path";
import { statSync } from "node:fs";
import {
  deserializeRpcFailure,
  formatRpcFailure,
  isRpcAbortedBy,
  RPC_ABORTED_CODE,
} from "@vibestudio/rpc";
import { joinChildProcess } from "./lib/join-child-process.mjs";

export function isCancellationOnly(error, active = new Set()) {
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

/** One producer owns exhaustive compilation and final output publication. Consumers
 * start only after completed so they observe one immutable, complete artifact
 * set. Every caller must stop and join the producer before retiring its source
 * or output directories.
 * `scope: "sources"` publishes only the sealed template sources, for a source
 * supervisor whose server compiles runtimes on demand; the default publishes
 * the complete release a packager ships.
 * @param {{ appRoot: string, output: string, scratch: string, env: NodeJS.ProcessEnv, executable: string, entry: string, scope?: "sources" | "release", onProgress?: (progress: object) => void }} input
 */
export function prepareWorkspaceRelease(input) {
  const scope = input.scope ?? "release";
  const declaredOutput = input.env["VIBESTUDIO_WORKSPACE_RELEASE_ROOT"];
  const output = path.resolve(declaredOutput ?? input.output);
  // A supplied release is a required input. Missing or partial artifacts must
  // never be mistaken for a new producer-owned output directory.
  if (declaredOutput) {
    if (!statSync(path.join(output, "userland-builds", "release.json")).isFile()) {
      throw new Error(`Workspace release manifest is not a file: ${output}`);
    }
  }
  const child = spawn(
    input.executable,
    [
      input.entry,
      "--app-root",
      input.appRoot,
      "--output",
      output,
      "--scratch",
      input.scratch,
      "--scope",
      scope,
    ],
    {
      cwd: path.dirname(input.entry),
      env: { ...input.env, VIBESTUDIO_WORKSPACE_RELEASE_ROOT: output },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    }
  );
  let failure,
    completedReceipt = false,
    cancellation,
    stopping,
    tail = "";
  // `input.log`, when given, receives both streams (a launcher that keeps the
  // terminal for its own UI); otherwise they pass through to this process.
  for (const [stream, target] of [
    [child.stdout, input.log ?? process.stdout],
    [child.stderr, input.log ?? process.stderr],
  ]) {
    stream.on("data", (chunk) => {
      tail = (tail + chunk).slice(-8192);
      target.write(chunk);
    });
  }
  child.on("message", (message) => {
    if (message?.kind === "progress") {
      input.onProgress?.(message.progress);
    } else if (message?.kind === "completed") {
      if (completedReceipt || failure) {
        const invalidReceipt = new Error(
          "Workspace release producer sent an invalid completion receipt"
        );
        failure = failure
          ? joinedFailure(
              [failure, invalidReceipt],
              "Workspace release producer reported multiple failures"
            )
          : invalidReceipt;
      } else {
        completedReceipt = true;
      }
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
      if (!completedReceipt)
        throw new Error("Workspace release producer exited without a completed release receipt");
      input.env["VIBESTUDIO_WORKSPACE_RELEASE_ROOT"] = output;
    })
    .finally(() => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    });
  // Keep producer failures observable even while a caller is joining cleanup.
  void completed.catch(() => {});
  return {
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
