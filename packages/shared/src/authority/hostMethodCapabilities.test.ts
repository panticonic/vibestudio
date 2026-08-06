import { describe, expect, it } from "vitest";
import {
  generatedHostCapabilityMethods,
  generatedHostMethodAuthority,
} from "./hostAuthorityCatalog.generated.js";

describe("host method capability projection", () => {
  it("keeps credential-aware transports open until they resolve a concrete use", () => {
    for (const method of ["credentials.proxyFetch", "credentials.proxyGitHttp"]) {
      expect(generatedHostMethodAuthority(method)?.tier.tier).toBe("open");
      expect(generatedHostMethodAuthority(method)?.capability).toBeNull();
      expect(generatedHostCapabilityMethods("credential.use")).not.toContain(method);
    }
  });
});
