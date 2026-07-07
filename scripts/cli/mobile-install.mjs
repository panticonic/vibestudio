#!/usr/bin/env node
// Install the mobile native shell. Android defaults to the version-matched
// release APK with checksum verification; --from-source builds the internal
// contributor variant locally.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const androidDir = path.join(repoRoot, "apps", "mobile", "android");
const iosDir = path.join(repoRoot, "apps", "mobile", "ios");
const iosEntitlementsScript = path.join(repoRoot, "scripts", "cli", "ios-entitlements.mjs");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const releaseArtifactName = "app-release.apk";
const releasePackage = "app.vibestudio.mobile";
const internalPackage = "app.vibestudio.mobile.internal";
const internalApkPath = path.join(androidDir, "app", "build", "outputs", "apk", "internal", "app-internal.apk");
const defaultReleaseBaseUrl = `https://github.com/vibestudio/vibestudio/releases/download/v${pkg.version}`;
const defaultArtifactUrl =
  process.env.VIBESTUDIO_MOBILE_APK_URL ??
  `${defaultReleaseBaseUrl}/${releaseArtifactName}`;
const defaultChecksumUrl =
  process.env.VIBESTUDIO_MOBILE_CHECKSUMS_URL ??
  `${defaultReleaseBaseUrl}/SHA256SUMS`;
const platformToolsVersion = "36.0.0";
const platformToolsPins = {
  linux: {
    archive: "platform-tools_r36.0.0-linux.zip",
    sha256: "0ead642c943ffe79701fccca8f5f1c69c4ce4f43df2eefee553f6ccb27cbfbe8",
  },
  darwin: {
    archive: "platform-tools_r36.0.0-darwin.zip",
    sha256: "d3e9fa1df3345cf728586908426615a60863d2632f73f1ce14f0f1349ef000fd",
  },
};

function readXcconfig(file) {
  if (!fs.existsSync(file)) return {};
  const values = {};
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_.$()[\]-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    values[match[1]] = match[2];
  }
  return values;
}

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === "string" && value.trim()) ?? null;
}

function parseArgs(argv) {
  const signing = readXcconfig(path.join(iosDir, "Signing.local.xcconfig"));
  const options = {
    platform: "android",
    device: null,
    simulator: false,
    artifactUrl: defaultArtifactUrl,
    checksumUrl: defaultChecksumUrl,
    artifactSha256: process.env.VIBESTUDIO_MOBILE_APK_SHA256 ?? null,
    packageName: null,
    noBuild: false,
    fromSource: false,
    launch: false,
    resetApp: false,
    configuration: "Release",
    teamId: firstNonEmpty(
      process.env.VIBESTUDIO_IOS_TEAM_ID,
      signing.VIBESTUDIO_IOS_TEAM_ID,
      signing.DEVELOPMENT_TEAM
    ),
    bundleId:
      firstNonEmpty(
        process.env.VIBESTUDIO_IOS_BUNDLE_ID,
        signing.VIBESTUDIO_IOS_BUNDLE_ID,
        signing.PRODUCT_BUNDLE_IDENTIFIER
      ) ?? "app.vibestudio.mobile",
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--platform") {
      options.platform = argv[++i] ?? "android";
    } else if (arg === "--device") {
      options.device = argv[++i] ?? null;
    } else if (arg === "--simulator") {
      options.simulator = true;
    } else if (arg === "--artifact-url") {
      options.artifactUrl = argv[++i] ?? "";
    } else if (arg === "--checksum-url") {
      options.checksumUrl = argv[++i] ?? "";
    } else if (arg === "--artifact-sha256") {
      options.artifactSha256 = argv[++i] ?? "";
    } else if (arg === "--package") {
      options.packageName = argv[++i] ?? "";
    } else if (arg === "--no-build") {
      options.noBuild = true;
      options.fromSource = true;
    } else if (arg === "--from-source") {
      options.fromSource = true;
    } else if (arg === "--configuration") {
      options.configuration = argv[++i] ?? options.configuration;
    } else if (arg === "--team-id") {
      options.teamId = argv[++i] ?? null;
    } else if (arg === "--bundle-id") {
      options.bundleId = argv[++i] ?? options.bundleId;
    } else if (arg === "--launch") {
      options.launch = true;
    } else if (arg === "--reset-app") {
      options.resetApp = true;
    } else if (arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.platform !== "android" && options.platform !== "ios") {
    throw new Error("--platform must be android or ios");
  }
  options.packageName =
    options.packageName ?? (options.fromSource || options.noBuild ? internalPackage : releasePackage);
  return options;
}

function printHelp() {
  console.log(`vibestudio mobile install

Usage:
  vibestudio mobile install [--platform android] [--device <adb-serial>] [--launch]
  vibestudio mobile install --platform android --from-source
  vibestudio mobile install --platform ios [--simulator|--device <udid>] [--launch]

Options:
  --platform <name>    android or ios. Defaults to android.
  --device <serial>    Target a specific adb device.
  --simulator          iOS: build/install to the booted simulator.
  --artifact-url <url> Android: prebuilt APK URL. Defaults to the release artifact.
  --checksum-url <url> Android: release SHA256SUMS URL. Defaults to the release checksum file.
  --artifact-sha256 <hash>
                       Android: expected APK SHA-256. Overrides --checksum-url.
  --package <id>       Android package id to reset/launch.
  --from-source        Android: build the internal APK locally with Gradle.
  --no-build           Android: install the existing local APK.
  --configuration <c>  iOS: Debug or Release. Defaults to Release.
  --team-id <id>       iOS: Apple Developer Team ID.
  --bundle-id <id>     iOS: signed app bundle identifier.
  --launch             Launch the app after install.
  --reset-app          Clear app data before install.
  --help               Show this help message.

If adb is not on PATH for Android installs, the command downloads pinned Android
platform-tools ${platformToolsVersion} into the Vibestudio cache and verifies
the archive SHA-256 before extraction. Windows auto-fetch is intentionally not
enabled until a pinned archive is added.
`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: process.env,
      stdio: options.stdio ?? "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
    });
  });
}

function runCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed with code ${code}\n${stderr || stdout}`));
    });
  });
}

function adbArgs(device, args) {
  return device ? ["-s", device, ...args] : args;
}

function iosDestination(options) {
  if (options.device) return ["-destination", `id=${options.device}`];
  if (options.simulator) return ["-destination", "platform=iOS Simulator,name=iPhone 16"];
  return ["-destination", "generic/platform=iOS"];
}

function iosSdk(options) {
  return options.device || !options.simulator ? "iphoneos" : "iphonesimulator";
}

function iosAppPath(options) {
  const sdk = iosSdk(options);
  return path.join(iosDir, "build", "Build", "Products", `${options.configuration}-${sdk}`, "Vibestudio.app");
}

async function ensureIosEntitlements(options) {
  await run(process.execPath, [
    iosEntitlementsScript,
    "--output",
    path.join(iosDir, "Generated", "Vibestudio.entitlements"),
    "--configuration",
    options.configuration,
  ]);
}

async function ensurePods() {
  if (fs.existsSync(path.join(iosDir, "Pods", "Manifest.lock"))) return;
  await run("pod", ["install"], { cwd: iosDir });
}

async function installIos(options) {
  if (process.platform !== "darwin") {
    throw new Error("iOS install requires macOS with Xcode. Run `vibestudio mobile doctor` on a Mac for provisioning details.");
  }
  await ensureIosEntitlements(options);
  await ensurePods();
  const buildTarget = fs.existsSync(path.join(iosDir, "Vibestudio.xcworkspace"))
    ? ["-workspace", "Vibestudio.xcworkspace"]
    : ["-project", "Vibestudio.xcodeproj"];
  const signingArgs = [
    `PRODUCT_BUNDLE_IDENTIFIER=${options.bundleId}`,
    "CODE_SIGN_ENTITLEMENTS=Generated/Vibestudio.entitlements",
  ];
  if (options.teamId) signingArgs.push(`DEVELOPMENT_TEAM=${options.teamId}`);
  await run("xcodebuild", [
    ...buildTarget,
    "-scheme",
    "Vibestudio",
    "-configuration",
    options.configuration,
    "-derivedDataPath",
    path.join(iosDir, "build"),
    ...iosDestination(options),
    ...signingArgs,
    "build",
  ], { cwd: iosDir });
  const appPath = iosAppPath(options);
  if (!fs.existsSync(appPath)) throw new Error(`iOS build did not produce ${appPath}`);
  if (options.simulator) {
    await run("xcrun", ["simctl", "bootstatus", "booted", "-b"]);
    await run("xcrun", ["simctl", "install", "booted", appPath]);
    if (options.launch) await run("xcrun", ["simctl", "launch", "booted", options.bundleId]);
  } else if (options.device) {
    await run("xcrun", ["devicectl", "device", "install", "app", "--device", options.device, appPath]);
    if (options.launch) {
      await run("xcrun", ["devicectl", "device", "process", "launch", "--device", options.device, options.bundleId]);
    }
  } else {
    console.log(`[mobile-install] iOS app built: ${appPath}`);
    console.log("[mobile-install] Pass --simulator or --device <udid> to install.");
  }
}

async function downloadFile(url, destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await new Promise((resolve, reject) => {
    const request = (currentUrl) => {
      https.get(currentUrl, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
          response.resume();
          request(new URL(response.headers.location, currentUrl).toString());
          return;
        }
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
          response.resume();
          reject(new Error(`download failed (${response.statusCode}) from ${currentUrl}`));
          return;
        }
        const file = fs.createWriteStream(destination);
        response.pipe(file);
        file.on("finish", () => file.close(resolve));
        file.on("error", reject);
      }).on("error", reject);
    };
    request(url);
  });
}

function artifactCachePath(url) {
  let basename = releaseArtifactName;
  try {
    const parsed = new URL(url);
    const candidate = path.basename(decodeURIComponent(parsed.pathname));
    if (candidate) basename = candidate;
  } catch {
    const candidate = path.basename(url);
    if (candidate) basename = candidate;
  }
  return path.join(vibestudioCacheDir(), "mobile-artifacts", pkg.version, basename);
}

async function downloadText(url) {
  return new Promise((resolve, reject) => {
    const request = (currentUrl) => {
      https.get(currentUrl, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
          response.resume();
          request(new URL(response.headers.location, currentUrl).toString());
          return;
        }
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
          response.resume();
          reject(new Error(`download failed (${response.statusCode}) from ${currentUrl}`));
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve(body));
      }).on("error", reject);
    };
    request(url);
  });
}

function checksumFromList(text, artifactPath) {
  const basename = path.basename(artifactPath);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(trimmed);
    if (!match) continue;
    const file = match[2].trim();
    if (file === basename || path.basename(file) === basename) return match[1].toLowerCase();
  }
  return null;
}

async function verifyAndroidArtifact(artifactPath, options) {
  const actual = await sha256File(artifactPath);
  let expected = options.artifactSha256 ? String(options.artifactSha256).trim().toLowerCase() : "";
  if (!expected) {
    if (!options.checksumUrl) {
      throw new Error("Android release APK verification requires --checksum-url or --artifact-sha256");
    }
    const checksums = await downloadText(options.checksumUrl);
    expected = checksumFromList(checksums, artifactPath) ?? "";
    if (!expected) {
      throw new Error(
        `No SHA-256 entry for ${path.basename(artifactPath)} in ${options.checksumUrl}`
      );
    }
  }
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error(`Invalid Android APK SHA-256: ${expected || "(empty)"}`);
  }
  if (actual !== expected) {
    throw new Error(`Android APK SHA-256 mismatch: expected ${expected}, got ${actual}`);
  }
}

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function vibestudioCacheDir() {
  const base =
    process.env.XDG_CACHE_HOME ||
    (process.platform === "darwin"
      ? path.join(process.env.HOME ?? os.tmpdir(), "Library", "Caches")
      : path.join(process.env.HOME ?? os.tmpdir(), ".cache"));
  return path.join(base, "vibestudio");
}

function adbExecutableName() {
  return process.platform === "win32" ? "adb.exe" : "adb";
}

async function commandWorks(command, args) {
  try {
    await runCapture(command, args);
    return true;
  } catch {
    return false;
  }
}

async function ensureAdb() {
  if (await commandWorks("adb", ["version"])) return "adb";

  const pin = platformToolsPins[process.platform];
  if (!pin) {
    throw new Error(
      "adb is not on PATH and Vibestudio has no pinned platform-tools archive for this OS. " +
        "Install Android platform-tools and retry."
    );
  }

  const root = path.join(vibestudioCacheDir(), "android-platform-tools", platformToolsVersion);
  const adbPath = path.join(root, "platform-tools", adbExecutableName());
  if (fs.existsSync(adbPath) && (await commandWorks(adbPath, ["version"]))) return adbPath;

  const downloads = path.join(root, "downloads");
  const archivePath = path.join(downloads, pin.archive);
  const url = `https://dl.google.com/android/repository/${pin.archive}`;
  await fsp.mkdir(downloads, { recursive: true });
  if (!fs.existsSync(archivePath)) {
    console.log(`[mobile-install] Downloading Android platform-tools ${platformToolsVersion}: ${url}`);
    await downloadFile(url, archivePath);
  }
  const actual = await sha256File(archivePath);
  if (actual !== pin.sha256) {
    throw new Error(
      `platform-tools SHA-256 mismatch for ${pin.archive}: expected ${pin.sha256}, got ${actual}`
    );
  }

  const extractDir = path.join(root, "extracting");
  await fsp.rm(extractDir, { recursive: true, force: true });
  await fsp.mkdir(extractDir, { recursive: true });
  await run("unzip", ["-q", archivePath, "-d", extractDir]);
  await fsp.rm(path.join(root, "platform-tools"), { recursive: true, force: true });
  await fsp.rename(path.join(extractDir, "platform-tools"), path.join(root, "platform-tools"));
  await fsp.rm(extractDir, { recursive: true, force: true });
  if (!(await commandWorks(adbPath, ["version"]))) {
    throw new Error(`Downloaded adb did not run: ${adbPath}`);
  }
  return adbPath;
}

function parseAdbDevices(stdout) {
  return stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state] = line.split(/\s+/, 2);
      return { serial, state, line };
    });
}

async function assertInstallTarget(adbPath, device) {
  let result;
  try {
    result = await runCapture(adbPath, ["devices", "-l"]);
  } catch (error) {
    throw new Error(
      "adb failed to list devices. Make sure a phone or emulator is connected and authorized.\n" +
      String(error instanceof Error ? error.message : error),
    );
  }

  const devices = parseAdbDevices(result.stdout);
  if (device) {
    const match = devices.find((entry) => entry.serial === device);
    if (!match) {
      throw new Error(`adb does not see device "${device}".\n\n${result.stdout.trim() || "No adb output"}`);
    }
    if (match.state !== "device") {
      throw new Error(`adb sees "${device}" but it is "${match.state}". Unlock the phone and accept the USB debugging prompt.`);
    }
    return;
  }

  const ready = devices.filter((entry) => entry.state === "device");
  if (ready.length === 1) return;

  if (ready.length > 1) {
    throw new Error(
      "adb sees multiple install targets. Re-run with --device <serial>.\n\n" +
      result.stdout.trim(),
    );
  }

  if (devices.length > 0) {
    throw new Error(
      "adb sees a device, but it is not ready. Unlock the phone and accept the USB debugging prompt.\n\n" +
      result.stdout.trim(),
    );
  }

  throw new Error(
    "adb does not see any Android device or emulator.\n\n" +
    "Check that the phone is plugged in, Developer options are enabled, USB debugging is on, " +
    "the phone is unlocked, and the USB debugging authorization prompt has been accepted.\n" +
    `Then confirm with: ${adbPath} devices -l`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (options.platform === "ios") {
    await installIos(options);
    return;
  }

  const adbPath = await ensureAdb();
  await assertInstallTarget(adbPath, options.device);

  let apkPath;
  if (options.fromSource || options.noBuild) {
    apkPath = internalApkPath;
  } else {
    apkPath = artifactCachePath(options.artifactUrl);
  }

  if (options.fromSource && !options.noBuild) {
    await run("./gradlew", ["assembleInternal", "--rerun-tasks"], { cwd: androidDir });
  } else if (!options.noBuild && !fs.existsSync(apkPath)) {
    console.log(`[mobile-install] Downloading prebuilt APK: ${options.artifactUrl}`);
    await downloadFile(options.artifactUrl, apkPath);
  }

  if (!options.fromSource && !options.noBuild) {
    await verifyAndroidArtifact(apkPath, options);
  }

  if (!fs.existsSync(apkPath)) {
    throw new Error(`Android APK does not exist: ${apkPath}`);
  }

  console.log(`[mobile-install] APK: ${apkPath}`);

  if (options.resetApp) {
    try {
      await run(adbPath, adbArgs(options.device, ["shell", "pm", "clear", options.packageName]));
    } catch {
      // The app may not be installed yet; install can continue.
    }
  }

  await run(adbPath, adbArgs(options.device, ["install", "-r", "-d", apkPath]));

  if (options.launch) {
    await run(adbPath, adbArgs(options.device, [
      "shell",
      "monkey",
      "-p",
      options.packageName,
      "-c",
      "android.intent.category.LAUNCHER",
      "1",
    ]));
  }
}

try {
  await main();
} catch (error) {
  console.error(`[mobile-install] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
