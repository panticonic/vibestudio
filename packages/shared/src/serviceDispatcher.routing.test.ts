import { describe, expect, it, vi } from "vitest";
import { ServiceDispatcher } from "./serviceDispatcher.js";

describe("ServiceDispatcher ownership", () => {
  it("reports only explicitly registered local endpoints", () => {
    const dispatcher = new ServiceDispatcher();
    dispatcher.registerService({
      name: "local",
      authority: { principals: ["user", "code"] },
      methods: {},
      handler: vi.fn(),
    });
    expect(dispatcher.hasService("local")).toBe(true);
    expect(dispatcher.hasService("not-registered")).toBe(false);
  });
});
