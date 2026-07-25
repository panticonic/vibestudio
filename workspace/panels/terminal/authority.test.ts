import { describe, expect, it } from "vitest";
import manifest from "./package.json";

describe("terminal panel authority", () => {
  it("can request a destination-scoped external browser approval for URL fallbacks", () => {
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
