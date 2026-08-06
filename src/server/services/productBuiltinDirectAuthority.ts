import type { PrincipalKind, RpcAuthorityEffect } from "@vibestudio/rpc";
import {
  productBuiltinByIdentity,
  productBuiltinMethodPolicy,
} from "@vibestudio/shared/productBuiltinCatalog.generated";

/**
 * Resolve the host-facing authority for a product-owned workspace service.
 *
 * Product services are not repeated in workspace/meta/vibestudio.yml. They
 * still participate in the same direct-DO authority protocol as user-declared
 * services, so the host must project their generated catalog entry before it
 * mints an attestation.
 */
export function productBuiltinDirectAuthority(input: {
  source: string;
  className: string;
  method: string;
}): {
  capability: string;
  methodEffect: RpcAuthorityEffect;
  methodCapability: string;
  methodTier: "open" | "gated" | "critical";
  principals: readonly PrincipalKind[];
  presentation: {
    domain: import("@vibestudio/shared/authority/authorityDomains").AuthorityDomainId;
    verb: import("@vibestudio/shared/authority/authorityDomains").AuthorityVerb;
    substanceKind?: import("@vibestudio/shared/approvals").OperationSubstance["kind"];
  };
  title: string;
  action: string;
  description?: string;
  declaredBy: string;
} | null {
  const service = productBuiltinByIdentity(input.source, input.className);
  if (!service || service.kind !== "service" || !service.presentation) return null;
  const method = productBuiltinMethodPolicy(input.source, input.className, input.method);
  if (!method) return null;

  return {
    capability: `workspace-service:${service.name}`,
    methodEffect: method.effect as RpcAuthorityEffect,
    methodCapability: method.capability,
    methodTier: method.tier,
    principals: service.principals as readonly PrincipalKind[],
    presentation: service.presentation,
    title: service.title,
    action: service.action,
    ...(service.description ? { description: service.description } : {}),
    declaredBy: service.source,
  };
}
