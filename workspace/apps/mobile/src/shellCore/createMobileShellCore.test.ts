import { createMobileShellCore } from "./createMobileShellCore";

describe("createMobileShellCore", () => {
  it("publishes asynchronous panel presentation changes from its registry", () => {
    jest.useFakeTimers();
    const onPresentationUpdated = jest.fn();
    const core = createMobileShellCore({
      workspaceId: "workspace-test",
      serverUrl: "http://127.0.0.1:3000/_workspace/workspace-test",
      transport: { call: jest.fn() } as never,
      onPresentationUpdated,
    });

    core.registry.notifyPanelTreeUpdate("panel:tree/new");
    jest.advanceTimersByTime(16);

    expect(onPresentationUpdated).toHaveBeenCalledWith({
      revision: 1,
      panelIds: ["panel:tree/new"],
    });
    jest.useRealTimers();
  });
});
