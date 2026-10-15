import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
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

const GIB = 1024 * 1024 * 1024;
const BATCH_BUILD_LANE_BYTES = 1.5 * GIB;
const MAX_BATCH_BUILD_LANES = 8;

/** Select the capacity for this one exhaustive producer, without increasing
 * the independent admission budgets owned by live interactive workspaces. */
export function resolveReleaseBuildConcurrency({
  configured,
  availableParallelism = os.availableParallelism(),
  totalMemoryBytes = os.totalmem(),
}) {
  const explicit = Number.parseInt(configured ?? "", 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const processors = Math.max(1, Math.floor(availableParallelism));
  const memory = Math.max(0, totalMemoryBytes);
  const reserve = Math.min(4 * GIB, memory / 3);
  const memoryLanes = Math.max(1, Math.floor((memory - reserve) / BATCH_BUILD_LANE_BYTES));
  return Math.min(MAX_BATCH_BUILD_LANES, processors, memoryLanes);
}

/** One producer owns immutable source publication followed by exhaustive
 * compilation and final release publication. Interactive source launchers may
 * start at sourcesReady; installed and packaging consumers wait for completed.
 * Every caller must stop and join the producer before retiring either output.
 * `scope: "sources"` completes after source publication for on-demand runtimes.
 * @param {{ appRoot: string, output: string, sourceOutput?: string, scratch: string, env: NodeJS.ProcessEnv, executable: string, entry: string, scope?: "sources" | "release", onProgress?: (progress: object) => void }} input
 */
export function prepareWorkspaceRelease(input) {
  const scope = input.scope ?? "release";
  const declaredOutput = input.env["VIBESTUDIO_WORKSPACE_RELEASE_ROOT"];
  const output = path.resolve(declaredOutput ?? input.output);
  // Every producer has two distinct publication roots. A live consumer owns
  // its source root explicitly; otherwise the source phase belongs to scratch.
  const sourceOutput = path.resolve(
    input.sourceOutput ?? path.join(input.scratch, "source-ready-root")
  );
  // A supplied release is a required input. Missing or partial artifacts must
  // never be mistaken for a new producer-owned output directory.
  if (declaredOutput) {
    if (!statSync(path.join(output, "userland-builds", "release.json")).isFile()) {
      throw new Error(`Workspace release manifest is not a file: ${output}`);
    }
  }
  const buildConcurrency = resolveReleaseBuildConcurrency({
    configured: input.env["VIBESTUDIO_MAX_CONCURRENT_BUILDS"],
  });
  const child = spawn(
    input.executable,
    [
      input.entry,
      "--app-root",
      input.appRoot,
      "--output",
      output,
      "--source-output",
      sourceOutput,
      "--scratch",
      input.scratch,
      "--scope",
      scope,
    ],
    {
      cwd: path.dirname(input.entry),
      env: {
        ...input.env,
        VIBESTUDIO_WORKSPACE_RELEASE_ROOT: output,
        // Interactive source launches share the canonical host admission
        // budget with live workspaces. A standalone packager owns its batch
        // allowance and has no competing application-startup consumer.
        ...(!input.sourceOutput
          ? { VIBESTUDIO_MAX_CONCURRENT_BUILDS: String(buildConcurrency) }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    }
  );
  let resolveSourcesReady, rejectSourcesReady;
  const sourcesReady = new Promise((resolve, reject) => {
    resolveSourcesReady = resolve;
    rejectSourcesReady = reject;
  });
  let sourcesReadyReceipt = false,
    failure,
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
    } else if (message?.kind === "sources-ready") {
      const root = typeof message.root === "string" ? path.resolve(message.root) : null;
      const allowedRoots = new Set([output, sourceOutput]);
      if (sourcesReadyReceipt || completedReceipt || failure || !root || !allowedRoots.has(root)) {
        const invalidReceipt = new Error(
          "Workspace release producer sent an invalid source-ready receipt"
        );
        failure = failure
          ? joinedFailure(
              [failure, invalidReceipt],
              "Workspace release producer reported multiple failures"
            )
          : invalidReceipt;
        rejectSourcesReady(failure);
      } else {
        sourcesReadyReceipt = true;
        input.env["VIBESTUDIO_WORKSPACE_RELEASE_ROOT"] = root;
        resolveSourcesReady();
      }
    } else if (message?.kind === "completed") {
      if (!sourcesReadyReceipt || completedReceipt || failure) {
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
        rejectSourcesReady(failure);
      } catch (error) {
        failure = failure
          ? joinedFailure(
              [failure, error],
              "Workspace release producer sent an invalid failure receipt"
            )
          : error;
        rejectSourcesReady(failure);
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
      if (!sourcesReadyReceipt)
        throw new Error("Workspace release producer exited without publishing template sources");
      if (!completedReceipt)
        throw new Error("Workspace release producer exited without a completed release receipt");
      input.env["VIBESTUDIO_WORKSPACE_RELEASE_ROOT"] = output;
    })
    .catch((error) => {
      rejectSourcesReady(error);
      throw error;
    })
    .finally(() => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    });
  // Source readiness and completion have different consumers. Keep both
  // failures observable while a caller awaits or joins the other phase.
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
