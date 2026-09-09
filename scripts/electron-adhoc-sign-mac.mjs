import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Give an unsigned macOS build the ad-hoc signature it needs to run at all.
 *
 * Apple Silicon refuses to execute a binary carrying no signature whatsoever.
 * Electron ships its own binaries signed, but packaging rewrites the bundle —
 * renaming it, injecting resources, editing Info.plist — which invalidates that,
 * and electron-builder skips signing entirely when it finds no identity
 * (macPackager: `if (!identity) return false`). The result would be a DMG that
 * cannot launch, rather than one that merely warns.
 *
 * An ad-hoc signature fixes execution and nothing else: Gatekeeper still
 * quarantines the download, and Squirrel still refuses to auto-update a build
 * without a Developer ID. Distribution for those builds goes through Homebrew
 * Cask instead.
 *
 * Runs in `afterPack` because `afterSign` is never dispatched when no signing
 * occurred. That is only correct while nothing modifies the binary between the
 * two, so the one thing that would — Electron fuses — is asserted against.
 */
export default async function adhocSignMac(context) {
  if (context.electronPlatformName !== "darwin") return;

  // A real identity signs properly moments later; leave that build alone.
  if (process.env["CSC_LINK"] || process.env["CSC_NAME"]) return;

  if (context.packager.config.electronFuses != null) {
    throw new Error(
      "Electron fuses rewrite the binary after afterPack, which would invalidate this ad-hoc " +
        "signature. Move ad-hoc signing after the fuse step before configuring fuses."
    );
  }

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  // A bundle that fails verification here would fail to launch on the user's
  // machine, where the reason is far less legible.
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  console.log(`[adhoc-sign] ad-hoc signed ${path.basename(app)} (unsigned release build)`);
}
