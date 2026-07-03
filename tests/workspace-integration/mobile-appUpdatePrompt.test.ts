import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
}));

vi.mock("../../workspace/apps/mobile/src/services/appBootstrap", () => ({
  ensureNativeWorkspaceAppBundle: vi.fn(async () => ({ reloading: true })),
}));

const { handleMobileAppLifecycleEvent } = await import(
  "../../workspace/apps/mobile/src/services/appUpdatePrompt"
);

describe("mobile app update prompt", () => {
  it("prompts once for a mobile app update and installs on request", async () => {
    const alert = vi.fn();
    const ensureBundle = vi.fn(async () => ({ reloading: true }));
    const pushToast = vi.fn();
    const shellClient = { workspaces: { rollbackApp: vi.fn() } } as never;

    handleMobileAppLifecycleEvent(
      { type: "update-available", appId: "apps/mobile", buildKey: "rn-2", canRollback: false },
      { shellClient, pushToast, prompted: new Set(), alert, ensureBundle },
    );

    const buttons = alert.mock.calls[0]?.[2] as Array<{ text: string; onPress?: () => void }>;
    expect(buttons.map((button) => button.text)).toEqual(["Later", "Install"]);
    buttons.find((button) => button.text === "Install")?.onPress?.();
    await Promise.resolve();
    expect(ensureBundle).toHaveBeenCalledTimes(1);
  });

  it("rolls back then installs the rolled-back bundle", async () => {
    const alert = vi.fn();
    const ensureBundle = vi.fn(async () => ({ reloading: true }));
    const rollbackApp = vi.fn(async () => ({ ok: true }));
    const pushToast = vi.fn();
    const shellClient = { workspaces: { rollbackApp } } as never;

    handleMobileAppLifecycleEvent(
      { type: "update-available", appId: "apps/mobile", buildKey: "rn-2", canRollback: true },
      { shellClient, pushToast, prompted: new Set(), alert, ensureBundle },
    );

    const buttons = alert.mock.calls[0]?.[2] as Array<{ text: string; onPress?: () => void }>;
    buttons.find((button) => button.text === "Roll back")?.onPress?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(rollbackApp).toHaveBeenCalledWith("apps/mobile");
    expect(ensureBundle).toHaveBeenCalledTimes(1);
  });

  it("surfaces update and rollback failures", async () => {
    const alert = vi.fn();
    const ensureBundle = vi.fn(async () => {
      throw new Error("bundle failed");
    });
    const rollbackApp = vi.fn(async () => {
      throw new Error("rollback failed");
    });
    const pushToast = vi.fn();
    const shellClient = { workspaces: { rollbackApp } } as never;

    handleMobileAppLifecycleEvent(
      { type: "update-available", appId: "apps/mobile", buildKey: "rn-2", canRollback: true },
      { shellClient, pushToast, prompted: new Set(), alert, ensureBundle },
    );
    const buttons = alert.mock.calls[0]?.[2] as Array<{ text: string; onPress?: () => void }>;
    buttons.find((button) => button.text === "Install")?.onPress?.();
    buttons.find((button) => button.text === "Roll back")?.onPress?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Update failed",
      message: "bundle failed",
    }));
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Rollback failed",
      message: "rollback failed",
    }));
  });

  it("ignores updates for non-mobile app targets", () => {
    const alert = vi.fn();
    const pushToast = vi.fn();
    const shellClient = { workspaces: { rollbackApp: vi.fn() } } as never;

    handleMobileAppLifecycleEvent(
      {
        type: "update-available",
        appId: "@workspace-apps/shell",
        source: "apps/shell",
        target: "electron",
        buildKey: "desktop-2",
        canRollback: true,
      },
      { shellClient, pushToast, prompted: new Set(), alert },
    );

    expect(alert).not.toHaveBeenCalled();
    expect(pushToast).not.toHaveBeenCalled();
  });
});
