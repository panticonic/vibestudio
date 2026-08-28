import { describe, expect, it } from "vitest";
import { createConnectLink, parseConnectLink, type ConnectPairing } from "./pairing.js";

const pairing: ConnectPairing = {
  endpointId: "01".repeat(32),
  relays: ["https://relay-one.example/", "https://relay-two.example/"],
  v: 4,
  code: "A".repeat(32),
  exp: 2_000_000_000_000,
};

describe("Iroh connect link", () => {
  it.each(["scheme", "https"] as const)("round-trips the canonical %s carrier", (carrier) => {
    const link = createConnectLink(pairing, carrier);
    expect(parseConnectLink(link, 1_000)).toEqual({ kind: "ok", ...pairing });
  });

  it("rejects unknown flags, trailing data, and expiry", () => {
    const link = createConnectLink(pairing);
    const payload = link.slice("vibestudio://connect/".length);
    const bytes = Buffer.from(payload, "base64url");
    bytes[0] = bytes[0]! | 1;
    expect(parseConnectLink(`vibestudio://connect/${bytes.toString("base64url")}`, 1_000)).toEqual(
      expect.objectContaining({ kind: "error" })
    );
    expect(parseConnectLink(`${link}A`, 1_000)).toEqual(expect.objectContaining({ kind: "error" }));
    expect(parseConnectLink(link, pairing.exp)).toEqual(
      expect.objectContaining({ kind: "error", reason: expect.stringMatching(/expired/i) })
    );
  });
});
