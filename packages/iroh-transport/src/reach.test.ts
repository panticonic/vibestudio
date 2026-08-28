import { describe, expect, it } from "vitest";
import { assertIrohReach, IROH_REACH_VERSION } from "./reach.js";

const ENDPOINT_ID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("Iroh reach", () => {
  it("accepts one canonical ordered HTTPS relay set", () => {
    expect(() =>
      assertIrohReach({
        endpointId: ENDPOINT_ID,
        relays: ["https://relay-one.example/", "https://relay-two.example/"],
        v: IROH_REACH_VERSION,
      })
    ).not.toThrow();
  });

  it.each([
    ["duplicates", ["https://relay.example/", "https://relay.example/"]],
    ["credentials", ["https://secret@relay.example/"]],
    ["non-HTTPS", ["http://relay.example/"]],
    ["non-canonical", ["https://relay.example"]],
  ])("rejects %s", (_name, relays) => {
    expect(() =>
      assertIrohReach({ endpointId: ENDPOINT_ID, relays, v: IROH_REACH_VERSION })
    ).toThrow();
  });

  it.each(["", "endpoint-id", ENDPOINT_ID.toUpperCase(), `${ENDPOINT_ID}00`])(
    "rejects noncanonical endpoint ID %j",
    (endpointId) => {
      expect(() =>
        assertIrohReach({
          endpointId,
          relays: ["https://relay.example/"],
          v: IROH_REACH_VERSION,
        })
      ).toThrow(/canonical 32-byte lowercase hex key/);
    }
  );
});
