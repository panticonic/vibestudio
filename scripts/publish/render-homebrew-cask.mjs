#!/usr/bin/env node
/**
 * Render the Homebrew Cask that distributes the macOS build.
 *
 * Squirrel refuses to auto-update a build without a Developer ID signature, so
 * an ad-hoc signed app has no in-app update path. A cask restores one through
 * the package manager the audience already runs — the same choice made for
 * Linux, where apt and dnf carry updates instead of an in-app updater.
 *
 * Usage: render-homebrew-cask.mjs <version> <dmg-path> <download-url>
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const [version, dmgPath, downloadUrl] = process.argv.slice(2);
if (!version || !dmgPath || !downloadUrl) {
  console.error("usage: render-homebrew-cask.mjs <version> <dmg-path> <download-url>");
  process.exit(1);
}

const sha256 = createHash("sha256").update(readFileSync(dmgPath)).digest("hex");

// `depends_on macos: ">= :sonoma"` mirrors electron-builder's minimumSystemVersion.
// Quarantine is left in place deliberately: an unsigned build should still be
// something the user consciously admits, not something a formula waves through.
process.stdout.write(`cask "vibestudio" do
  version "${version}"
  sha256 "${sha256}"

  url "${downloadUrl}",
      verified: "github.com/panticonic/vibestudio/"
  name "Vibestudio"
  desc "Stacked panel workspace for agentic workflows"
  homepage "https://vibestudio.app/"

  depends_on macos: ">= :sonoma"

  app "Vibestudio.app"

  zap trash: [
    "~/Library/Application Support/Vibestudio",
    "~/Library/Logs/Vibestudio",
    "~/Library/Preferences/app.vibestudio.app.plist",
    "~/Library/Saved Application State/app.vibestudio.app.savedState",
  ]
end
`);
console.error(`[cask] ${path.basename(dmgPath)} sha256=${sha256}`);
