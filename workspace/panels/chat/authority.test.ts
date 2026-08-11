import { describe, expect, it } from "vitest";
import manifest from "./package.json";

describe("chat panel authority", () => {
  it("can request approval to configure an OAuth client from client eval", () => {
    expect(
      manifest.vibestudio.authority.requests.find(
        (request) => request.capability === "account-providers.configure"
      )
    ).toEqual({
      capability: "account-providers.configure",
      resource: { kind: "exact", key: "account-providers.configure" },
      tier: "gated",
      evidence: "exact",
    });
  });

  it("can request a destination-scoped external browser approval from client eval", () => {
    expect(
      manifest.vibestudio.authority.requests.find(
        (request) => request.capability === "external.open"
      )
    ).toEqual({
      capability: "external.open",
      resource: { kind: "prefix", prefix: "" },
      tier: "gated",
      evidence: "intentional-broad",
    });
  });
});
