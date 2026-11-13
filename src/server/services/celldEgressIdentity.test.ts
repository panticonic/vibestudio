import { describe, expect, it } from "vitest";
import {
  celldEgressSubject,
  signCelldEgress,
  verifyCelldEgress,
  type CelldEgressIdentity,
} from "./celldEgressIdentity.js";

const SECRET = "node-egress-secret-0123456789";

function verify(
  headers: Record<string, string>,
  over: Partial<Parameters<typeof verifyCelldEgress>[0]> = {}
) {
  return verifyCelldEgress({
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    kind: "fetch",
    method: "GET",
    target: "http://127.0.0.1:1234/x",
    secret: SECRET,
    ...over,
  });
}

function stamp(identity: Partial<CelldEgressIdentity> & { loaded: boolean }) {
  return signCelldEgress({
    secret: SECRET,
    kind: "fetch",
    method: "GET",
    target: "http://127.0.0.1:1234/x",
    identity,
  });
}

describe("celld egress identity", () => {
  it("verifies a stamped request and decodes its identity", () => {
    const identity = verify(stamp({ loaded: true, egressIdentity: ["worker:a"] }));
    expect(identity).toMatchObject({ loaded: true, egressIdentity: ["worker:a"], v: 1 });
  });

  it("refuses a wrong secret, kind, method, target or missing header", () => {
    const headers = stamp({ loaded: true, egressIdentity: ["worker:a"] });
    expect(verify(headers, { secret: "a-different-secret-entirely" })).toBeNull();
    expect(verify(headers, { kind: "websocket" })).toBeNull();
    expect(verify(headers, { method: "POST" })).toBeNull();
    expect(verify(headers, { target: "http://127.0.0.1:1234/y" })).toBeNull();
    for (const name of Object.keys(headers)) {
      const { [name]: _dropped, ...rest } = headers;
      expect(verify(rest)).toBeNull();
    }
  });

  it("refuses an identity edited after it was stamped", () => {
    const headers = stamp({ loaded: true, egressIdentity: ["worker:a"] });
    const forged = Buffer.from(
      JSON.stringify({ v: 1, deployment: "d", script: "s", loaded: true, class: null, cell: null, root: null, egressIdentity: ["worker:admin"] })
    ).toString("base64url");
    expect(verify({ ...headers, "x-celld-egress-identity": forged })).toBeNull();
  });

  it("refuses a MAC of the wrong length and a malformed identity that is validly signed", () => {
    const headers = stamp({ loaded: true, egressIdentity: ["worker:a"] });
    expect(verify({ ...headers, "x-celld-egress-mac": "AAAA" })).toBeNull();
    // Signed, but not an identity.
    const bad = signCelldEgress({
      secret: SECRET,
      kind: "fetch",
      method: "GET",
      target: "http://127.0.0.1:1234/x",
      identity: { loaded: true, egressIdentity: [5 as unknown as string] },
    });
    expect(verify(bad)).toBeNull();
  });

  it("maps identities: loaded code to its loader's choice, product classes to their principal, host programs", () => {
    const decode = (identity: Partial<CelldEgressIdentity> & { loaded: boolean }) =>
      celldEgressSubject(verify(stamp(identity))!);
    expect(decode({ loaded: true, egressIdentity: ["do-code:s:C:v", "inner"] })).toEqual({
      kind: "caller",
      callerId: "do-code:s:C:v",
    });
    expect(decode({ loaded: true, egressIdentity: [] })).toBeNull();
    expect(decode({ loaded: false, class: "WebhookStoreDO" })).toEqual({
      kind: "caller",
      callerId: "do-service:vibestudio/internal:WebhookStoreDO",
    });
    expect(decode({ loaded: false, class: null })).toEqual({ kind: "host-program" });
    expect(decode({ loaded: false, class: "UniversalDO" })).toEqual({ kind: "host-program" });
  });
});
