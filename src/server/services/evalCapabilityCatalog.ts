import type { EvalCatalogLeaf } from "@vibestudio/service-schemas/docs";
import {
  EVAL_CAPABILITY_ACQUISITION_LEDGER,
  EVAL_INVOCATION_EXPOSURE_CAPABILITIES,
  EVAL_SERVER_HOST_METHODS,
} from "./evalInvocationExposure.generated.js";
import type { ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";

/**
 * Project the generated closed-by-default eval census into ordinary service
 * discovery. The ledger remains an exposure ceiling; this view grants nothing.
 */
export function evalCatalogForHostMethod(
  serviceName: string,
  methodName: string
): EvalCatalogLeaf[] {
  const id = `host:${serviceName}.${methodName}`;
  return EVAL_CAPABILITY_ACQUISITION_LEDGER.filter(
    (row) => row.rpcPlane === "host-service" && (row.id === id || row.id.startsWith(`${id}#`))
  ).map((entry) => {
    const row = entry as typeof entry & {
      rpcPlane: "host-service";
      sensitivity: EvalCatalogLeaf["sensitivity"];
      resourceDerivation: EvalCatalogLeaf["resourceDerivation"];
    };
    return {
      capability: row.capability,
      rpcPlane: row.rpcPlane,
      sensitivity: row.sensitivity,
      resourceDerivation: row.resourceDerivation,
      acquisition: row.acquisition,
    };
  }) as EvalCatalogLeaf[];
}

interface CensusEntry {
  id: string;
  capability: string;
  acquisition?: { kind: "baseline" | "approval" | "closed" };
}

export interface EvalCapabilityCensusStatus {
  closedByDefault: boolean;
  classifiedLeaves: number;
  unclassifiedIds: string[];
  wildcardCapabilities: string[];
  fixtureRejected: boolean;
  fixtureError: string;
}

/** Validate the generated eval exposure ledger with the same closed-world
 * invariant used by generation: every row is classified and no exposure uses
 * wildcard authority. Exported so diagnostics test the real invariant rather
 * than a prose claim. */
export function assertClosedEvalCapabilityCensus(
  entries: readonly CensusEntry[],
  exposedCapabilities: readonly string[]
): void {
  const unclassified = entries.filter((entry) => !entry.acquisition).map((entry) => entry.id);
  if (unclassified.length > 0) {
    throw new Error(`Unclassified eval capability leaves: ${unclassified.join(", ")}`);
  }
  const wildcards = exposedCapabilities.filter((capability) => capability.includes("*"));
  if (wildcards.length > 0) {
    throw new Error(`Wildcard eval capability exposure: ${wildcards.join(", ")}`);
  }
}

/**
 * Fail host startup when the reviewed host-service census and the live
 * dispatcher diverge. A service file that survives a cleanup without a
 * bootstrap registration is worse than dead code: docs and eval manifests
 * advertise a capability that can only fail at runtime.
 */
export function assertEvalServerCapabilityRegistrations(
  dispatcher: Pick<ServiceDispatcher, "getServiceDefinitions">
): void {
  const live = new Map(
    dispatcher
      .getServiceDefinitions()
      .map((definition) => [definition.name, new Set(Object.keys(definition.methods))])
  );
  const missing = EVAL_SERVER_HOST_METHODS.filter(
    ({ service, method }) => !live.get(service)?.has(method)
  ).map(({ service, method }) => `${service}.${method}`);
  if (missing.length > 0) {
    throw new Error(`Reviewed server capabilities are not registered: ${missing.join(", ")}`);
  }
}

/** Live, bounded proof used by operator and agent diagnostics. The synthetic
 * row verifies that the validator actually rejects an unclassified leaf. */
export function evalCapabilityCensusStatus(): EvalCapabilityCensusStatus {
  const entries = EVAL_CAPABILITY_ACQUISITION_LEDGER as readonly CensusEntry[];
  const unclassifiedIds = entries.filter((entry) => !entry.acquisition).map((entry) => entry.id);
  const exposedCapabilities = EVAL_INVOCATION_EXPOSURE_CAPABILITIES as readonly string[];
  const wildcardCapabilities = [
    ...new Set(exposedCapabilities.filter((capability) => capability.includes("*"))),
  ].sort();
  let fixtureRejected = false;
  let fixtureError = "";
  try {
    assertClosedEvalCapabilityCensus(
      [...entries, { id: "fixture:unclassified", capability: "service:fixture.unclassified" }],
      exposedCapabilities
    );
  } catch (error) {
    fixtureRejected = true;
    fixtureError = error instanceof Error ? error.message : String(error);
  }
  return {
    closedByDefault:
      unclassifiedIds.length === 0 && wildcardCapabilities.length === 0 && fixtureRejected,
    classifiedLeaves: entries.length - unclassifiedIds.length,
    unclassifiedIds,
    wildcardCapabilities,
    fixtureRejected,
    fixtureError,
  };
}
