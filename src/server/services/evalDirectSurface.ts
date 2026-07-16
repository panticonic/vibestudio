import {
  EVAL_CAPABILITY_ACQUISITION_LEDGER,
  EVAL_DIRECT_SURFACE_REACHABILITY,
} from "./evalInvocationExposure.generated.js";

type EvalSurfaceRow = (typeof EVAL_CAPABILITY_ACQUISITION_LEDGER)[number];

function closed(message: string): Error {
  return Object.assign(new Error(message), { code: "EVAL_CAPABILITY_CLOSED" });
}

function policySignature(row: EvalSurfaceRow): string {
  return JSON.stringify({
    acquisition: row.acquisition,
    sensitivity: "sensitivity" in row ? row.sensitivity : null,
  });
}

/**
 * Resolve a direct-RPC eval leaf by its canonical `rpc:<method>` capability.
 *
 * A runtime source is the concrete worker/DO artifact. Decorated methods may
 * live in an inherited workspace package, but that edge is authority-bearing:
 * it must exist in the reviewed source reachability graph. Method-name equality
 * alone never makes a definition reachable from a new runtime source.
 */
export function resolveEvalDirectSurface(source: string, method: string): EvalSurfaceRow {
  const capability = `rpc:${method}`;
  const rows = EVAL_CAPABILITY_ACQUISITION_LEDGER.filter(
    (row) => row.rpcPlane === "workspace-do" && row.capability === capability
  );
  if (rows.length === 0) {
    throw closed(`Direct eval capability ${capability} is absent from the reviewed catalog`);
  }
  if (new Set(rows.map(policySignature)).size !== 1) {
    throw closed(`Direct eval capability ${capability} has conflicting reviewed policies`);
  }
  const inheritedSurfaces = Object.prototype.hasOwnProperty.call(
    EVAL_DIRECT_SURFACE_REACHABILITY,
    source
  )
    ? EVAL_DIRECT_SURFACE_REACHABILITY[source as keyof typeof EVAL_DIRECT_SURFACE_REACHABILITY]
    : [];
  const reachableRows = rows.filter(
    (row) =>
      "source" in row &&
      (row.source === source ||
        inheritedSurfaces.some(
          (surface) => surface.source === row.source && surface.method === method
        ))
  );
  if (reachableRows.length === 0) {
    throw closed(
      `Direct eval capability ${capability} is not reviewed for runtime source ${source}`
    );
  }
  return reachableRows.find((row) => "source" in row && row.source === source) ?? reachableRows[0]!;
}
