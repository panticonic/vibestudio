import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { freezeModuleNamespace } from "./moduleNamespace.js";

describe("freezeModuleNamespace", () => {
  it("freezes the export namespace without freezing stateful exported class prototypes", () => {
    const exports = { EventEmitter };
    freezeModuleNamespace(exports);
    expect(Object.isFrozen(exports)).toBe(true);
    expect(Object.isFrozen(EventEmitter.prototype)).toBe(false);
    const emitter = new EventEmitter();
    emitter.on("ready", () => undefined);
    expect(emitter.listenerCount("ready")).toBe(1);
  });
});
