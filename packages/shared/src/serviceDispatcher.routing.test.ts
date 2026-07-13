import { describe, expect, it, vi } from "vitest";
import { ServiceDispatcher } from "./serviceDispatcher.js";

describe("ServiceDispatcher host routing metadata", () => {
  it("routes registered services to the host unless their definition keeps the caller on-session", () => {
    const dispatcher = new ServiceDispatcher();
    dispatcher.registerService({
      name: "local",
      policy: { allowed: ["shell", "app", "panel"] },
      methods: {},
      handler: vi.fn(),
    });
    dispatcher.registerService({
      name: "session-owned",
      hostRouting: { panel: "session" },
      policy: { allowed: ["shell", "app", "panel"] },
      methods: {},
      handler: vi.fn(),
    });

    expect(dispatcher.routesToHost("local", "panel")).toBe(true);
    expect(dispatcher.routesToHost("session-owned", "panel")).toBe(false);
    expect(dispatcher.routesToHost("session-owned", "app")).toBe(true);
    expect(dispatcher.routesToHost("not-registered", "panel")).toBe(false);
  });
});
