import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRemoteHeadlessHostEntryPath } from "./remoteHeadlessHost.js";

describe("resolveRemoteHeadlessHostEntryPath", () => {
  it("uses the one canonical bundled entry beneath the application root", () => {
    expect(resolveRemoteHeadlessHostEntryPath({ VIBESTUDIO_APP_ROOT: "/opt/vibestudio" })).toBe(
      path.join("/opt/vibestudio", "dist", "headless-host", "index.js")
    );
  });

  it("allows an explicit entry override without introducing fallback candidates", () => {
    expect(
      resolveRemoteHeadlessHostEntryPath({
        VIBESTUDIO_APP_ROOT: "/ignored",
        VIBESTUDIO_HEADLESS_HOST_ENTRY: "./fixtures/headless-entry.mjs",
      })
    ).toBe(path.resolve("./fixtures/headless-entry.mjs"));
  });
});
