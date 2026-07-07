import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const script = path.join(process.cwd(), "scripts", "cli", "ios-entitlements.mjs");

function generate(env: Record<string, string | undefined>, configuration = "Debug"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-ios-entitlements-"));
  const output = path.join(dir, "Generated.entitlements");
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  delete childEnv.VIBESTUDIO_IOS_APS_ENV;
  delete childEnv.VIBESTUDIO_IOS_PAIR_HOST;
  delete childEnv.VIBESTUDIO_IOS_ASSOCIATED_DOMAINS;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  const result = spawnSync(
    process.execPath,
    [script, "--output", output, "--configuration", configuration],
    {
      cwd: process.cwd(),
      env: childEnv,
      encoding: "utf8",
    }
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `entitlements generator exited ${result.status}`);
  }
  return fs.readFileSync(output, "utf8");
}

describe("ios-entitlements", () => {
  it("keeps the iOS Podfile compatible with the pnpm workspace layout", () => {
    const podfile = fs.readFileSync(path.join(process.cwd(), "apps/mobile/ios/Podfile"), "utf8");
    expect(podfile).toContain("require.resolve(\"react-native/scripts/react_native_pods.rb\"");
    expect(podfile).toContain("prepare_react_native_project!");
    expect(podfile).not.toContain("require_relative '../node_modules");
  });

  it("does not emit gated capabilities by default", () => {
    const plist = generate({});
    expect(plist).not.toContain("com.apple.developer.associated-domains");
    expect(plist).not.toContain("aps-environment");
  });

  it("emits associated domains only when a pair host is configured", () => {
    const debug = generate({ VIBESTUDIO_IOS_PAIR_HOST: "vibestudio.app" }, "Debug");
    expect(debug).toContain("applinks:vibestudio.app?mode=developer");
    expect(debug).toContain("webcredentials:vibestudio.app");

    const release = generate({ VIBESTUDIO_IOS_PAIR_HOST: "vibestudio.app" }, "Release");
    expect(release).toContain("applinks:vibestudio.app");
    expect(release).not.toContain("?mode=developer");
  });

  it("emits APNs only when explicitly configured", () => {
    const plist = generate({ VIBESTUDIO_IOS_APS_ENV: "development" });
    expect(plist).toContain("aps-environment");
    expect(plist).toContain("development");
  });
});
