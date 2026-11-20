import { describe, expect, it } from "vitest";
import type { CredentialBinding } from "./types.js";
import { findCredentialBinding, matchUrlBoundCredentialCandidates } from "./urlBoundSelection.js";

const url = new URL("https://records.test/archive/current");
const binding: CredentialBinding = {
  id: "archive",
  use: "fetch",
  audience: [{ url: "https://records.test/archive", match: "path-prefix" }],
  injection: { type: "header", name: "Authorization", valueTemplate: "Fixture {token}" },
};

describe("shared URL-bound credential selection", () => {
  it("keeps exchange candidates out of direct-only egress", () => {
    const owner = { userId: "member", sourceId: "member", sourceKind: "user" as const, label: "Member" };
    const exchange = { actor: "human" as const, owner, label: "owner-alias", bindings: [binding],
      agentExchange: { clientId: "test", tokenUrl: "https://records.test/token" } };
    const direct = { actor: "agent" as const, label: "agent-alias", bindings: [binding] };
    const caller = { userId: "member", agentId: "worker" };
    const records = [exchange, direct];
    expect(matchUrlBoundCredentialCandidates(records, url, "fetch", caller).candidates).toEqual(records);
    expect(matchUrlBoundCredentialCandidates(records, url, "fetch", caller, { directOnly: true }).candidates)
      .toEqual([direct]);
    expect(matchUrlBoundCredentialCandidates([exchange], url, "fetch", caller, { directOnly: true }))
      .toEqual({ audienceMatches: [exchange], candidates: [], refusal: null });
  });

  it("keeps missing or empty explicit bindings unbound", () => {
    expect(findCredentialBinding({}, url, "fetch")).toBeNull();
    expect(findCredentialBinding({ bindings: [] }, url, "fetch")).toBeNull();
    expect(findCredentialBinding({ bindings: [binding] }, url, "git-http")).toBeNull();
  });
});
