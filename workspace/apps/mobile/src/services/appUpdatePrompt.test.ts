import { handleMobileAppLifecycleEvent, type AppUpdatePromptDeps } from "./appUpdatePrompt";
import type { ShellClient } from "./shellClient";

function makeDeps(overrides: Partial<AppUpdatePromptDeps> = {}): {
  deps: AppUpdatePromptDeps;
  alert: jest.Mock;
  ensureBundle: jest.Mock;
} {
  const alert = jest.fn();
  const ensureBundle = jest.fn().mockResolvedValue(undefined);
  const shellClient = { transport: { streamReadable: jest.fn() } } as unknown as ShellClient;
  const deps: AppUpdatePromptDeps = {
    shellClient,
    pushToast: jest.fn(),
    prompted: new Set<string>(),
    selectedSource: null,
    selectedAppId: null,
    alert: alert as unknown as typeof import("react-native").Alert.alert,
    ensureBundle: ensureBundle as unknown as AppUpdatePromptDeps["ensureBundle"],
    ...overrides,
  };
  return { deps, alert, ensureBundle };
}

describe("handleMobileAppLifecycleEvent (update-available)", () => {
  it("surfaces both versions when the server reports a transition", () => {
    const { deps, alert } = makeDeps();
    handleMobileAppLifecycleEvent(
      {
        type: "update-available",
        appId: "apps/mobile",
        buildKey: "build-2",
        executionDigest: "1.2.0",
        previousSourceDigest: "1.1.0",
        previousBuildKey: "build-1",
      },
      deps
    );
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][1]).toBe("apps/mobile v1.1.0 → v1.2.0 is ready to install.");
  });

  it("surfaces just the target version when no previous version is known", () => {
    const { deps, alert } = makeDeps();
    handleMobileAppLifecycleEvent(
      { type: "update-available", appId: "apps/mobile", buildKey: "build-2", executionDigest: "1.2.0" },
      deps
    );
    expect(alert.mock.calls[0][1]).toBe("apps/mobile v1.2.0 is ready to install.");
  });

  it("falls back to generic copy when no versions are reported", () => {
    const { deps, alert } = makeDeps();
    handleMobileAppLifecycleEvent(
      { type: "update-available", appId: "apps/mobile", buildKey: "build-2" },
      deps
    );
    expect(alert.mock.calls[0][1]).toBe("apps/mobile has a new trusted bundle ready to install.");
  });

  it("ignores a no-op event whose build is already the running build", () => {
    const { deps, alert } = makeDeps();
    handleMobileAppLifecycleEvent(
      {
        type: "update-available",
        appId: "apps/mobile",
        buildKey: "build-1",
        previousBuildKey: "build-1",
      },
      deps
    );
    expect(alert).not.toHaveBeenCalled();
  });

  it("prompts only once per build key", () => {
    const { deps, alert } = makeDeps();
    const event = {
      type: "update-available" as const,
      appId: "apps/mobile",
      buildKey: "build-2",
      executionDigest: "1.2.0",
    };
    handleMobileAppLifecycleEvent(event, deps);
    handleMobileAppLifecycleEvent(event, deps);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("installs through the active WebRTC transport", () => {
    const { deps, alert, ensureBundle } = makeDeps();
    handleMobileAppLifecycleEvent(
      { type: "update-available", appId: "apps/mobile", buildKey: "build-2", source: "apps/mobile" },
      deps
    );
    const buttons = alert.mock.calls[0][2];
    buttons[1].onPress();
    expect(ensureBundle).toHaveBeenCalledWith(deps.shellClient.transport, "apps/mobile");
  });
});
