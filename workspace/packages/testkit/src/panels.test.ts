import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureLoaded: vi.fn(async () => ({ loaded: true })),
  isLoaded: vi.fn(async () => true),
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
    mocks.ensureLoaded.mockClear();
    mocks.isLoaded.mockClear();
    mocks.runtimeOpenPanel.mockReset();
    mocks.runtimeOpenPanel.mockResolvedValue({
      id: "panel:test",
      ensureLoaded: mocks.ensureLoaded,
      isLoaded: mocks.isLoaded,
    });
  });

  it("requests a runtime lease before waiting for a panel to report loaded", async () => {
    const { openPanel } = await import("./panels.js");

    await openPanel("panels/testbench");

    expect(mocks.ensureLoaded).toHaveBeenCalledTimes(1);
    expect(mocks.isLoaded).toHaveBeenCalledTimes(1);
    expect(mocks.ensureLoaded.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.isLoaded.mock.invocationCallOrder[0]!
    );
  });

  it("allows callers to opt out of loading and waiting", async () => {
    const { openPanel } = await import("./panels.js");

    await openPanel("panels/testbench", { waitLoaded: false });

    expect(mocks.ensureLoaded).not.toHaveBeenCalled();
    expect(mocks.isLoaded).not.toHaveBeenCalled();
  });
});
