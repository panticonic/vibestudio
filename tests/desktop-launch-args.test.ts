import { describe, expect, it } from "vitest";
import fs from "node:fs";

// @ts-expect-error Script modules are plain .mjs and intentionally untyped.
import {
  isDesktopPairingArgument,
  resolveDesktopLaunchArgs,
} from "../scripts/desktop-launch-args.mjs";

describe("desktop launcher argument routing", () => {
  const pairUrl = `https://vibestudio.app/p#${"A".repeat(84)}`;
  const deepLink = `vibestudio://connect/${"A".repeat(84)}`;

  it("launches the GUI for a bare invocation", () => {
    expect(resolveDesktopLaunchArgs([])).toEqual({ wantsGui: true, args: [] });
  });

  it("launches the GUI for compact pairing carriers", () => {
    expect(resolveDesktopLaunchArgs(["open", pairUrl])).toEqual({
      wantsGui: true,
      args: [pairUrl],
    });
    expect(resolveDesktopLaunchArgs([pairUrl])).toEqual({ wantsGui: true, args: [pairUrl] });
    expect(resolveDesktopLaunchArgs([deepLink])).toEqual({ wantsGui: true, args: [deepLink] });
  });

  it("does not steal old, malformed, or ordinary CLI arguments", () => {
    expect(isDesktopPairingArgument("https://vibestudio.app/pair#old")).toBe(false);
    expect(isDesktopPairingArgument("https://vibestudio.app/p")).toBe(false);
    expect(resolveDesktopLaunchArgs(["remote", "status"])).toEqual({
      wantsGui: false,
      args: ["remote", "status"],
    });
  });

  it("is the vibestudio entry point in a built or linked source checkout", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as { bin?: Record<string, string> };

    expect(manifest.bin?.vibestudio).toBe("scripts/vibestudio-launcher.mjs");
  });
});
