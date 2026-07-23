import { describe, expect, it } from "vitest";
import { ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import { createPhoneProvisioningService } from "./phoneProvisioningService.js";

describe("desktop phone provisioning service", () => {
  it("registers its aliased receiver methods from colocated semantic capabilities", () => {
    const definition = createPhoneProvisioningService({
      appRoot: "/nonexistent/vibestudio-test-root",
      appVersion: "test",
      resolveScriptPath: (name) => name,
      runScript: async () => ({ stdout: "", stderr: "" }),
    });
    const dispatcher = new ServiceDispatcher({
      tierLookup: () => null,
      capabilityLookup: () => null,
    });

    expect(() => dispatcher.registerService(definition)).not.toThrow();
  });
});
