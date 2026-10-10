import { deserializeRpcFailure, serializeRpcFailure } from "@vibestudio/rpc";
import type { RpcFailure, RpcFailureReference } from "@vibestudio/rpc";
import { BuildDiagnosticsError, type BuildDiagnostic } from "./diagnostics.js";

export type BuildWorkerFailure = RpcFailure & {
  buildDiagnostics?: BuildDiagnostic[];
  cause?: BuildWorkerFailure | RpcFailureReference;
  errors?: Array<BuildWorkerFailure | RpcFailureReference>;
};

/** Keep worker failures on one wire channel while retaining build diagnostics. */
export function serializeBuildWorkerFailure(error: unknown): BuildWorkerFailure {
  const failure = serializeRpcFailure(error) as BuildWorkerFailure;
  const seen = new Set<object>();
  const attachDiagnostics = (source: unknown, target: BuildWorkerFailure | RpcFailureReference) => {
    if (!source || typeof source !== "object" || seen.has(source) || "reference" in target) return;
    seen.add(source);
    if (source instanceof BuildDiagnosticsError) target.buildDiagnostics = source.diagnostics;
    const fields = source as { cause?: unknown; errors?: unknown };
    if ("cause" in fields && target.cause && !("reference" in target.cause)) {
      attachDiagnostics(fields.cause, target.cause);
    }
    if (Array.isArray(fields.errors) && target.errors) {
      fields.errors.forEach((child, index) => {
        const childFailure = target.errors?.[index];
        if (childFailure) attachDiagnostics(child, childFailure);
      });
    }
  };
  attachDiagnostics(error, failure);
  return failure;
}

/** Rebuild the failure graph and restore its build-specific diagnostic nodes. */
export function deserializeBuildWorkerFailure(value: unknown): Error {
  const failure = value as BuildWorkerFailure;
  const error = deserializeRpcFailure(value);
  const seen = new Set<object>();
  const restoreDiagnostics = (
    serialized: BuildWorkerFailure | RpcFailureReference,
    restored: unknown
  ) => {
    if (
      !restored ||
      typeof restored !== "object" ||
      seen.has(restored) ||
      "reference" in serialized
    )
      return;
    seen.add(restored);
    if (serialized.buildDiagnostics) {
      Object.setPrototypeOf(restored, BuildDiagnosticsError.prototype);
      Object.defineProperty(restored, "diagnostics", {
        value: serialized.buildDiagnostics,
        enumerable: true,
        configurable: true,
      });
    }
    const fields = restored as { cause?: unknown; errors?: unknown[] };
    if (serialized.cause && fields.cause !== undefined) {
      restoreDiagnostics(serialized.cause, fields.cause);
    }
    if (serialized.errors && fields.errors) {
      serialized.errors.forEach((child, index) => {
        const restoredChild = fields.errors?.[index];
        if (restoredChild !== undefined) restoreDiagnostics(child, restoredChild);
      });
    }
  };
  restoreDiagnostics(failure, error);
  return error;
}
