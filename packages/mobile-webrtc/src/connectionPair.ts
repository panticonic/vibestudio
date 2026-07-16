import type { WebRtcConnection } from "./connect.js";

/** Aggregate failure portable to React Native targets without AggregateError. */
export class MobileConnectionAggregateError extends Error {
  readonly errors: readonly unknown[];

  constructor(errors: readonly unknown[], message: string) {
    super(message);
    this.name = "MobileConnectionAggregateError";
    this.errors = errors;
  }
}

/** Compose one stable hub pipe with one exact selected-workspace pipe. */
export function composeMobileSession(
  control: WebRtcConnection,
  workspace: WebRtcConnection
): WebRtcConnection {
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
