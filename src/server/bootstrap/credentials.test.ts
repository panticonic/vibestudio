import { EventService } from "@vibestudio/shared/eventsService";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { ServiceContainer } from "@vibestudio/shared/serviceContainer";
import { ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import { describe, expect, it } from "vitest";
import { RouteRegistry } from "../routeRegistry.js";
import { wireCredentialService, type CredentialBootstrapDeps } from "./credentials.js";

describe("wireCredentialService", () => {
  it("constructs and registers the credential service through the host container", async () => {
    const dispatcher = new ServiceDispatcher();
    const container = new ServiceContainer(dispatcher);
    const inert = {};

    const service = wireCredentialService({
      container,
      routeRegistry: new RouteRegistry(),
      eventService: new EventService(),
      entityCache: new EntityCache(),
      dispatcher,
      credentialStore: inert as CredentialBootstrapDeps["credentialStore"],
      clientConfigStore: inert as CredentialBootstrapDeps["clientConfigStore"],
      auditLog: inert as CredentialBootstrapDeps["auditLog"],
      egressProxy: inert as CredentialBootstrapDeps["egressProxy"],
      disposableGitHttp: inert as CredentialBootstrapDeps["disposableGitHttp"],
      approvalQueue: inert as CredentialBootstrapDeps["approvalQueue"],
      sessionGrantStore: inert as CredentialBootstrapDeps["sessionGrantStore"],
      credentialUseGrantStore: inert as CredentialBootstrapDeps["credentialUseGrantStore"],
      credentialLifecycle: inert as CredentialBootstrapDeps["credentialLifecycle"],
      hasConnectedShell: () => false,
      getAuthorizingShell: () => null,
      hasAppCapability: () => false,
    });

    expect(service.name).toBe("credentials");
    expect(dispatcher.hasService("credentials")).toBe(false);
    await container.startAll();
    expect(dispatcher.hasService("credentials")).toBe(true);
    await container.stopAll();
  });
});
