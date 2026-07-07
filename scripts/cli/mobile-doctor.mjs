#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

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
  const file = path.join(iosDir, "Signing.local.xcconfig");
  if (!fs.existsSync(file)) return { exists: false, team: "", bundleId: "", push: false, domains: false };
  const text = fs.readFileSync(file, "utf8");
  const value = (name) => text.match(new RegExp(`^${name}\\s*=\\s*(.+)$`, "m"))?.[1]?.trim() ?? "";
  return {
    exists: true,
    team: value("VIBESTUDIO_IOS_TEAM_ID") || value("DEVELOPMENT_TEAM"),
    bundleId: value("VIBESTUDIO_IOS_BUNDLE_ID") || value("PRODUCT_BUNDLE_IDENTIFIER"),
    push: /VIBESTUDIO_IOS_PUSH\s*=\s*(?:1|YES|true)/i.test(text),
    domains: /VIBESTUDIO_IOS_ASSOCIATED_DOMAINS\s*=\s*\S+/i.test(text),
  };
}

function checks() {
  const signing = signingConfig();
  const identities = process.platform === "darwin"
    ? capture("security", ["find-identity", "-v", "-p", "codesigning"])
    : { ok: false, stdout: "", stderr: "" };
  const googleInfo = path.join(iosDir, "Vibestudio", "GoogleService-Info.plist");
  const googleTemplate = path.join(iosDir, "Vibestudio", "GoogleService-Info.template.plist");
  const androidGoogle = path.join(androidDir, "app", "google-services.json");
  const androidGoogleTemplate = path.join(androidDir, "app", "google-services.template.json");

  return [
    {
      name: "android.adb",
      ok: has("adb", ["version"]),
      severity: "warn",
      fix: "adb is not on PATH; `mobile install --platform android` can auto-fetch pinned platform-tools on Linux/macOS.",
    },
    {
      name: "android.java",
      ok: has("java", ["-version"]),
      severity: "error",
      fix: "Install a JDK supported by the Android Gradle plugin for --from-source builds.",
    },
    {
      name: "android.firebase",
      ok: fs.existsSync(androidGoogle),
      severity: "warn",
      fix: fs.existsSync(androidGoogleTemplate)
        ? "Copy apps/mobile/android/app/google-services.template.json to google-services.json and fill Firebase values for push."
        : "Add Android Firebase google-services.json if push is required.",
    },
    {
      name: "ios.macos",
      ok: process.platform === "darwin",
      severity: "error",
      fix: "iOS builds require macOS with Xcode.",
    },
    {
      name: "ios.xcodebuild",
      ok: process.platform === "darwin" && has("xcodebuild", ["-version"]),
      severity: "error",
      fix: "Install Xcode and select it with xcode-select.",
    },
    {
      name: "ios.simctl",
      ok: process.platform === "darwin" && has("xcrun", ["simctl", "help"]),
      severity: "error",
      fix: "Install Xcode command line tools.",
    },
    {
      name: "ios.cocoapods",
      ok: process.platform === "darwin" && has("pod", ["--version"]),
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
      ok: process.platform === "darwin" && identities.ok && /\)\s+[A-F0-9]{40}\s+"/.test(identities.stdout),
      severity: "error",
      fix: "Sign in to Xcode with an Apple ID and create an iOS Development signing identity.",
    },
    {
      name: "ios.firebase",
      ok: fs.existsSync(googleInfo),
      severity: "warn",
      fix: fs.existsSync(googleTemplate)
        ? "Copy GoogleService-Info.template.plist to GoogleService-Info.plist and fill Firebase values for iOS push."
        : "Add GoogleService-Info.plist if iOS push is required.",
    },
    {
      name: "ios.push-entitlement",
      ok: !signing.push || (Boolean(signing.team) && fs.existsSync(googleInfo)),
      severity: "error",
      fix: "Only enable iOS push when using a paid/provisioned team and GoogleService-Info.plist is present.",
      detail: signing.push ? "push requested" : "push off",
    },
  ];
}

const result = checks();
const ok = result.every((check) => check.ok || check.severity === "warn");

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ok, checks: result }, null, 2));
} else {
  for (const check of result) {
    const status = check.ok ? "ok" : check.severity === "warn" ? "warn" : "fail";
    console.log(
      `${status} ${check.name}` +
        (check.detail ? ` (${check.detail})` : "") +
        (check.ok ? "" : `: ${check.fix}`)
    );
  }
}

process.exit(ok ? 0 : 1);
