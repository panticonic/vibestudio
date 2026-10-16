import { describe, expect, it } from "vitest";
import { encodeRpcJson } from "@vibestudio/rpc";
import type { ClientCapability } from "@vibestudio/workspace-contracts/clients";
import { createClientBroker } from "./clientBroker";

function setup(granted: ClientCapability[]) {
  let held = granted;
  const calls: string[] = [];
  const broker = createClientBroker({
    granted: () => held,
    handlers: {
      "state.get": (key) => {
        calls.push(`state.get:${key}`);
        return "v";
      },
      "clipboard.setString": (text) => {
        calls.push(`clipboard:${text}`);
      },
      "device.reset": () => {
        throw Object.assign(new Error("nope"), { code: "RESET_REFUSED" });
      },
    },
  });
  return { broker, calls, revoke: (next: ClientCapability[]) => (held = next) };
}

const args = (...values: unknown[]) => encodeRpcJson(values);

describe("client capability broker", () => {
  it("runs a method that needs no capability", async () => {
    const t = setup([]);
    const outcome = await t.broker.handle("state.get", args("k"));
    expect(outcome).toEqual({ ok: true, resultJson: encodeRpcJson("v") });
    expect(t.calls).toEqual(["state.get:k"]);
  });

  it("refuses a method whose capability is not granted, without running it", async () => {
    const t = setup(["notifications"]);
    const outcome = await t.broker.handle("clipboard.setString", args("x"));
    expect(outcome).toMatchObject({ ok: false, code: "CAPABILITY_NOT_GRANTED" });
    expect(t.calls).toEqual([]);
  });

  it("reads the grants at the moment of the call, so a revocation applies at once", async () => {
    const t = setup(["clipboard"]);
    expect((await t.broker.handle("clipboard.setString", args("a"))).ok).toBe(true);
    t.revoke([]);
    expect(await t.broker.handle("clipboard.setString", args("b"))).toMatchObject({
      ok: false,
      code: "CAPABILITY_NOT_GRANTED",
    });
    expect(t.calls).toEqual(["clipboard:a"]);
  });

  it("returns void results as JSON null", async () => {
    const t = setup(["clipboard"]);
    expect(await t.broker.handle("clipboard.setString", args("a"))).toEqual({
      ok: true,
      resultJson: "null",
    });
  });

  it("refuses unknown methods, unimplemented methods and malformed arguments", async () => {
    const t = setup(["device-session", "clipboard"]);
    expect(await t.broker.handle("keychain.read", args())).toMatchObject({
      ok: false,
      code: "UNKNOWN_METHOD",
    });
    expect(await t.broker.handle("__proto__", args())).toMatchObject({ code: "UNKNOWN_METHOD" });
    expect(await t.broker.handle("state.keys", args())).toMatchObject({
      ok: false,
      code: "UNKNOWN_METHOD",
    });
    expect(await t.broker.handle("clipboard.setString", encodeRpcJson({ not: "array" }))).toMatchObject({
      ok: false,
      code: "BAD_REQUEST",
    });
  });

  it("carries a handler's own failure code back to the client", async () => {
    const t = setup(["device-session"]);
    expect(await t.broker.handle("device.reset", args())).toMatchObject({
      ok: false,
      code: "RESET_REFUSED",
      message: "nope",
    });
  });
});
