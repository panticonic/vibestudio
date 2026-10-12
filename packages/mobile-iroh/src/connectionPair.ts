import type { IrohConnection } from "./connect.js";

function failureDetail(value: unknown, seen: Set<object>): string {
  if (value === null || typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular failure]";
  seen.add(value);
  const message = value instanceof Error ? value.message : String(value);
  const nested = (value as { errors?: unknown }).errors;
  const errors = Array.isArray(nested)
    ? nested
    : "cause" in value && value.cause !== undefined
      ? [value.cause]
      : [];
  return errors.length
    ? `${message}: ${errors.map((error) => failureDetail(error, seen)).join("; ")}`
    : message;
}

/** Aggregate failure portable to React Native targets without AggregateError. */
export class MobileConnectionAggregateError extends Error {
  readonly errors: readonly unknown[];
  readonly cause: unknown;

  constructor(errors: readonly unknown[], message: string) {
    super(`${message}: ${errors.map((error) => failureDetail(error, new Set())).join("; ")}`);
    this.name = "MobileConnectionAggregateError";
    this.errors = errors;
    this.cause = errors[0];
  }
}

export function combineMobileFailures(
  failure: unknown,
  cleanup: unknown,
  context: string
): MobileConnectionAggregateError {
  return new MobileConnectionAggregateError(
    [failure, cleanup],
    `${context} and connection cleanup failed`
  );
}

/** Compose one stable hub pipe with one exact selected-workspace pipe. */
export function composeMobileSession(
  control: IrohConnection,
  workspace: IrohConnection
): IrohConnection {
  const closeWorkspace = workspace.close.bind(workspace);
  const closeControl = control.close.bind(control);
  return {
    ...workspace,
    hubControlRpc: control.rpc,
    async close() {
      const results = await Promise.allSettled([closeWorkspace(), closeControl()]);
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new MobileConnectionAggregateError(
          failures,
          "Mobile hub and workspace connections failed to close"
        );
      }
    },
  };
}
