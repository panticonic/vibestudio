#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  INTERNAL_ANDROID_PACKAGE,
  RELEASE_ANDROID_PACKAGE,
  parseAdbDevices,
  parseAndroidPackageVersion,
  versionsCompatible,
} from "./lib/mobile-device-tools.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const expectedVersion =
  process.env.VIBESTUDIO_APP_VERSION ??
  (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
    } catch {
      return "unknown";
    }
  })();

function parseArgs(argv) {
  const [action, ...rest] = argv;
  const options = {
    action,
    platform: "android",
    deviceId: undefined,
    pairUrl: undefined,
    packageId: undefined,
    bundleId: "app.vibestudio.mobile",
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const next = () => {
      const value = rest[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--platform") options.platform = next();
    else if (arg === "--device") options.deviceId = next();
    else if (arg === "--pair") options.pairUrl = next();
    else if (arg === "--package") options.packageId = next();
    else if (arg === "--bundle-id") options.bundleId = next();
    else if (arg === "--json") continue;
    else if (arg === "--help" || arg === "-h") options.action = "help";
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!new Set(["android", "ios"]).has(options.platform)) {
    throw new Error("--platform must be android or ios");
  }
  return options;
}

function printHelp() {
  console.log(`Usage:
  vibestudio mobile devices [--platform android|ios] [--json]
  vibestudio mobile connect --pair <link> [--platform android|ios] [--device <id>]

The pairing link is treated as a secret and is never printed.`);
}

async function run(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => (current + chunk.toString()).slice(-1024 * 1024);
    child.stdout.on("data", (chunk) => (stdout = append(stdout, chunk)));
    child.stderr.on("data", (chunk) => (stderr = append(stderr, chunk)));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const detail = options.sensitive ? "" : `: ${(stderr || stdout).trim()}`;
        reject(new Error(`${path.basename(command)} exited ${code ?? signal}${detail}`));
      }
    });
  });
}

async function isExecutable(candidate) {
  try {
    await run(candidate, ["version"]);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function androidShellCommand(args) {
  return args.map(shellQuote).join(" ");
}

function findCachedAdb(root, depth = 0) {
  if (depth > 7 || !fs.existsSync(root)) return null;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const executable = process.platform === "win32" ? "adb.exe" : "adb";
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && entry.name === executable) return candidate;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = findCachedAdb(path.join(root, entry.name), depth + 1);
    if (candidate) return candidate;
  }
  return null;
}

async function resolveAdb() {
  const executable = process.platform === "win32" ? "adb.exe" : "adb";
  const candidates = [
    process.env.ADB,
    process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, "platform-tools", executable),
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, "platform-tools", executable),
    findCachedAdb(path.join(os.homedir(), ".cache", "vibestudio")),
    executable,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  throw new Error(
    "Android platform-tools are unavailable. Run `vibestudio mobile install`; it resolves the pinned tools automatically."
  );
}

async function installedAndroidApps(adb, deviceId) {
  const apps = [];
  for (const packageId of [RELEASE_ANDROID_PACKAGE, INTERNAL_ANDROID_PACKAGE]) {
    try {
      const result = await run(adb, ["-s", deviceId, "shell", "dumpsys", "package", packageId]);
      const versionName = parseAndroidPackageVersion(result.stdout);
      if (result.stdout.includes(`Package [${packageId}]`) || versionName) {
        apps.push({ packageId, ...(versionName ? { versionName } : {}) });
      }
    } catch {}
  }
  return apps;
}

async function androidDevices() {
  const adb = await resolveAdb();
  const result = await run(adb, ["devices", "-l"]);
  const devices = [];
  for (const raw of parseAdbDevices(result.stdout)) {
    const installedApps = raw.state === "device" ? await installedAndroidApps(adb, raw.deviceId) : [];
    devices.push({
      platform: "android",
      deviceId: raw.deviceId,
      ...(raw.attributes.model ? { name: raw.attributes.model.replaceAll("_", " ") } : {}),
      state: raw.state,
      kind: raw.deviceId.startsWith("emulator-") ? "emulator" : "physical",
      ready: raw.state === "device",
      installedApps,
      compatibleAppInstalled: installedApps.some((app) =>
        versionsCompatible(app.versionName, expectedVersion)
      ),
    });
  }
  return devices;
}

async function iosDevices() {
  if (process.platform !== "darwin") {
    throw new Error("iOS devices require a macOS desktop with Xcode installed.");
  }
  const simulators = JSON.parse((await run("xcrun", ["simctl", "list", "devices", "--json"])).stdout);
  const devices = Object.values(simulators.devices ?? {})
    .flat()
    .filter((device) => device?.isAvailable !== false)
    .map((device) => ({
      platform: "ios",
      deviceId: device.udid,
      name: device.name,
      state: device.state,
      kind: "simulator",
      ready: device.state === "Booted",
      installedApps: [],
      compatibleAppInstalled: false,
    }));
  try {
    const physical = (await run("xcrun", ["xctrace", "list", "devices"])).stdout;
    const section = physical.split("== Devices ==")[1]?.split("== Simulators ==")[0] ?? "";
    for (const line of section.split(/\r?\n/)) {
      const match = line.trim().match(/^(.+?)\s+\([^)]*\)\s+\(([0-9a-f-]{8,})\)$/i);
      if (!match) continue;
      devices.push({
        platform: "ios",
        deviceId: match[2],
        name: match[1].trim(),
        state: "connected",
        kind: "physical",
        ready: true,
        installedApps: [],
        compatibleAppInstalled: false,
      });
    }
  } catch {}
  return devices;
}

async function discover(options) {
  try {
    return { devices: options.platform === "android" ? await androidDevices() : await iosDevices(), issues: [] };
  } catch (error) {
    return {
      devices: [],
      issues: [
        {
          code: "tooling-unavailable",
          message: error instanceof Error ? error.message : String(error),
          action:
            options.platform === "android"
              ? "Connect and unlock the phone, enable USB debugging, then run mobile install."
              : "Install Xcode, trust the phone, and configure an Apple development team.",
        },
      ],
    };
  }
}

async function connectAndroid(options) {
  const adb = await resolveAdb();
  const discovery = await androidDevices();
  const ready = discovery.filter((device) => device.ready);
  const device = options.deviceId
    ? ready.find((candidate) => candidate.deviceId === options.deviceId)
    : ready.length === 1
      ? ready[0]
      : null;
  if (!device) {
    throw new Error(
      options.deviceId
        ? "The selected Android device is not connected and authorized."
        : ready.length === 0
          ? "No connected and authorized Android device was found."
          : "More than one Android device is ready; select one with --device."
    );
  }
  const packageId =
    options.packageId ??
    device.installedApps.find((app) => app.packageId === RELEASE_ANDROID_PACKAGE)?.packageId ??
    device.installedApps.find((app) => app.packageId === INTERNAL_ANDROID_PACKAGE)?.packageId;
  if (!packageId) throw new Error("Vibestudio is not installed on the selected Android device.");
  const intentArgs = [
    "am",
    "start",
    "-W",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    options.pairUrl,
  ];
  try {
    await run(
      adb,
      ["-s", device.deviceId, "shell", androidShellCommand([...intentArgs, "-p", packageId])],
      { sensitive: true }
    );
  } catch {
    await run(
      adb,
      [
        "-s",
        device.deviceId,
        "shell",
        androidShellCommand([...intentArgs, "-n", `${packageId}/.MainActivity`]),
      ],
      { sensitive: true }
    );
  }
  return { platform: "android", deviceId: device.deviceId, packageId };
}

async function connectIos(options) {
  const discovery = await iosDevices();
  const ready = discovery.filter((device) => device.ready);
  const device = options.deviceId
    ? ready.find((candidate) => candidate.deviceId === options.deviceId)
    : ready.length === 1
      ? ready[0]
      : null;
  if (!device) {
    throw new Error(
      ready.length === 0
        ? "No ready iOS device or simulator was found."
        : "More than one iOS device is ready; select one with --device."
    );
  }
  if (device.kind === "simulator") {
    await run("xcrun", ["simctl", "openurl", device.deviceId, options.pairUrl], { sensitive: true });
  } else {
    await run(
      "xcrun",
      [
        "devicectl",
        "device",
        "process",
        "launch",
        "--device",
        device.deviceId,
        "--terminate-existing",
        "--payload-url",
        options.pairUrl,
        options.bundleId,
      ],
      { sensitive: true }
    );
  }
  return { platform: "ios", deviceId: device.deviceId, packageId: options.bundleId };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.action === "help" || !options.action) {
    printHelp();
    return;
  }
  if (options.action === "devices") {
    console.log(JSON.stringify(await discover(options)));
    return;
  }
  if (options.action !== "connect") throw new Error("Expected devices or connect");
  if (!options.pairUrl) throw new Error("connect requires --pair");
  const result = options.platform === "android" ? await connectAndroid(options) : await connectIos(options);
  console.log(JSON.stringify({ ...result, status: "launched" }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
