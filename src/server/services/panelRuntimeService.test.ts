import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import { createPanelRuntimeService } from "./panelRuntimeService.js";

describe("panelRuntimeService", () => {
  it("accepts headless CDP-capable clients with stable host ids", async () => {
    const coordinator = {
      registerClient: vi.fn(),
      unregisterClient: vi.fn(),
      getSnapshot: vi.fn(),
      acquire: vi.fn(),
      takeOver: vi.fn(),
      release: vi.fn(),
    };
    const service = createPanelRuntimeService({ coordinator: coordinator as never });
    const input = {
      clientSessionId: "headless-session",
      hostConnectionId: "headless-host",
      label: "Headless",
      platform: "headless",
      loadOnLeaseAssignment: true,
      supportsCdp: true,
    };

    expect(() => service.methods["registerClient"]?.args.parse([input])).not.toThrow();
    await service.handler(
      { caller: createVerifiedCaller("shell:desktop", "shell") },
      "registerClient",
      [input]
    );

    expect(coordinator.registerClient).toHaveBeenCalledWith({
      ...input,
      ownerCallerId: "shell:desktop",
    });
  });

  it("accepts lease requests that carry a provider host id", () => {
    const service = createPanelRuntimeService({ coordinator: {} as never });

    expect(() =>
      service.methods["acquire"]?.args.parse([
        "panel:entity",
        {
          slotId: "slot",
          clientSessionId: "headless-session",
          connectionId: "runtime-connection",
          hostConnectionId: "headless-host",
        },
      ])
    ).not.toThrow();
  });

  it("forwards client unregister requests to the coordinator", async () => {
    const coordinator = {
      registerClient: vi.fn(),
      unregisterClient: vi.fn(),
      getSnapshot: vi.fn(),
      acquire: vi.fn(),
      takeOver: vi.fn(),
      release: vi.fn(),
    };
    const service = createPanelRuntimeService({ coordinator: coordinator as never });

    expect(() =>
      service.methods["unregisterClient"]?.args.parse(["headless-session"])
    ).not.toThrow();
    await service.handler(
      { caller: createVerifiedCaller("shell:desktop", "shell") },
      "unregisterClient",
      ["headless-session"]
    );

    expect(coordinator.unregisterClient).toHaveBeenCalledWith("headless-session");
  });
});
