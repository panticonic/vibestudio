import { describe, expect, it } from "vitest";
import { createConnectLink, parseConnectLink, type ConnectPairing } from "./pairing.js";
import { DEFAULT_IROH_RELAYS, IROH_REACH_VERSION } from "./reach.js";

const pairing: ConnectPairing = {
  endpointId: "01".repeat(32),
  relays: DEFAULT_IROH_RELAYS,
  v: IROH_REACH_VERSION,
  code: "A".repeat(22),
};

describe("Iroh connect link", () => {
  it.each(["scheme", "https"] as const)("round-trips the canonical %s carrier", (carrier) => {
    const link = createConnectLink(pairing, carrier);
    expect(parseConnectLink(link)).toEqual({ kind: "ok", ...pairing, relays: [...pairing.relays] });
  });

  it("encodes the public relay profile as a 91-character URL", () => {
    expect(createConnectLink(pairing, "https")).toHaveLength(91);
  });

  it("round-trips custom relay coordinates inline", () => {
    const custom = { ...pairing, relays: ["https://relay-one.example/"] };
    expect(parseConnectLink(createConnectLink(custom))).toEqual({ kind: "ok", ...custom });
  });

  it("rejects invalid relay profiles and trailing data", () => {
    const link = createConnectLink(pairing);
    const payload = link.slice("vibestudio://connect/".length);
    const bytes = Buffer.from(payload, "base64url");
    bytes[0] = bytes[0]! | 9;
    expect(parseConnectLink(`vibestudio://connect/${bytes.toString("base64url")}`)).toEqual(
      expect.objectContaining({ kind: "error" })
    );
    expect(parseConnectLink(`${link}A`)).toEqual(expect.objectContaining({ kind: "error" }));
  });
});
