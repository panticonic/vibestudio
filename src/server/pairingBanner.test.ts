import { describe, expect, it } from "vitest";
import { createConnectDeepLink, type ConnectPairing } from "@vibestudio/shared/connect";
import { formatPairUrlLine } from "./pairingBanner";

describe("server pairing banner", () => {
  it("formats the Pair URL line with the canonical Iroh deep link", () => {
    const pairing: ConnectPairing = {
      endpointId: "aa".repeat(32),
      relays: ["https://relay.example/"],
      code: "A".repeat(22),
      v: 5,
    };
    expect(formatPairUrlLine(pairing)).toBe(`  Pair URL:     ${createConnectDeepLink(pairing)}`);
  });
});
