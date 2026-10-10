import type { EgressProxy } from "./egressProxy.js";

type CredentialServiceEgressProxy = Pick<
  EgressProxy,
  "forwardGitHttp" | "forwardProxyFetch" | "openWebSocketScope" | "closeWebSocketScope"
>;

/** Unused egress operations fail loudly; each test supplies only what it exercises. */
export function credentialServiceEgressProxyFixture(
  overrides: Partial<CredentialServiceEgressProxy> = {}
): CredentialServiceEgressProxy {
  return {
    forwardGitHttp: async () => {
      throw new Error("Unexpected Git egress in credential service test");
    },
    forwardProxyFetch: async () => {
      throw new Error("Unexpected proxy egress in credential service test");
    },
    openWebSocketScope: () => {
      throw new Error("Unexpected WebSocket scope open in credential service test");
    },
    closeWebSocketScope: async () => {
      throw new Error("Unexpected WebSocket scope close in credential service test");
    },
    ...overrides,
  };
}
