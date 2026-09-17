/** One resolver for Android discovery and installation, including packaged desktops. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import extract from "extract-zip";

const exec = promisify(execFile);
export const platformToolsVersion = "36.0.0";
const pins = {
  linux: "0ead642c943ffe79701fccca8f5f1c69c4ce4f43df2eefee553f6ccb27cbfbe8",
  darwin: "d3e9fa1df3345cf728586908426615a60863d2632f73f1ce14f0f1349ef000fd",
  win32: "12c2841f354e92a0eb2fd7bf6f0f9bf8538abce7bd6b060ac8349d6f6a61107c",
};
export function vibestudioCacheDir(env = process.env, platform = process.platform) {
  const base =
    env.XDG_CACHE_HOME ||
    (platform === "darwin"
      ? path.join(os.homedir(), "Library", "Caches")
      : platform === "win32"
        ? env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
        : path.join(os.homedir(), ".cache"));
  return path.join(base, "vibestudio");
}
export function adbCandidates(env = process.env, platform = process.platform) {
  const executable = platform === "win32" ? "adb.exe" : "adb";
  return [
    ...new Set(
      [
        env.ADB,
        ...[env.ANDROID_SDK_ROOT, env.ANDROID_HOME]
          .filter(Boolean)
          .map((root) => path.join(root, "platform-tools", executable)),
        path.join(
          vibestudioCacheDir(env, platform),
          "android-platform-tools",
          platformToolsVersion,
          "platform-tools",
          executable
        ),
        executable,
      ].filter(Boolean)
    ),
  ];
}
async function works(candidate) {
  try {
    await exec(candidate, ["version"], { timeout: 10_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
export async function resolveAdb() {
  for (const candidate of adbCandidates()) if (await works(candidate)) return candidate;
  throw new Error(
    "Android tools are not prepared on this desktop. Choose Prepare Android tools in phone setup."
  );
}
export async function ensureAdb() {
  try {
    return await resolveAdb();
  } catch {}
  const platform = process.platform;
  const checksum = pins[platform];
  if (!checksum)
    throw new Error(`Automatic Android tools installation is unavailable on ${platform}.`);
  const root = path.join(vibestudioCacheDir(), "android-platform-tools");
  await fs.mkdir(root, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(root, ".install-"));
  const archive = `platform-tools_r${platformToolsVersion}-${platform === "darwin" ? "darwin" : platform === "win32" ? "win" : "linux"}.zip`;
  const destination = path.join(root, platformToolsVersion);
  const executable = platform === "win32" ? "adb.exe" : "adb";
  try {
    let bytes;
    try {
      const response = await fetch(`https://dl.google.com/android/repository/${archive}`, {
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      const reason = error?.cause?.code || error?.message || String(error);
      throw new Error(
        `Could not download Android tools from Google (${reason}). Check the desktop's internet connection, then choose Prepare tools and find phones again.`,
        { cause: error }
      );
    }
    if (createHash("sha256").update(bytes).digest("hex") !== checksum)
      throw new Error("Android tools checksum verification failed. Please retry the download.");
    const zip = path.join(temporary, "tools.zip");
    await fs.writeFile(zip, bytes);
    const unpacked = path.join(temporary, "unpacked");
    await extract(zip, { dir: unpacked });
    const adb = path.join(unpacked, "platform-tools", executable);
    if (!(await works(adb)))
      throw new Error("The downloaded Android tools cannot run on this desktop.");
    try {
      await fs.rename(unpacked, destination);
    } catch (error) {
      // Another setup may have published the same verified version concurrently.
      if (!(await works(path.join(destination, "platform-tools", executable)))) throw error;
    }
    return path.join(destination, "platform-tools", executable);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
