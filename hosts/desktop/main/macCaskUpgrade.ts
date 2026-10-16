import fs from "node:fs";
import path from "node:path";
import type { LinuxUpgrade } from "./releaseUpdate.js";

/** A cask owns this bundle only when its installed app resolves to this app. */
export function macCaskUpgrade(
  executable: string,
  brewPaths = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
): LinuxUpgrade | null {
  const bundle = path.dirname(path.dirname(path.dirname(executable)));
  for (const brew of brewPaths) {
    if (!fs.existsSync(brew)) continue;
    const cask = path.join(path.dirname(path.dirname(brew)), "Caskroom", "vibestudio");
    try {
      for (const version of fs.readdirSync(cask)) {
        const installed = path.join(cask, version, "Vibestudio.app");
        if (!fs.existsSync(installed)) continue;
        if (fs.realpathSync(installed) !== fs.realpathSync(bundle)) continue;
        return {
          display: "brew upgrade --cask vibestudio",
          argv: [brew, "upgrade", "--cask", "vibestudio"],
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return null;
}
