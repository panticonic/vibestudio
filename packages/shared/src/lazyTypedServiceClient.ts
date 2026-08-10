import type {
  ServiceCallFn,
  ServiceMethodSchemas,
  TypedServiceClient,
} from "./typedServiceClient.js";

export type ServiceMethodSchemaLoader<M extends ServiceMethodSchemas> = () => Promise<M>;

/**
 * Construct the same complete, enumerable surface as `createTypedServiceClient`
 * without importing the schema validator on the startup path. The first call
 * single-flights both modules, then delegates to the one canonical validated
 * dispatch implementation.
 */
export function createLazyTypedServiceClient<M extends ServiceMethodSchemas>(
  service: string,
  methodNames: readonly (keyof M & string)[],
  loadMethods: ServiceMethodSchemaLoader<M>,
  call: ServiceCallFn
): TypedServiceClient<M> {
  let methodsPromise: Promise<M> | undefined;
  const methods = (): Promise<M> => (methodsPromise ??= loadMethods());
  const root: Record<string, unknown> = {};
  for (const fullName of methodNames) {
    const segments = fullName.split(".");
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      const next = (node[segment] ??= {});
      if (typeof next !== "object" || next === null) {
        throw new Error(
          `Service "${service}" method "${fullName}" collides with non-group method "${segment}"`
        );
      }
      node = next as Record<string, unknown>;
    }
    const leaf = segments[segments.length - 1]!;
    if (node[leaf] !== undefined) {
      throw new Error(`Service "${service}" method "${fullName}" collides with group "${leaf}"`);
    }
    node[leaf] = async (...args: unknown[]) => {
      const [{ callTypedServiceMethod }, loadedMethods] = await Promise.all([
        import("./typedServiceClient.js"),
        methods(),
      ]);
      return callTypedServiceMethod(service, loadedMethods, call, fullName, args);
    };
  }
  return root as TypedServiceClient<M>;
}
