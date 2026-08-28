import * as fs from "node:fs";
import * as path from "node:path";
import { listPackage, uncache } from "@electron/asar";
import {
  assertNoBundledUserlandPaths,
  assertNoBundledUserlandSource,
} from "./packaged-userland-boundary.mjs";

const IROH_NATIVE_ARTIFACT = {
  "darwin-arm64": ["@number0", "iroh-darwin-arm64", "iroh.darwin-arm64.node"],
  "linux-x64": ["@number0", "iroh-linux-x64-gnu", "iroh.linux-x64-gnu.node"],
  "linux-arm64": ["@number0", "iroh-linux-arm64-gnu", "iroh.linux-arm64-gnu.node"],
  "win32-x64": ["@number0", "iroh-win32-x64-msvc", "iroh.win32-x64-msvc.node"],
  "win32-arm64": ["@number0", "iroh-win32-arm64-msvc", "iroh.win32-arm64-msvc.node"],
};

export function assertPackagedIrohBinding(resources, platform, arch) {
  const unpacked = path.join(resources, "app.asar.unpacked", "node_modules");
  const binding = path.join(unpacked, "@number0", "iroh", "index.js");
  if (!fs.existsSync(binding)) throw new Error(`Electron package has no Iroh binding: ${binding}`);
  const architecture = typeof arch === "string" ? arch : { 1: "x64", 3: "arm64" }[arch];
  const coordinates = IROH_NATIVE_ARTIFACT[`${platform}-${architecture}`];
  if (!coordinates)
    throw new Error(`No packaged Iroh artifact contract for ${platform}-${String(arch)}`);
  const artifact = path.join(unpacked, ...coordinates);
  if (!fs.existsSync(artifact))
    throw new Error(`Electron package has no matching Iroh native artifact: ${artifact}`);
}

export async function afterPack(context) {
  const resources = path.join(context.appOutDir, "resources");
  const archive = path.join(resources, "app.asar");
  if (!fs.existsSync(archive)) {
    throw new Error(`Electron package has no app.asar: ${archive}`);
  }

  // electron-builder hooks normally inspect one archive per process. Explicitly
  // evict @electron/asar's header cache as well so repeated programmatic pack
  // runs cannot validate the previous bytes at the same output path.
  uncache(archive);
  assertNoBundledUserlandPaths(listPackage(archive), "Electron app.asar");
  assertNoBundledUserlandSource(
    path.join(resources, "app.asar.unpacked"),
    "Electron app.asar.unpacked"
  );
  assertPackagedIrohBinding(resources, context.electronPlatformName, context.arch);

  const resourceEntries = fs
    .readdirSync(resources, { withFileTypes: true })
    .filter((entry) => entry.name !== "app.asar" && entry.name !== "app.asar.unpacked")
    .map((entry) => entry.name);
  assertNoBundledUserlandPaths(resourceEntries, "Electron resources");
  console.log("[packaged-userland-boundary] Electron package contains no bundled Base source.");
}
