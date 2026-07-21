import type { AuthorityGrant, Principal, PrincipalKind } from "@vibestudio/rpc";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { getProductBootManifest } from "../internalDOs/productBootManifest.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { PRODUCT_AUTHORITY_GRANT_CATALOG } from "./productAuthorityGrantCatalog.generated.js";
import { PRODUCT_DIRECT_AUTHORITY_CAPABILITIES } from "./productDirectAuthorityCapabilities.generated.js";
import { EXTENSION_RUNTIME_BASE_CAPABILITIES } from "@vibestudio/shared/authorityManifest";

// P0 ADMISSION INPUT — scheduled to freeze in docs/capability-model-redesign.md
// P2. This compatibility resolver is retained only until the redesigned grant
// store owns capability acquisition; additions require explicit catalog review.

export interface ProductGrantInput {
  caller: VerifiedCaller;
  principals: Partial<Record<PrincipalKind, Principal | null>>;
  capability: string;
  resourceKey: string;
  sessionId: string;
  now: number;
  grantStore?: CapabilityGrantStore;
  grantCode?: boolean;
}

/**
 * Resolve reviewed product/selector grants plus live user decisions. The
 * catalog contains exact host-service methods, so registering a new method
 * never grants it. Code grants additionally bind to the verified source line
 * and exact digest carried by `caller.code`.
 */
export function productAuthorityGrants(input: ProductGrantInput): AuthorityGrant[] {
  const grants: AuthorityGrant[] = [];
  for (const kind of ["host", "user", "device", "entity"] as const) {
    const subject = input.principals[kind];
    if (!subject || !productPrincipalHasCapability(kind, input.capability)) continue;
    grants.push(productGrant(subject, input.capability, input.resourceKey, input.now));
  }

  const code = input.principals.code;
  const identity = input.caller.code;
  if (!code || !identity || input.grantCode === false) return grants;
  const grantSubject = {
    callerId: identity.callerId,
    repoPath: identity.repoPath,
    effectiveVersion: identity.effectiveVersion,
  };

  // The shared childRuntime performs this tiny activation protocol for every
  // verified extension build, including extensions created after the checked-
  // in product catalog was generated. The build must still have sealed the
  // request; this grant only supplies the other half of that intersection.
  const runtimeAllows =
    identity.callerKind === "extension" &&
    EXTENSION_RUNTIME_BASE_CAPABILITIES.includes(input.capability);
  const productAllows =
    runtimeAllows || productCodeHasCapability(identity.repoPath, input.capability);
  const userAllows = input.grantStore?.hasGrant(input.capability, input.resourceKey, grantSubject);
  if (productAllows || userAllows) {
    grants.push({
      ...productGrant(code, input.capability, input.resourceKey, input.now),
      provenance: runtimeAllows
        ? "extension-runtime-authority-v1"
        : productAllows
          ? "product-authority-catalog-v1"
          : "user-capability-grant",
    });
  }
  if (input.grantStore?.hasDenial(input.capability, input.resourceKey, grantSubject)) {
    grants.push({
      ...productGrant(code, input.capability, input.resourceKey, input.now),
      effect: "deny",
      provenance: "user-capability-denial",
    });
  }
  return grants;
}

export function productCodeHasCapability(repoPath: string, capability: string): boolean {
  const exact = PRODUCT_AUTHORITY_GRANT_CATALOG.codeCapabilitiesBySource[
    repoPath as keyof typeof PRODUCT_AUTHORITY_GRANT_CATALOG.codeCapabilitiesBySource
  ] as readonly string[] | undefined;
  if (!exact?.includes(capability)) return false;
  if (capability.startsWith("workspace-service:")) {
    return workspaceServicePrincipals(capability).includes("code");
  }
  if (capability.startsWith("rpc:")) {
    return (PRODUCT_DIRECT_AUTHORITY_CAPABILITIES as readonly string[]).includes(capability);
  }
  return true;
}

export function productPrincipalHasCapability(
  kind: Exclude<PrincipalKind, "code">,
  capability: string
): boolean {
  if (
    [
      "panel-hosting",
      "window-management",
      "open-external",
      "native-menus",
      "notifications",
    ].includes(capability)
  ) {
    return kind === "host" || kind === "user";
  }
  if (capability === "devHost.admin") return kind === "host" || kind === "user";
  if (capability.startsWith("workspace-service:")) {
    return workspaceServicePrincipals(capability).includes(kind);
  }
  return (
    PRODUCT_AUTHORITY_GRANT_CATALOG.principalCapabilities[kind] as readonly string[]
  ).includes(capability);
}

function workspaceServicePrincipals(capability: string): readonly PrincipalKind[] {
  const name = capability.slice("workspace-service:".length);
  return (
    PRODUCT_AUTHORITY_GRANT_CATALOG.workspaceServicePrincipalsByName[
      name as keyof typeof PRODUCT_AUTHORITY_GRANT_CATALOG.workspaceServicePrincipalsByName
    ] ?? []
  );
}

function productGrant(
  subject: Principal,
  capability: string,
  resourceKey: string,
  now: number
): AuthorityGrant {
  return {
    subject,
    capability,
    resource: { kind: "exact", key: resourceKey },
    effect: "allow",
    issuedBy: getProductBootManifest().hostPrincipal,
    createdAt: now,
    binding: { kind: "principal" },
    provenance: "product-authority-catalog-v1",
  };
}
