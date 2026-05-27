import { createBridgeAdapter } from "./bridgeAdapter";

function createAdapter() {
  return createBridgeAdapter({
    panelManager: {} as never,
    registry: {} as never,
    transport: {} as never,
    callbacks: { navigateToPanel: jest.fn() },
  });
}

describe("bridgeAdapter CDP routing", () => {
  it.each(["getCdpEndpoint", "navigate", "goBack", "goForward", "stop"] as const)(
    "rejects legacy mobile CDP fast-path method %s",
    async (method) => {
      const adapter = createAdapter();

      await expect(adapter.handle("panel-a", method, ["panel-b"])).rejects.toThrow(
        "CDP automation is routed through the server broker"
      );
    }
  );
});
