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
  harness: { unit: string; ev: string };
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
      serviceMethods: [],
      userlandServices: { discovery: "bound", bindings: [] },
      network: { mode: "none" },
    };
  }
  const toolExposure = charter.execution.toolExposure;
  const exactMethods = toolExposure.services.filter((entry) => !entry.endsWith(".*"));
  const serviceMethods = [
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
  return { serviceMethods: uniqueMethods, userlandServices, network };
}

export function compiledExposureAllowsService(
  exposure: CompiledExecutionExposure,
  qualifiedMethod: string
): boolean {
  if (
    (qualifiedMethod === "workers.resolveService" ||
      qualifiedMethod === "workers.resolveDurableObject") &&
    (exposure.userlandServices.discovery === "live-declarations" ||
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
