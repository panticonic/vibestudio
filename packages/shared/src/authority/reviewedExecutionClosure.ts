import { compareUtf16CodeUnits } from "@vibestudio/content-addressing";
import { createHash } from "node:crypto";
import type { ResourceScope } from "@vibestudio/rpc";
import { canonicalJson } from "../canonicalJson.js";
import type { MissionCharter } from "./mission.js";

export interface CompiledUserlandServiceBinding {
  name: string;
  provider: string;
  providerEv: string;
  upgradePolicy: "pinned" | "follow-head";
}

export interface CompiledExecutionExposure {
  serviceMethods: readonly string[];
  /** Userland services needed by the sealed execution harness itself. Optional
   * only when reading closures created before this distinction existed. */
  harnessUserlandServices?: readonly string[];
  userlandServices:
    | { discovery: "live-declarations"; bindings: readonly [] }
    | {
        discovery: "bound";
        bindings: readonly CompiledUserlandServiceBinding[];
      };
  network:
    | { mode: "none" }
    | { mode: "unrestricted" }
    | { mode: "declared-origins"; origins: readonly string[] };
}

export interface ReviewedExecutionClosureGrant {
  effect: "allow" | "deny";
  capability: string;
  resource: ResourceScope;
  tier: "gated" | "critical";
}

export interface ReviewedExecutionClosureDependency {
  subject: string;
  capability: string;
  resource: ResourceScope;
}

export interface ReviewedExecutionClosureBody {
  subjectPrefix: string;
  exposure: CompiledExecutionExposure;
  harness: { unit: string; ev: string; ref?: string };
  grants: readonly ReviewedExecutionClosureGrant[];
  grantDependencies: readonly ReviewedExecutionClosureDependency[];
  lineageClasses: readonly string[];
  owner: string;
  issuer: string;
  sourceDocument: {
    kind: string;
    id: string;
    revision: number;
    digest: string;
  };
}

/** Runtime plumbing used by every durable automation harness. These methods
 * are part of executing the reviewed target, not tools selected by the action.
 * Ordinary authority still intersects this exposure with the exact caller's
 * fixed-code declarations and resource policy. */
const HARNESS_SERVICE_METHODS = [
  "workspace-state.alarmClear",
  "workspace-state.alarmSet",
  "workspace-state.lifecycleLeaseClear",
  "workspace-state.lifecycleLeaseUpsert",
] as const;

/** Host services causally used by the ordinary agent loop itself. They make
 * the reviewed harness executable; they do not expose authored action tools.
 * Gated methods here still need a standing grant or ordinary approval. */
const AGENT_HARNESS_SERVICE_METHODS = [
  "blobstore.getText",
  "blobstore.putText",
  "contextIntegrity.ingest",
  "credentials.resolveCredential",
  "eval.cancel",
  "eval.get",
  "eval.start",
] as const;

/** The standard agent conversation harness is the agent plus its durable
 * channel and the channel's workspace/context provider. These are causal
 * execution dependencies, independent of tools exposed to the action. */
const AGENT_HARNESS_USERLAND_SERVICES = [
  "channel",
  "gad.workspace",
  "workspace.state",
] as const;
const METHOD_HARNESS_USERLAND_SERVICES = ["workspace.state"] as const;

export function compileMissionHarnessGrants(
  charter: MissionCharter
): readonly ReviewedExecutionClosureGrant[] {
  const names =
    charter.execution.kind === "agent"
      ? AGENT_HARNESS_USERLAND_SERVICES
      : METHOD_HARNESS_USERLAND_SERVICES;
  return names.map((name) => ({
    effect: "allow" as const,
    capability: `workspace-service:${name}`,
    resource: { kind: "prefix" as const, prefix: "" },
    tier: "gated" as const,
  }));
}

export function reviewedExecutionClosureDigest(body: ReviewedExecutionClosureBody): string {
  return createHash("sha256")
    .update("reviewed-execution-closure-v1\0", "utf8")
    .update(canonicalJson(body), "utf8")
    .digest("hex");
}

/**
 * Compile a domain document into the exact, immutable exposure record consumed
 * by the kernel. Wildcards are expanded here and never interpreted in the
 * authorization hot path.
 */
export function compileMissionExposure(
  charter: MissionCharter,
  knownServiceMethods: readonly string[]
): CompiledExecutionExposure {
  if (charter.execution.kind === "method") {
    return {
      serviceMethods: [...HARNESS_SERVICE_METHODS],
      harnessUserlandServices: [...METHOD_HARNESS_USERLAND_SERVICES],
      userlandServices: { discovery: "bound", bindings: [] },
      network: { mode: "none" },
    };
  }
  const toolExposure = charter.execution.toolExposure;
  const exactMethods = toolExposure.services.filter((entry) => !entry.endsWith(".*"));
  const serviceMethods = [
    ...HARNESS_SERVICE_METHODS,
    ...AGENT_HARNESS_SERVICE_METHODS,
    ...exactMethods,
    ...knownServiceMethods.filter((method) =>
      toolExposure.services.some(
        (entry) => entry.endsWith(".*") && method.startsWith(entry.slice(0, -1))
      )
    ),
  ].sort(compareUtf16CodeUnits);
  const uniqueMethods = [...new Set(serviceMethods)];
  const userlandServices =
    toolExposure.workspaceServiceDiscovery === "live-declarations"
      ? ({ discovery: "live-declarations", bindings: [] } as const)
      : ({
          discovery: "bound",
          bindings: [...toolExposure.userlandServices]
            .map((binding) => ({ ...binding }))
            .sort((a, b) => {
              const byName = compareUtf16CodeUnits(a.name, b.name);
              return byName || compareUtf16CodeUnits(a.provider, b.provider);
            }),
        } as const);
  const network =
    toolExposure.evalNetwork === "declared-origins"
      ? ({
          mode: "declared-origins",
          origins: [...new Set(toolExposure.declaredOrigins)].sort(compareUtf16CodeUnits),
        } as const)
      : ({ mode: toolExposure.evalNetwork } as { mode: "none" } | { mode: "unrestricted" });
  return {
    serviceMethods: uniqueMethods,
    harnessUserlandServices: [...AGENT_HARNESS_USERLAND_SERVICES],
    userlandServices,
    network,
  };
}

export function compiledExposureAllowsService(
  exposure: CompiledExecutionExposure,
  qualifiedMethod: string
): boolean {
  if (
    (qualifiedMethod === "workers.resolveService" ||
      qualifiedMethod === "workers.resolveDurableObject") &&
    ((exposure.harnessUserlandServices?.length ?? 0) > 0 ||
      exposure.userlandServices.discovery === "live-declarations" ||
      exposure.userlandServices.bindings.length > 0)
  ) {
    return true;
  }
  return exposure.serviceMethods.includes(qualifiedMethod);
}

export function compiledExposureAllowsUserlandService(
  exposure: CompiledExecutionExposure,
  input: { name: string; provider: string; providerEv: string }
): boolean {
  if (exposure.harnessUserlandServices?.includes(input.name)) return true;
  if (exposure.userlandServices.discovery === "live-declarations") return true;
  const binding = exposure.userlandServices.bindings.find(
    (candidate) => candidate.name === input.name && candidate.provider === input.provider
  );
  return Boolean(
    binding && (binding.upgradePolicy === "follow-head" || binding.providerEv === input.providerEv)
  );
}

export function compiledExposureNetworkRedirectPolicy(
  exposure: CompiledExecutionExposure,
  origin: string
): "deny" | "allow" | "allow-without-redirects" {
  if (exposure.network.mode === "none") return "deny";
  if (exposure.network.mode === "unrestricted") return "allow";
  return exposure.network.origins.includes(origin) ? "allow-without-redirects" : "deny";
}
