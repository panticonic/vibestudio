import type { PrincipalKind } from "@vibestudio/rpc";
import { PRODUCT_WORKSPACE_SERVICES } from "@vibestudio/shared/productWorkspaceServices.mjs";

const INTERNAL_DO_SOURCE = "vibestudio/internal";
const PRINCIPAL_KINDS: ReadonlySet<string> = new Set(["host", "user", "device", "code", "entity"]);

export interface ReviewedInternalDurableObjectTarget {
  source: typeof INTERNAL_DO_SOURCE;
  className: string;
  objectKey: string;
  authority: {
    capability: string;
    principals: readonly PrincipalKind[];
  };
}

/**
 * Exact internal Durable Object targets exposed through the raw
 * `workers.resolveDurableObject` API.
 *
 * Product workspace services contribute their already-reviewed singleton
 * identity and compositional authority. Other internal implementation stores
 * must be listed explicitly, including their one permitted object key. Merely
 * exporting an internal DO class never makes arbitrary instances resolvable.
 */
export const REVIEWED_INTERNAL_DURABLE_OBJECT_TARGETS: readonly ReviewedInternalDurableObjectTarget[] =
  deepFreeze([
    ...PRODUCT_WORKSPACE_SERVICES.filter(
      (service) => service.kind === "durable-object" && service.source === INTERNAL_DO_SOURCE
    ).map((service) => ({
      source: service.source as typeof INTERNAL_DO_SOURCE,
      className: service.durableObject.className,
      objectKey: service.durableObject.objectKey,
      authority: {
        capability: `workspace-service:${service.name}`,
        principals: service.authority.principals as readonly PrincipalKind[],
      },
    })),
    {
      source: INTERNAL_DO_SOURCE,
      className: "BrowserDataDO",
      objectKey: "global",
      authority: {
        capability: "service:workers.resolveDurableObject",
        principals: ["code"],
      },
    },
  ]);

assertValidCatalog(REVIEWED_INTERNAL_DURABLE_OBJECT_TARGETS);

export function findReviewedInternalDurableObjectTarget(
  source: string,
  className: string,
  objectKey: string
): ReviewedInternalDurableObjectTarget | null {
  return (
    REVIEWED_INTERNAL_DURABLE_OBJECT_TARGETS.find(
      (target) =>
        target.source === source && target.className === className && target.objectKey === objectKey
    ) ?? null
  );
}

function assertValidCatalog(targets: readonly ReviewedInternalDurableObjectTarget[]): void {
  const identities = new Set<string>();
  for (const target of targets) {
    if (target.source !== INTERNAL_DO_SOURCE) {
      throw new Error(
        `Reviewed internal Durable Object target has non-internal source ${target.source}`
      );
    }
    if (
      !target.className ||
      target.className === "*" ||
      !target.objectKey ||
      target.objectKey === "*" ||
      !target.authority.capability ||
      target.authority.principals.length === 0 ||
      target.authority.principals.some((principal) => !PRINCIPAL_KINDS.has(principal))
    ) {
      throw new Error(
        `Reviewed internal Durable Object target ${target.className}:${target.objectKey} has invalid identity or authority`
      );
    }
    const identity = `${target.source}:${target.className}:${target.objectKey}`;
    if (identities.has(identity)) {
      throw new Error(`Duplicate reviewed internal Durable Object target ${identity}`);
    }
    identities.add(identity);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
