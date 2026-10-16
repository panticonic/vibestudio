import { describe, expect, it } from "vitest";
import { createWebsiteConnectionIntent } from "./websiteConnectionIntent.js";

function fixture() {
  let active = true;
  const listeners = new Map<string, EventListener>();
  const document = {
    addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  } as Pick<Document, "addEventListener" | "removeEventListener">;
  const gate = createWebsiteConnectionIntent(document, () => active);
  return {
    gate,
    listeners,
    expire: () => {
      active = false;
    },
    input: (trusted: boolean, type = "click", repeat = false) =>
      listeners.get(type)?.({ type, isTrusted: trusted, repeat } as unknown as Event),
  };
}

describe("website connection intent", () => {
  it("requires fresh trusted input, even while browser transient activation remains active", () => {
    const f = fixture();
    expect(() => f.gate.consume()).toThrow(/Choose Connect/);
    f.input(false);
    expect(() => f.gate.consume()).toThrow(/Choose Connect/);
    f.input(true);
    f.gate.consume();
    // Denial does not restore a consumed input or leave a background retry budget.
    expect(() => f.gate.consume()).toThrow(/Choose Connect/);
    f.input(true);
    f.gate.consume();
    f.input(true, "keydown", true);
    expect(() => f.gate.consume()).toThrow(/Choose Connect/);
    f.input(true, "keydown");
    f.gate.consume();
  });

  it("does not retain activation after the browser expiry or document retirement", () => {
    const f = fixture();
    f.input(true);
    f.expire();
    expect(() => f.gate.consume()).toThrow(/Choose Connect/);
    f.gate.close();
    expect(f.listeners.size).toBe(0);
    expect(() => f.gate.consume()).toThrow(/Choose Connect/);
  });
});
