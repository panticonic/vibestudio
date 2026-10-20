import { describe, expect, it } from "vitest";
import {
  CLOSE_CLIENT_PRINCIPALS_ROUTE,
  createCloseClientPrincipalsRoute,
} from "./clientPrincipalRoutes.js";
import { RouteRegistry } from "./routeRegistry.js";

describe("close-principals route", () => {
  it("is reachable at the URL the hub posts to", () => {
    const registry = new RouteRegistry();
    registry.registerHttpServiceRoutes([
      createCloseClientPrincipalsRoute({ retireClientPrincipalSessions: () => 0 }),
    ]);
    const resolved = registry.lookup(CLOSE_CLIENT_PRINCIPALS_ROUTE, "POST", false);
    expect(resolved).toMatchObject({ kind: "service", serviceName: "sessions" });
  });
});
