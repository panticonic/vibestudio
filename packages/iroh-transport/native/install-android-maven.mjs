#!/usr/bin/env node
/**
 * Install the repaired `computer.iroh` Android artifacts into the local Maven
 * repository, so the mobile build resolves the stream-cancellation repair
 * instead of upstream 1.1.0.
 *
 * This only unpacks a published archive; building it needs rustup, the Android
 * NDK, and about twenty minutes, which is why `build-android-aar.mjs` runs in
 * CI and every other build machine runs this instead. Re-running is a no-op
 * once the version is present.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IROH_ANDROID_REPAIR } from "./androidRepair.mjs";

const home = process.env.HOME ?? process.env.USERPROFILE;
if (!home) throw new Error("Cannot locate a home directory for the local Maven repository");
const repository = join(home, ".m2", "repository", "computer", "iroh");
const marker = join(repository, "iroh-android", IROH_ANDROID_REPAIR.version);

if (existsSync(marker) && !process.argv.includes("--force")) {
  console.log(`computer.iroh:iroh-android:${IROH_ANDROID_REPAIR.version} is already installed`);
  process.exit(0);
}

const staging = mkdtempSync(join(tmpdir(), "iroh-android-"));
try {
  const archive = join(staging, "android-maven.tar.gz");
  const response = await fetch(IROH_ANDROID_REPAIR.archiveUrl);
  if (!response.ok) {
    throw new Error(`${IROH_ANDROID_REPAIR.archiveUrl} returned ${response.status}`);
  }
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  mkdirSync(repository, { recursive: true });
  // The archive is rooted at computer/iroh, holding the iroh JAR the AAR
  // depends on alongside iroh-android itself.
  execFileSync("tar", ["xzf", archive, "-C", repository], { stdio: "inherit" });
} finally {
  rmSync(staging, { recursive: true, force: true });
}

if (!existsSync(marker)) throw new Error(`Archive did not contain ${marker}`);
console.log(`installed computer.iroh:iroh-android:${IROH_ANDROID_REPAIR.version} into ${repository}`);
