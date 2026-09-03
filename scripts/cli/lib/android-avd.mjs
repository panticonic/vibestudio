import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const avdProvisionLock = path.join(os.tmpdir(), "vibestudio-android-avd-provision.lock");

export const DEFAULT_ANDROID_AVD = "Vibestudio_Test";

export function androidEmulatorSerial(consolePort) {
  const port = Number(consolePort);
  if (!Number.isInteger(port) || port < 5554 || port > 5584 || port % 2 !== 0) {
    throw new Error(
      `Android emulator reported invalid console port ${JSON.stringify(consolePort)}`
    );
  }
  return `emulator-${port}`;
}

export function parseReadyAndroidDevices(output) {
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[1] === "device")
    .map(([serial]) => serial);
}

export function selectReadyAndroidDevice(readyDevices, requestedDevice = null) {
  if (requestedDevice) {
    return readyDevices.includes(requestedDevice) ? requestedDevice : null;
  }
  return [...readyDevices].sort((left, right) => left.localeCompare(right))[0] ?? null;
}

async function listAvds(emulatorCommand) {
  const { stdout } = await execFileAsync(emulatorCommand, ["-list-avds"]);
  return stdout
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
}

async function listInstalledSystemImages(sdkRoot) {
  const root = path.join(sdkRoot, "system-images");
  const images = [];
  for (const api of await fsp.readdir(root).catch(() => [])) {
    for (const flavor of await fsp.readdir(path.join(root, api)).catch(() => [])) {
      for (const abi of await fsp.readdir(path.join(root, api, flavor)).catch(() => [])) {
        const packageXml = path.join(root, api, flavor, abi, "package.xml");
        if (
          await fsp
            .stat(packageXml)
            .then((entry) => entry.isFile())
            .catch(() => false)
        ) {
          images.push({ api, flavor, abi, packageId: `system-images;${api};${flavor};${abi}` });
        }
      }
    }
  }
  return images;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function acquireAvdProvisionLock(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fsp.mkdir(avdProvisionLock);
      await fsp.writeFile(path.join(avdProvisionLock, "owner"), `${process.pid}\n`);
      return async () => {
        await fsp.rm(avdProvisionLock, { recursive: true, force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = Number(
        await fsp.readFile(path.join(avdProvisionLock, "owner"), "utf8").catch(() => "")
      );
      if (owner && !processIsAlive(owner)) {
        await fsp.rm(avdProvisionLock, { recursive: true, force: true });
        continue;
      }
      if (!owner) {
        const lockAgeMs = await fsp
          .stat(avdProvisionLock)
          .then((entry) => Date.now() - entry.mtimeMs)
          .catch(() => 0);
        if (lockAgeMs > 1_000) {
          await fsp.rm(avdProvisionLock, { recursive: true, force: true });
          continue;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Timed out waiting for another Android AVD provisioning process");
}

export function selectAndroidSystemImage(images, arch = os.arch()) {
  const preferredAbi = arch === "arm64" ? "arm64-v8a" : "x86_64";
  const flavorRank = new Map([
    ["google_apis_playstore", 0],
    ["google_apis", 1],
    ["default", 2],
  ]);
  return [...images].sort((left, right) => {
    const leftApi = Number(left.api.match(/\d+/)?.[0] ?? 0);
    const rightApi = Number(right.api.match(/\d+/)?.[0] ?? 0);
    const abiDifference = Number(left.abi !== preferredAbi) - Number(right.abi !== preferredAbi);
    if (abiDifference !== 0) return abiDifference;
    const flavorDifference =
      (flavorRank.get(left.flavor) ?? 99) - (flavorRank.get(right.flavor) ?? 99);
    if (flavorDifference !== 0) return flavorDifference;
    return rightApi - leftApi;
  })[0];
}

export function selectExistingAndroidAvd(available, requestedAvd = null) {
  if (requestedAvd) {
    if (!available.includes(requestedAvd)) {
      throw new Error(
        `Android AVD ${JSON.stringify(requestedAvd)} is not installed. Available AVDs: ${available.join(", ") || "none"}.`
      );
    }
    return requestedAvd;
  }
  if (available.includes(DEFAULT_ANDROID_AVD)) return DEFAULT_ANDROID_AVD;
  return [...available].sort((left, right) => left.localeCompare(right))[0] ?? null;
}

function createAvd(avdManagerCommand, name, packageId) {
  return new Promise((resolve, reject) => {
    const args = [
      "create",
      "avd",
      "--name",
      name,
      "--package",
      packageId,
      "--device",
      "pixel_7",
      "--force",
    ];
    const child = spawn(avdManagerCommand, args, { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (output += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`${avdManagerCommand} ${args.join(" ")} failed (${code ?? signal})\n${output}`)
        );
    });
    child.stdin.end("no\n");
  });
}

export async function resolveAvdManager(sdkRoot) {
  const cmdlineRoot = path.join(sdkRoot, "cmdline-tools");
  const versions = await fsp.readdir(cmdlineRoot).catch(() => []);
  const candidates = [
    path.join(cmdlineRoot, "latest", "bin", "avdmanager"),
    ...versions
      .filter((entry) => entry !== "latest")
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      .map((entry) => path.join(cmdlineRoot, entry, "bin", "avdmanager")),
    path.join(sdkRoot, "tools", "bin", "avdmanager"),
  ];
  for (const candidate of candidates) {
    if (
      await fsp
        .access(candidate)
        .then(() => true)
        .catch(() => false)
    )
      return candidate;
  }
  throw new Error(
    `Android SDK command-line tools are installed incompletely under ${sdkRoot}; avdmanager was not found.`
  );
}

/**
 * Resolve an emulator for unattended mobile workflows. Explicit AVD requests
 * are authoritative. Otherwise we prefer the shared Vibestudio AVD, reuse an
 * installed AVD when one already exists, and finally provision the shared AVD
 * from the best installed SDK image.
 */
export async function ensureAndroidAvd({
  requestedAvd = null,
  emulatorCommand = process.env.ANDROID_EMULATOR ?? "emulator",
  sdkRoot = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? null,
  log = console.log,
} = {}) {
  const configuredAvd = requestedAvd ?? process.env.VIBESTUDIO_ANDROID_AVD ?? null;
  const available = await listAvds(emulatorCommand);
  const existing = selectExistingAndroidAvd(available, configuredAvd);
  if (existing) {
    if (!configuredAvd && existing !== DEFAULT_ANDROID_AVD) {
      log(`[android-avd] ${DEFAULT_ANDROID_AVD} is not installed; using available AVD ${existing}`);
    }
    return existing;
  }
  if (!sdkRoot) {
    throw new Error(
      "No Android AVD is installed and ANDROID_SDK_ROOT/ANDROID_HOME is unset, so the standard Vibestudio emulator cannot be provisioned."
    );
  }
  const releaseProvisionLock = await acquireAvdProvisionLock();
  try {
    // Another runner may have provisioned the shared fallback while this one
    // waited for the lock. Re-resolve before mutating the AVD directory.
    const provisioned = selectExistingAndroidAvd(await listAvds(emulatorCommand));
    if (provisioned) return provisioned;
    const image = selectAndroidSystemImage(await listInstalledSystemImages(sdkRoot));
    if (!image) {
      throw new Error(
        `No Android AVD or installed system image was found under ${sdkRoot}. Install an Android system image before running the mobile smoke.`
      );
    }
    log(`[android-avd] Provisioning ${DEFAULT_ANDROID_AVD} from ${image.packageId}`);
    await createAvd(await resolveAvdManager(sdkRoot), DEFAULT_ANDROID_AVD, image.packageId);
    return DEFAULT_ANDROID_AVD;
  } finally {
    await releaseProvisionLock();
  }
}
