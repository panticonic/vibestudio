import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  mobileDevInstallArgs,
  mobileDevMetroEnvironment,
  mobileDevServerArgs,
} from "../scripts/cli/mobile-dev.mjs";

describe("mobile dev process composition", () => {
  it("delegates ephemeral server ownership to the developer-instance supervisor", () => {
    const args = mobileDevServerArgs({
      instanceId: "mobile-dev-test",
      templateCheckoutRoot: "/checkouts/templates",
      readyFilePath: "/private/ready.json",
    });

    expect(args).toEqual([
      "--import",
      "tsx",
      expect.stringMatching(/src[/\\]dev[/\\]runInstance\.ts$/),
      "server",
      "--instance",
      "mobile-dev-test",
      "--template-checkouts",
      "/checkouts/templates",
      "--ready-file",
      "/private/ready.json",
      "--ephemeral",
      "--lifetime",
      "leased",
    ]);
    expect(args).not.toContain("--bootstrap-workspace");
    expect(args).not.toContain("src/server/index.ts");
  });

  it("keeps native tooling and Metro host-only", () => {
    const android = mobileDevInstallArgs({
      platform: "android",
      device: "emulator-5554",
      noLaunch: true,
    });
    expect(android[0]).toBe(path.resolve("scripts", "cli", "mobile-install.mjs"));
    expect(android).toEqual(
      expect.arrayContaining([
        "--platform",
        "android",
        "--from-source",
        "--device",
        "emulator-5554",
      ])
    );
    expect(android).not.toContain("--app-root");

    const metro = mobileDevMetroEnvironment({ HOST_ONLY: "retained" });
    expect(metro).toEqual({ HOST_ONLY: "retained", REACT_NATIVE_PACKAGER_HOSTNAME: "127.0.0.1" });

    const ios = mobileDevInstallArgs({
      platform: "ios",
      device: "simulator-udid",
      noLaunch: false,
    });
    expect(ios).toEqual(
      expect.arrayContaining([
        "--platform",
        "ios",
        "--simulator",
        "--configuration",
        "Debug",
        "--device",
        "simulator-udid",
        "--launch",
      ])
    );
  });
});
