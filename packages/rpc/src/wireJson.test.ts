import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { decodeRpcJson, encodeRpcJson } from "./wireJson.js";

const roundTrip = (value: unknown) => decodeRpcJson(encodeRpcJson(value));

describe("RPC wire JSON codec", () => {
  it("carries Uint8Array, Buffer, and ArrayBuffer values as Uint8Array at any depth", () => {
    const backing = new Uint8Array([9, 0, 1, 255, 9]);
    const decoded = roundTrip({
      args: [backing.subarray(1, 4), { nested: [Buffer.from("héllo")] }],
      buffer: new Uint8Array([7, 8]).buffer,
      empty: new Uint8Array(0),
    }) as {
      args: [Uint8Array, { nested: [Uint8Array] }];
      buffer: Uint8Array;
      empty: Uint8Array;
    };
    expect(decoded.args[0]).toBeInstanceOf(Uint8Array);
    expect([...decoded.args[0]]).toEqual([0, 1, 255]);
    expect(new TextDecoder().decode(decoded.args[1].nested[0])).toBe("héllo");
    expect([...decoded.buffer]).toEqual([7, 8]);
    expect(decoded.empty).toEqual(new Uint8Array(0));
  });

  it("recognizes ArrayBuffer internal slots across realms without trusting tags", () => {
    const buffer: unknown = runInNewContext("new Uint8Array([4, 5]).buffer");
    expect(roundTrip(buffer)).toEqual(new Uint8Array([4, 5]));
    expect(roundTrip(new ArrayBuffer(0))).toEqual(new Uint8Array(0));
    expect(roundTrip({ value: 1, [Symbol.toStringTag]: "ArrayBuffer" })).toEqual({ value: 1 });
  });

  it("never reinterprets a user object as bytes", () => {
    const forged = { "\u0000bytes": "AAE=" };
    const nested = { "\u0000\u0000bytes": "x", "\u0000other": 1, plain: true };
    const legacy = { __bin: true, data: "AAE=" };
    expect(roundTrip(forged)).toEqual(forged);
    expect(roundTrip(nested)).toEqual(nested);
    expect(roundTrip(legacy)).toEqual(legacy);
    expect(roundTrip({ $schema: "s", $ref: "#/x" })).toEqual({ $schema: "s", $ref: "#/x" });
    const spoofed = { 0: 65, length: 1, [Symbol.toStringTag]: "Uint8Array" };
    expect(roundTrip(spoofed)).toEqual({ 0: 65, length: 1 });
  });

  it("rejects unescaped reserved keys and unsupported typed arrays", () => {
    expect(() => decodeRpcJson('{"\\u0000bytes":1}')).toThrow(/Malformed RPC byte value/);
    expect(() => decodeRpcJson('{"\\u0000bytes":"AA==","x":1}')).toThrow(/reserved key/);
    expect(() => encodeRpcJson({ value: new Float32Array(1) })).toThrow(/Float32Array/);
    expect(() => decodeRpcJson('{"\\u0000bytes":"AA"}')).toThrow(/Malformed RPC byte value/);
    expect(() => encodeRpcJson(undefined)).toThrow(/not JSON serializable/);
  });

  it("does not let an escaped __proto__ key change the prototype", () => {
    const decoded = decodeRpcJson('{"\\u0000\\u0000x":1,"__proto__":{"polluted":true}}') as Record<
      string,
      unknown
    >;
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});
