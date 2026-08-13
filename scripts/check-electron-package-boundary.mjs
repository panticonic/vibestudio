import * as fs from "node:fs";
import * as path from "node:path";
import { listPackage, uncache } from "@electron/asar";
import {
  assertNoBundledUserlandPaths,
  assertNoBundledUserlandSource,
} from "./packaged-userland-boundary.mjs";

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

  const resourceEntries = fs
    .readdirSync(resources, { withFileTypes: true })
    .filter((entry) => entry.name !== "app.asar" && entry.name !== "app.asar.unpacked")
    .map((entry) => entry.name);
  assertNoBundledUserlandPaths(resourceEntries, "Electron resources");
  console.log("[packaged-userland-boundary] Electron package contains no bundled Base source.");
}
