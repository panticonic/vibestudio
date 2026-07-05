/**
 * `serviceWithHttpRoutes` — ManagedService adapter for service factories that
 * expose both an RPC `ServiceDefinition` and HTTP `/_r/s/...` routes.
 *
 * Server-local because route concerns don't belong in `@vibestudio/shared`.
 * Factories that need to expose HTTP routes (auth's OAuth callback, blobstore,
 * credentials; more later) return the `{ definition, routes? }` pair; bootstrap
 * wraps it with this helper so the RPC definition lands on the dispatcher (via
 * the container lifecycle) AND the HTTP routes land on the route registry in
 * one `container.registerManaged(...)` declaration.
 *
 * RPC vs HTTP route: the `definition` is registered as an RPC service on the
 * ServiceDispatcher; the `routes` are registered as HTTP `/_r/s/<name>/...`
 * routes on the RouteRegistry. These are two distinct mechanisms.
 *
 * Failure semantics: `stop()` unregisters routes, but only runs on clean
 * shutdown (container.stopAll). On crash / SIGKILL the registry entries go
 * with the process — the registry is in-memory, so this is self-cleaning
 * on next start. No persistent orphans.
 *
 * Startup failure: if `container.startAll()` crashes mid-way AFTER this
 * service's `start()` registered routes but before other services are up,
 * `stopAll` will still fire the `stop()` hook as part of the cleanup
 * cascade, so routes unregister correctly.
 */

import type { ManagedService } from "@vibestudio/shared/managedService";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { RouteRegistry, ServiceRouteDecl } from "./routeRegistry.js";

export interface ServiceWithRoutes {
  definition: ServiceDefinition;
  routes?: ServiceRouteDecl[];
  start?: () => void | Promise<void>;
  stop?: () => void | Promise<void>;
}

/**
 * Turn a `{ definition, routes? }` factory output into a ManagedService that
 * registers the RPC definition on the dispatcher (via the container) and the
 * HTTP routes on the shared route registry. HTTP routes are registered only
 * when `routes.length > 0`. Route registration runs at `container.startAll()`
 * time, unregistration in `stop()`.
 *
 * Register the returned service with `container.registerManaged(...)`.
 */
export function serviceWithHttpRoutes(
  pair: ServiceWithRoutes,
  routeRegistry: RouteRegistry,
  deps?: string[]
): ManagedService {
  const serviceName = pair.definition.name;
  const routes = pair.routes ?? [];
  const hasRoutes = routes.length > 0;
  return {
    name: serviceName,
    dependencies: deps,
    async start() {
      await pair.start?.();
      if (hasRoutes) {
        routeRegistry.registerHttpServiceRoutes(routes);
      }
    },
    async stop() {
      if (hasRoutes) {
        routeRegistry.unregisterHttpServiceRoutes(serviceName);
      }
      await pair.stop?.();
    },
    getServiceDefinition() {
      return pair.definition;
    },
  };
}
