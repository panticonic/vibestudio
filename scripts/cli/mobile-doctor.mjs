#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { readIosSigningConfig } from "./lib/mobile-ios-signing.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const iosDir = path.join(repoRoot, "apps", "mobile", "ios");
const androidDir = path.join(repoRoot, "apps", "mobile", "android");

function has(command, args = ["--version"]) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return result.status === 0;
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function signingConfig() {
  const config = readIosSigningConfig(iosDir);
  return {
    exists: config.exists || Boolean(config.teamId),
    team: config.teamId,
    bundleId: config.bundleId,
    apsEnvironment: config.apsEnvironment,
  };
}

export function parseDoctorArgs(argv) {
  const options = { platform: "all", simulator: false, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--platform") options.platform = argv[++index];
    else if (arg === "--simulator") options.simulator = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!["all", "android", "ios"].includes(options.platform))
    throw new Error("--platform must be android or ios");
  if (options.simulator && options.platform !== "ios")
    throw new Error("--simulator requires --platform ios");
  return options;
}

export function checks(options, deps = {}) {
  const hostPlatform = deps.platform ?? process.platform;
  const wantIos = options.platform !== "android";
  const wantAndroid = options.platform !== "ios";
  const commandExists = deps.has ?? has;
  const commandCapture = deps.capture ?? capture;
  const fileExists = deps.exists ?? fs.existsSync;
  const signing = deps.signing ?? signingConfig();
  const identities =
    hostPlatform === "darwin" && options.platform !== "android" && !options.simulator
      ? commandCapture("security", ["find-identity", "-v", "-p", "codesigning"])
      : { ok: false, stdout: "", stderr: "" };
  const googleInfo = path.join(iosDir, "Vibestudio", "GoogleService-Info.plist");
  const googleTemplate = path.join(iosDir, "Vibestudio", "GoogleService-Info.template.plist");
  const androidGoogle = path.join(androidDir, "app", "google-services.json");
  const androidGoogleTemplate = path.join(androidDir, "app", "google-services.template.json");

  const result = [
    {
      name: "android.adb",
      ok: wantAndroid && commandExists("adb", ["version"]),
      severity: "warn",
      fix: "adb is not on PATH; `mobile install --platform android` can auto-fetch pinned platform-tools on Linux/macOS.",
    },
    {
      name: "android.java",
      ok: wantAndroid && commandExists("java", ["-version"]),
      severity: "warn",
      fix: "Install a JDK supported by the Android Gradle plugin for --from-source builds.",
    },
    {
      name: "android.firebase",
      ok: fileExists(androidGoogle),
      severity: "warn",
      fix: fileExists(androidGoogleTemplate)
        ? "Copy apps/mobile/android/app/google-services.template.json to google-services.json and fill Firebase values for push."
        : "Add Android Firebase google-services.json if push is required.",
    },
    {
      name: "ios.macos",
      ok: hostPlatform === "darwin",
      severity: "error",
      fix: "iOS builds require macOS with Xcode.",
    },
    {
      name: "ios.xcodebuild",
      ok: wantIos && hostPlatform === "darwin" && commandExists("xcodebuild", ["-version"]),
      severity: "error",
      fix: "Install Xcode and select it with xcode-select.",
    },
    {
      name: "ios.simctl",
      ok: wantIos && hostPlatform === "darwin" && commandExists("xcrun", ["simctl", "help"]),
      severity: "error",
      fix: "Install Xcode command line tools.",
    },
    {
      name: "ios.cocoapods",
      ok: wantIos && hostPlatform === "darwin" && commandExists("pod", ["--version"]),
      severity: "error",
      fix: "Install CocoaPods 1.15+.",
    },
    {
      name: "ios.signing-config",
      ok: signing.exists && Boolean(signing.team),
      severity: "error",
      fix: "Copy apps/mobile/ios/Signing.template.xcconfig to Signing.local.xcconfig and set VIBESTUDIO_IOS_TEAM_ID.",
      detail: signing.exists
        ? `team=${signing.team || "(missing)"} bundle=${signing.bundleId || "(missing)"}`
        : "Signing.local.xcconfig missing",
    },
    {
      name: "ios.signing-identity",
      ok:
        hostPlatform === "darwin" &&
        identities.ok &&
        /\)\s+[A-F0-9]{40}\s+"/.test(identities.stdout),
      severity: "error",
      fix: "Sign in to Xcode with an Apple ID and create an iOS Development signing identity.",
    },
    {
      name: "ios.firebase",
      ok: fileExists(googleInfo),
      severity: "warn",
      fix: fileExists(googleTemplate)
        ? "Copy GoogleService-Info.template.plist to GoogleService-Info.plist and fill Firebase values for iOS push."
        : "Add GoogleService-Info.plist if iOS push is required.",
    },
    {
      name: "ios.push-entitlement",
      ok: !signing.apsEnvironment || ["development", "production"].includes(signing.apsEnvironment),
      severity: "error",
      fix: "VIBESTUDIO_IOS_APS_ENV must be development or production, matching the entitlements generator.",
      detail: signing.apsEnvironment ? `APNs ${signing.apsEnvironment}` : "push off",
    },
  ];
  if (hostPlatform !== "darwin" && options.platform === "all") {
    for (const check of result) {
      if (check.name.startsWith("ios.")) {
        check.ok = true;
        check.skipped = true;
        check.detail = "skipped off macOS";
      }
    }
  }
  return result.filter(
    (check) =>
      (options.platform === "all" || check.name.startsWith(`${options.platform}.`)) &&
      !(options.simulator && ["ios.signing-config", "ios.signing-identity"].includes(check.name))
  );
}

function main() {
  const options = parseDoctorArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: vibestudio mobile doctor [--platform android|ios] [--simulator] [--json]\n\nSimulator checks do not require an Apple team or development signing identity."
    );
    return;
  }
  const result = checks(options);
  const ok = result.every((check) => check.ok || check.severity === "warn");

  if (options.json) {
    console.log(JSON.stringify({ ok, checks: result }, null, 2));
  } else {
    for (const check of result) {
      const status = check.skipped
        ? "skip"
        : check.ok
          ? "ok"
          : check.severity === "warn"
            ? "warn"
            : "fail";
      console.log(
        `${status} ${check.name}` +
          (check.detail ? ` (${check.detail})` : "") +
          (check.ok ? "" : `: ${check.fix}`)
      );
    }
  }

  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
