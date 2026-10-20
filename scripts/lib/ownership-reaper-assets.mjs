import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { OWNERSHIP_REAPER_FILES } from "../../packages/shared/src/ownershipFiles.mjs";

/** Artifact paths (relative to the repository root) of the staged reaper files. */
export const OWNERSHIP_REAPER_ARTIFACTS = Object.freeze(
  OWNERSHIP_REAPER_FILES.map((filename) => `dist/${filename}`)
);

// The reaper is a separate Node process started as `<runtime> reaper.mjs`, and
// the owner-side client finds it beside the bundle it was compiled into. Stage
// the files byte for byte, as plain files, next to every host bundle.
export function copyOwnershipReaperAssets(distDirectory) {
  // Resolved at call time: importing this module must stay side-effect free
  // (test environments load build scripts where `import.meta.url` is not a file URL).
  const sourceDirectory = fileURLToPath(new URL("../../packages/shared/src/", import.meta.url));
  for (const filename of OWNERSHIP_REAPER_FILES) {
    fs.copyFileSync(path.join(sourceDirectory, filename), path.join(distDirectory, filename));
  }
}
