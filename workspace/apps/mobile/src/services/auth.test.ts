import {
  NativeModules,
} from "react-native";
import {
  activatePreparedAppBundle,
  clearCredentials,
  isWorkspaceMobileHostCallerId,
  resetToNativeBootstrap,
} from "./auth";

const nativeHost = NativeModules.VibestudioMobileHost as {
  clearCredentials: jest.Mock;
  resetToNativeBootstrap: jest.Mock;
  activatePreparedAppBundle: jest.Mock;
};

describe("native host control seam", () => {
  beforeEach(() => {
    nativeHost.clearCredentials.mockReset().mockResolvedValue(undefined);
    nativeHost.resetToNativeBootstrap.mockReset().mockResolvedValue({ reloading: true });
    nativeHost.activatePreparedAppBundle.mockReset().mockResolvedValue({ activated: false });
  });

  it("clears native credentials", async () => {
    await clearCredentials();
    expect(nativeHost.clearCredentials).toHaveBeenCalled();
  });

  it("resets to the shipped bootstrap", async () => {
    await expect(resetToNativeBootstrap()).resolves.toEqual({ reloading: true });
    expect(nativeHost.resetToNativeBootstrap).toHaveBeenCalled();
  });

  it("validates reset response shape", async () => {
    nativeHost.resetToNativeBootstrap.mockResolvedValueOnce({});
    await expect(resetToNativeBootstrap()).rejects.toThrow(/invalid bootstrap reset/);
  });

  it("activates a prepared app bundle", async () => {
    await activatePreparedAppBundle({
      localPath: "/bundle.js",
      buildKey: "build_1",
      integrity: "sha256-ok",
    });
    expect(nativeHost.activatePreparedAppBundle).toHaveBeenCalledWith(
      "/bundle.js",
      "build_1",
      "sha256-ok"
    );
  });

  it("validates activation response shape", async () => {
    nativeHost.activatePreparedAppBundle.mockResolvedValueOnce({});
    await expect(
      activatePreparedAppBundle({
        localPath: "/bundle.js",
        buildKey: "build_1",
        integrity: "sha256-ok",
      })
    ).rejects.toThrow(/invalid app bundle activation/);
  });

  it("recognizes mobile host caller ids", () => {
    expect(isWorkspaceMobileHostCallerId("shell:dev_1", "dev_1")).toBe(true);
    expect(isWorkspaceMobileHostCallerId("app:apps/mobile:dev_1", "dev_1")).toBe(true);
    expect(isWorkspaceMobileHostCallerId("panel:p1", "dev_1")).toBe(false);
  });
});
