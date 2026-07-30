import { describe, expect, it } from "vitest";
import {
  generatedHostCapabilityMethods,
  generatedHostMethodAuthority,
} from "./hostAuthorityCatalog.generated.js";

describe("host method capability projection", () => {
  it("keeps proxyFetch as an open transport instead of a generic credential prompt", () => {
    expect(generatedHostMethodAuthority("credentials.proxyFetch")?.tier.tier).toBe("open");
    expect(generatedHostMethodAuthority("credentials.proxyFetch")?.capability).toBeNull();
    expect(generatedHostCapabilityMethods("credential.use")).not.toContain(
      "credentials.proxyFetch"
    );
  });
});
