import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

import {
  createPrivateGuestGlobal,
  isCodegenReachable,
  tameRealmCodegen,
} from "./evalConfinement.js";

/** A real second realm, tamed the way an evaluator bootstrap would tame it. */
function tamedRealm(): Record<string, unknown> {
  const context = vm.createContext({});
  const realm = vm.runInContext("globalThis", context) as Record<string, unknown>;
  tameRealmCodegen(realm);
  return realm;
}

describe("tameRealmCodegen", () => {
  it("closes the constructor-chain route back to a compiler", () => {
    const context = vm.createContext({});
    const realm = vm.runInContext("globalThis", context) as Record<string, unknown>;
    const reachBefore = vm.runInContext(
      `() => ({}).constructor.constructor("return typeof globalThis")()`,
      context
    ) as () => string;
    expect(reachBefore()).toBe("object");

    tameRealmCodegen(realm);

    expect(() => reachBefore()).toThrow(TypeError);
    for (const source of [
      `({}).constructor.constructor("return 1")`,
      `(async function () {}).constructor("return 1")`,
      `(function * () {}).constructor("return 1")`,
      `(async function * () {}).constructor("return 1")`,
      `Function("return 1")`,
      `eval("1")`,
    ]) {
      expect(() => vm.runInContext(source, context)).toThrow(TypeError);
    }
    expect(isCodegenReachable(realm)).toBe(false);
  });

  it("keeps prototypes intact so ordinary type checks still work", () => {
    const context = vm.createContext({});
    tameRealmCodegen(vm.runInContext("globalThis", context) as Record<string, unknown>);

    expect(
      vm.runInContext(`[typeof (() => {}) === "function", (() => {}) instanceof Function]`, context)
    ).toEqual([true, true]);
  });

  it("hands the compile capability back to the bootstrap that tamed the realm", () => {
    const context = vm.createContext({});
    const realm = vm.runInContext("globalThis", context) as Record<string, unknown>;
    const compiler = tameRealmCodegen(realm);

    expect((new compiler("return 1") as unknown as () => number)()).toBe(1);
    expect(tameRealmCodegen(realm)).toBe(compiler);
  });
});

describe("createPrivateGuestGlobal", () => {
  it("refuses a realm whose values still lead back to a compiler", () => {
    expect(() => createPrivateGuestGlobal(globalThis as unknown as Record<string, unknown>)).toThrow(
      /compile code/
    );
  });


  it("preserves the receiver required by allowlisted host functions", () => {
    const realm = {
      setTimeout: vi.fn(function (this: unknown) {
        if (this !== realm) throw new TypeError("illegal receiver");
        return 42;
      }),
    } as unknown as Record<string, unknown>;

    const guest = createPrivateGuestGlobal(realm);
    expect((guest["setTimeout"] as () => number)()).toBe(42);
  });

  it("does not reveal unreviewed ambient authority", () => {
    const realm = tamedRealm();
    realm["fetch"] = () => undefined;
    realm["process"] = {};
    const guest = createPrivateGuestGlobal(realm);

    expect(guest["fetch"]).toBeUndefined();
    expect(guest["process"]).toBeUndefined();
    expect(guest["Function"]).toBeUndefined();
    expect(guest["Array"]).toBe(realm["Array"]);
    expect(guest["globalThis"]).toBe(guest);
    expect(guest["self"]).toBe(guest);
  });

  it("exposes logging through an immutable receiver-bound facade", () => {
    const realmConsole = {
      info: vi.fn(function (this: unknown, message: string) {
        if (this !== realmConsole) throw new TypeError("illegal receiver");
        return message;
      }),
      privateMethod: vi.fn(),
    };
    const guest = createPrivateGuestGlobal({ console: realmConsole });
    const guestConsole = guest["console"] as Record<string, (...args: unknown[]) => unknown>;

    expect(guestConsole["info"]?.("ready")).toBe("ready");
    expect(guestConsole["privateMethod"]).toBeUndefined();
    expect(Object.isFrozen(guestConsole)).toBe(true);
    expect(() => {
      guestConsole["info"] = () => undefined;
    }).toThrow();
  });
});
