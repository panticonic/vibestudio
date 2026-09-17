import { describe, expect, it } from "vitest";
import { adbCandidates, vibestudioCacheDir } from "../scripts/cli/lib/android-platform-tools.mjs";
describe("shared Android tooling resolution", () => {
  it("uses explicit tools, SDKs, exact version cache, then PATH for both discovery and install", () => {
    expect(
      adbCandidates(
        {
          ADB: "/custom/adb",
          ANDROID_SDK_ROOT: "/sdk",
          ANDROID_HOME: "/sdk",
          XDG_CACHE_HOME: "/cache",
        },
        "linux"
      )
    ).toEqual([
      "/custom/adb",
      "/sdk/platform-tools/adb",
      "/cache/vibestudio/android-platform-tools/36.0.0/platform-tools/adb",
      "adb",
    ]);
  });
  it("uses the Windows application cache and executable without requiring an SDK", () => {
    expect(vibestudioCacheDir({ LOCALAPPDATA: "/local" }, "win32")).toBe("/local/vibestudio");
    expect(adbCandidates({ LOCALAPPDATA: "/local" }, "win32")).toEqual([
      "/local/vibestudio/android-platform-tools/36.0.0/platform-tools/adb.exe",
      "adb.exe",
    ]);
  });
});
