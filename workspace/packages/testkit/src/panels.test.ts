import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runtimeOpenPanel: vi.fn(),
}));

vi.mock("@workspace/runtime", () => ({
  openPanel: mocks.runtimeOpenPanel,
  panelTree: {
    self() {
      throw new Error("no self in unit test");
    },
  },
}));
vi.mock("./cdp.js", () => ({
  withCdpSession: vi.fn(),
  _registerDriverRoute: vi.fn(),
}));

describe("testkit panel helpers", () => {
  beforeEach(() => {
    mocks.runtimeOpenPanel.mockReset();
    mocks.runtimeOpenPanel.mockResolvedValue({
      id: "panel:test",
    });
  });

  it("delegates readiness to the runtime's boot-ready open operation", async () => {
    const { openPanel } = await import("./panels.js");

    await openPanel("about/testbench");

    expect(mocks.runtimeOpenPanel).toHaveBeenCalledOnce();
  });

  it("keeps canonical RPC endpoint identity in polling diagnostics", async () => {
    const { waitFor } = await import("./panels.js");
    const error = Object.assign(new Error('Method "_agent.snapshot" is not exposed by this endpoint'), {
      errorData: {
        kind: "rpc-endpoint",
        endpointId: "panel:nav-stale",
        requestedMethod: "_agent.snapshot",
      },
    });

    await expect(
      waitFor(
        () => {
          throw error;
        },
        { timeoutMs: 0, label: "snapshot" }
      )
    ).rejects.toThrow(
      'last error: Method "_agent.snapshot" is not exposed by this endpoint (endpoint=panel:nav-stale, method=_agent.snapshot)'
    );
  });
});
