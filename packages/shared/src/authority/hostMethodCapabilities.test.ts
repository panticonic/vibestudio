import { describe, expect, it } from "vitest";
import { hostCapabilityMethods, hostMethodCapability } from "./hostMethodCapabilities.js";
import { METHOD_TIERS } from "./tierTable.js";

describe("host method capability projection", () => {
  it("keeps proxyFetch as an open transport instead of a generic credential prompt", () => {
    expect(METHOD_TIERS["credentials.proxyFetch"].tier).toBe("open");
    expect(hostMethodCapability("credentials.proxyFetch")).toBeNull();
    expect(hostCapabilityMethods("credential.use")).not.toContain("credentials.proxyFetch");
  });
});
