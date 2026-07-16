import type { AuthorityGrant, Principal, PrincipalKind } from "@vibestudio/rpc";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { getProductBootManifest } from "../internalDOs/productBootManifest.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { PRODUCT_AUTHORITY_GRANT_CATALOG } from "./productAuthorityGrantCatalog.generated.js";
import { PRODUCT_DIRECT_AUTHORITY_CAPABILITIES } from "./productDirectAuthorityCapabilities.generated.js";

const USERLAND_SERVICE_PRINCIPALS = {
  "gad.workspace": ["code", "user", "host"],
  vcs: ["code", "user", "host", "entity"],
  channel: ["code", "user", "host", "entity"],
  models: ["code", "user", "host"],
  "testkit-driver": ["code", "user", "host"],
} as const satisfies Record<string, readonly PrincipalKind[]>;

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
    principal: code,
    sessionId: input.sessionId,
    code: { repoPath: identity.repoPath, executionDigest: identity.executionDigest },
  } as const;

  const productAllows = productCodeHasCapability(identity.repoPath, input.capability);
  const userAllows = input.grantStore?.hasGrant(input.capability, input.resourceKey, grantSubject);
  if (productAllows || userAllows) {
    grants.push({
      ...productGrant(code, input.capability, input.resourceKey, input.now),
      provenance: productAllows ? "product-authority-catalog-v1" : "user-capability-grant",
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
  if (capability.startsWith("userland-service:")) {
    return userlandPrincipals(capability).includes("code");
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
  if (capability.startsWith("userland-service:")) {
    return userlandPrincipals(capability).includes(kind);
  }
  return (
    PRODUCT_AUTHORITY_GRANT_CATALOG.principalCapabilities[kind] as readonly string[]
  ).includes(capability);
}

function userlandPrincipals(capability: string): readonly PrincipalKind[] {
  const name = capability.slice("userland-service:".length);
  return USERLAND_SERVICE_PRINCIPALS[name as keyof typeof USERLAND_SERVICE_PRINCIPALS] ?? [];
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
