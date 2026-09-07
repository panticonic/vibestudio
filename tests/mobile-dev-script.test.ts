import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
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
      mobileSourceRoot: "/checkouts/Base",
      readyFilePath: "/private/ready.json",
    });

    expect(args).toEqual([
      "--import",
      "tsx",
      expect.stringMatching(/src[/\\]dev[/\\]runInstance\.ts$/),
      "server",
      "--instance",
      "mobile-dev-test",
      "--base-checkout",
      "/checkouts/Base",
      "--ready-file",
      "/private/ready.json",
      "--ephemeral",
    ]);
    expect(args).not.toContain("--bootstrap-workspace");
    expect(args).not.toContain("src/server/index.ts");
  });

  it("keeps native tooling in Host while Metro reads workspace UI from Base", () => {
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

    const metro = mobileDevMetroEnvironment("/checkouts/Base", { HOST_ONLY: "retained" });
    expect(metro).toMatchObject({
      HOST_ONLY: "retained",
      REACT_NATIVE_PACKAGER_HOSTNAME: "127.0.0.1",
      VIBESTUDIO_USERLAND_ROOT: "/checkouts/Base",
      VIBESTUDIO_WORKSPACE_APP_ROOT: path.join("/checkouts/Base", "apps", "mobile"),
      VIBESTUDIO_WORKSPACE_NODE_MODULES: path.join("/checkouts/Base", "node_modules"),
    });

    const require = createRequire(import.meta.url);
    const { requireDevelopmentBaseCheckout } = require("../src/dev/developmentBaseConfig.cjs") as {
      requireDevelopmentBaseCheckout(repoRoot: string, env: Record<string, string>): string;
    };
    const selected = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-dev-base-"));
    try {
      expect(
        requireDevelopmentBaseCheckout(process.cwd(), {
          ...metro,
          VIBESTUDIO_USERLAND_ROOT: selected,
        })
      ).toBe(selected);
    } finally {
      fs.rmSync(selected, { recursive: true, force: true });
    }

    const ios = mobileDevInstallArgs({
      platform: "ios",
      device: "android-option-must-not-leak",
      noLaunch: false,
    });
    expect(ios).toEqual(
      expect.arrayContaining([
        "--platform",
        "ios",
        "--simulator",
        "--configuration",
        "Debug",
        "--launch",
      ])
    );
    expect(ios).not.toContain("--device");
  });
});
