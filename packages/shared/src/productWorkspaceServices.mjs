/**
 * Reviewed product-owned workspace services.
 *
 * These services are part of the installed host topology, not declarations a
 * workspace can replace. Runtime resolution and authority generation both
 * consume this catalog so a sealed service cannot exist without a matching,
 * reviewable authority declaration.
 */
export const PRODUCT_WORKSPACE_SERVICES = deepFreeze([
  {
    kind: "durable-object",
    name: "gad.workspace",
    title: "GAD workspace graph",
    description: "Product-sealed semantic workspace authority",
    protocols: ["vibestudio.gad.workspace.v1"],
    source: "vibestudio/internal",
    authority: { principals: ["host", "user", "code"] },
    durableObject: {
      className: "GadWorkspaceDO",
      objectKey: "workspace-semantic-control-plane",
    },
  },
]);

assertValidCatalog(PRODUCT_WORKSPACE_SERVICES);

export function findProductWorkspaceService(query) {
  return (
    PRODUCT_WORKSPACE_SERVICES.find(
      (service) => service.name === query || service.protocols.includes(query)
    ) ?? null
  );
}

function assertValidCatalog(services) {
  const queryKeys = new Set();
  for (const service of services) {
    if (service.authority.principals.length === 0) {
      throw new Error(`Product workspace service ${service.name} declares no principals`);
    }
    for (const key of [service.name, ...service.protocols]) {
      if (queryKeys.has(key)) {
        throw new Error(`Duplicate product workspace service query key: ${key}`);
      }
      queryKeys.add(key);
    }
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
