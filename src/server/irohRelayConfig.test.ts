import { describe, expect, it } from "vitest";
import { DEFAULT_IROH_RELAYS, resolveIrohRelayUrls } from "./irohRelayConfig.js";

describe("Iroh relay configuration", () => {
  it("uses the public Iroh relay topology by default", () => {
    expect(resolveIrohRelayUrls(undefined)).toEqual([
      "https://use1-1.relay.n0.iroh.link/",
      "https://euc1-1.relay.n0.iroh.link/",
    ]);
    expect(resolveIrohRelayUrls(undefined)).not.toBe(DEFAULT_IROH_RELAYS);
  });

  it("honors an explicit relay topology", () => {
    expect(resolveIrohRelayUrls("https://relay.example/,https://relay-eu.example/")).toEqual([
      "https://relay.example/",
      "https://relay-eu.example/",
    ]);
  });
});
