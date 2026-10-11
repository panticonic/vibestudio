import * as path from "node:path";
import { formatRpcFailure, isRpcAbortedBy, serializeRpcFailure } from "@vibestudio/rpc";
import { prepareWorkspaceTemplates } from "../src/server/workspaceTemplatePreparation.js";

const option = (name: string) => {
  const value = process.argv[process.argv.indexOf(name) + 1];
  if (!process.argv.includes(name) || !value) throw new Error(`${name} is required`);
  return path.resolve(value);
};
const cancellation = new AbortController();
function containsErrorIdentity(error: unknown, target: unknown, seen = new Set<object>()): boolean {
  if (error === target) return true;
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  const fields = error as { cause?: unknown; errors?: unknown[] };
  return (
    containsErrorIdentity(fields.cause, target, seen) ||
    (Array.isArray(fields.errors) &&
      fields.errors.some((child) => containsErrorIdentity(child, target, seen)))
  );
}
function joinFailures(failures: unknown[], message: string): unknown {
  if (failures.length === 1) return failures[0];
  return new AggregateError(failures, message, { cause: failures[0] });
}
function sendMessage(message: object): Promise<Error | null> {
  return new Promise((resolve, reject) => {
    try {
      if (typeof process.send !== "function") return resolve(null);
      if (!process.connected) return resolve(new Error("Template preparation IPC is disconnected"));
      process.send!(message, (error) => resolve(error));
    } catch (error) {
      reject(error);
    }
  });
}
const interrupt = () =>
  cancellation.abort(
    Object.assign(new Error("Template preparation cancelled"), { code: "ECANCELLED" })
  );
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
process.on("disconnect", interrupt);
void (async () => {
  const failures: unknown[] = [];
  try {
    await prepareWorkspaceTemplates({
      appRoot: option("--app-root"),
      output: option("--output"),
      scratch: option("--scratch"),
      signal: cancellation.signal,
      onSourcesPrepared: async () => {
        const error = await sendMessage({ kind: "sources-ready" });
        if (error) throw error;
      },
    });
  } catch (caught) {
    let failure = caught;
    if (
      cancellation.signal.aborted &&
      !isRpcAbortedBy(failure, cancellation.signal.reason) &&
      !containsErrorIdentity(failure, cancellation.signal.reason)
    ) {
      failure = joinFailures(
        [failure, cancellation.signal.reason],
        "Template preparation failed while cancellation was being joined"
      );
    }
    failures.push(failure);
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    process.off("disconnect", interrupt);
  }

  let disconnected = false;
  let disconnectAttempted = false;
  if (failures.length === 0 && process.connected) {
    disconnectAttempted = true;
    try {
      process.disconnect();
      disconnected = true;
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0 && process.connected) {
    const failure = joinFailures(failures, "Template preparation failed");
    try {
      const sendError = await sendMessage({
        kind: "failed",
        failure: serializeRpcFailure(failure),
      });
      if (sendError) failures.push(sendError);
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    const failure = joinFailures(failures, "Template preparation failed");
    if (!isRpcAbortedBy(failure, cancellation.signal.reason))
      console.error(formatRpcFailure(failure));
    process.exitCode = 1;
  }

  if (!disconnectAttempted && process.connected) {
    disconnectAttempted = true;
    try {
      process.disconnect();
    } catch (error) {
      failures.push(error);
      const retirementFailure = joinFailures(
        failures,
        "Template preparation IPC retirement failed"
      );
      console.error(formatRpcFailure(retirementFailure));
      process.exitCode = 1;
      try {
        if (process.connected) {
          const sendError = await sendMessage({
            kind: "failed",
            failure: serializeRpcFailure(error),
          });
          if (sendError) failures.push(sendError);
        }
      } catch (sendError) {
        failures.push(sendError);
      }
      if (failures.length > 1)
        console.error(
          formatRpcFailure(joinFailures(failures, "Template preparation IPC retirement failed"))
        );
    }
  }
})();
