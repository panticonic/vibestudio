import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const INTERNAL_ANDROID_PACKAGE = "app.vibestudio.mobile.internal";
export const SUPPORTED_ANDROID_ABIS = Object.freeze(["arm64-v8a", "armeabi-v7a", "x86_64", "x86"]);

const supportedAndroidAbis = new Set(SUPPORTED_ANDROID_ABIS);

export function androidDir(appRoot) {
  return path.join(appRoot, "apps", "mobile", "android");
}

export function internalAndroidApkPath(appRoot) {
  return path.join(
    androidDir(appRoot),
    "app",
    "build",
    "outputs",
    "apk",
    "internal",
    "app-internal.apk"
  );
}

export function hasCompleteAndroidSourceProject(appRoot) {
  const projectFiles = [
    path.join(androidDir(appRoot), "gradlew"),
    path.join(appRoot, "apps", "mobile", "package.json"),
    path.join(appRoot, "apps", "mobile", "index.js"),
  ];
  const dependencyRoots = [
    path.join(appRoot, "apps", "mobile", "node_modules", "react-native", "package.json"),
    path.join(appRoot, "node_modules", "react-native", "package.json"),
  ];
  return (
    projectFiles.every((candidate) => fs.existsSync(candidate)) &&
    dependencyRoots.some((candidate) => fs.existsSync(candidate))
  );
}

export function mobileCliEnvironment(appRoot, appVersion, env = process.env) {
  return {
    ...env,
    ELECTRON_RUN_AS_NODE: "1",
    VIBESTUDIO_APP_ROOT: appRoot,
    ...(appVersion ? { VIBESTUDIO_APP_VERSION: appVersion } : {}),
  };
}

export function validateAndroidArchitectures(value) {
  if (!value) return [];
  const unique = [...new Set(value)];
  for (const abi of unique) {
    if (!supportedAndroidAbis.has(abi)) {
      throw Object.assign(
        new Error(
          `Unsupported Android ABI ${JSON.stringify(abi)}; expected ${SUPPORTED_ANDROID_ABIS.join(", ")}`
        ),
        { code: "EABI" }
      );
    }
  }
  return unique;
}

export function adbArgs(device, args) {
  return device ? ["-s", device, ...args] : args;
}

export function runNativeCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.stdio ?? "ignore",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          Object.assign(new Error(`${command} ${args.join(" ")} exited ${code}`), {
            code: options.errorCode ?? "ENATIVE",
          })
        );
    });
  });
}

export function runNativeCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("exit", (code) => {
      const result = {
        exitCode: code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0 || options.reject === false) resolve(result);
      else
        reject(
          Object.assign(
            new Error(result.stderr || result.stdout.toString("utf8") || `${command} failed`),
            { code: options.errorCode ?? "ENATIVE" }
          )
        );
    });
  });
}

export function parseAdbDevices(raw) {
  return raw
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, stateRaw] = line.split(/\s+/u, 2);
      const model = line.match(/\bmodel:([^\s]+)/u)?.[1];
      const state = stateRaw === "device" || stateRaw === "unauthorized" ? stateRaw : "offline";
      return { serial, state, ...(model ? { model } : {}) };
    });
}

export async function listAdbDevices(options = {}) {
  const result = await runNativeCapture(options.adbPath ?? "adb", ["devices", "-l"], {
    cwd: options.cwd,
    env: options.env,
    errorCode: "EADB",
  });
  return parseAdbDevices(result.stdout.toString("utf8"));
}

export function pickAndroidDevice(devices, requested) {
  if (requested) {
    const match = devices.find((device) => device.serial === requested);
    if (!match)
      throw Object.assign(new Error(`adb does not see ${requested}`), { code: "ENODEVICE" });
    if (match.state !== "device")
      throw Object.assign(new Error(`${requested} is ${match.state}`), { code: "EUNAUTHORIZED" });
    return match;
  }
  const ready = devices.filter((device) => device.state === "device");
  if (ready.length === 0 && devices.some((device) => device.state === "unauthorized")) {
    throw Object.assign(new Error("Accept the Android USB debugging prompt"), {
      code: "EUNAUTHORIZED",
    });
  }
  if (ready.length === 0)
    throw Object.assign(new Error("No ready Android device"), { code: "ENODEVICE" });
  if (ready.length > 1)
    throw Object.assign(new Error("Multiple Android devices; pass a serial"), {
      code: "ENODEVICE",
    });
  return ready[0];
}

export async function readAndroidDeviceAbi(options) {
  const result = await runNativeCapture(
    options.adbPath ?? "adb",
    adbArgs(options.device, ["shell", "getprop", "ro.product.cpu.abi"]),
    {
      cwd: options.cwd,
      env: options.env,
      errorCode: "EADB",
    }
  );
  const abi = result.stdout.toString("utf8").trim();
  validateAndroidArchitectures([abi]);
  return abi;
}

export async function buildAndroidApp(options) {
  const root = androidDir(options.appRoot);
  if (!hasCompleteAndroidSourceProject(options.appRoot)) {
    throw Object.assign(
      new Error(
        "Android source builds require a complete Vibestudio source checkout and installed mobile dependencies"
      ),
      { code: "EBUILD" }
    );
  }
  const startedAt = Date.now();
  const variant = options.variant ?? "internal";
  let architectures = validateAndroidArchitectures(options.architectures);
  if (architectures.length === 0 && options.device) {
    architectures = [
      await readAndroidDeviceAbi({
        device: options.device,
        cwd: options.appRoot,
        adbPath: options.adbPath,
        env: options.env,
      }),
    ];
  }
  const apkPath =
    variant === "release"
      ? path.join(root, "app", "build", "outputs", "apk", "release", "app-release.apk")
      : internalAndroidApkPath(options.appRoot);
  await runNativeCommand(
    path.join(root, "gradlew"),
    [
      variant === "release" ? "assembleRelease" : "assembleInternal",
      "--no-daemon",
      "--max-workers=2",
      "-Pkotlin.compiler.execution.strategy=in-process",
      ...(options.rerunTasks ? ["--rerun-tasks"] : []),
      ...(architectures.length > 0
        ? [`-PreactNativeArchitectures=${architectures.join(",")}`]
        : []),
    ],
    { cwd: root, env: options.env, stdio: options.stdio, errorCode: "EBUILD" }
  );
  return {
    apkPath,
    apkBytes: fs.statSync(apkPath).size,
    architectures,
    durationMs: Date.now() - startedAt,
  };
}
