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

describe("testkit panel helpers", () => {
  beforeEach(() => {
    mocks.runtimeOpenPanel.mockReset();
    mocks.runtimeOpenPanel.mockResolvedValue({
      id: "panel:test",
    });
  });

  it("delegates readiness to the runtime's boot-ready open operation", async () => {
    const { openPanel } = await import("./panels.js");

    await openPanel("panels/testbench");

    expect(mocks.runtimeOpenPanel).toHaveBeenCalledOnce();
  });
});
