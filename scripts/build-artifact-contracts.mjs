import fs from "node:fs";
import path from "node:path";

/** Retained developer instances and build coordination are never release inputs. */
export const DEVELOPMENT_DIST_ENTRIES = new Set([
  "host-generations", "source-server-prerequisites.lock", "host-build.lock",
]);

/** Inspect owned application outputs without entering runtime distributions or symlinks. */
export function applicationSourceMaps(dist) {
  const maps = [];
  const visit = (directory, prefix = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!prefix && (entry.name === "node" || DEVELOPMENT_DIST_ENTRIES.has(entry.name))) continue;
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) visit(path.join(directory, entry.name), relative);
      else if (entry.isFile() && entry.name.endsWith(".map")) maps.push(relative);
    }
  };
  visit(dist);
  return maps;
}

/** Node globals required by bundled CommonJS dependencies inside ESM artifacts. */
export const NODE_ESM_COMPAT_BANNER = `import { createRequire as __createRequire } from "node:module";
import { fileURLToPath as __fileURLToPath } from "node:url";
import { dirname as __pathDirname } from "node:path";
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __pathDirname(__filename);`;

/** Banner injected verbatim into the standalone Node ESM server artifact. */
export const SERVER_ESM_BANNER = `#!/usr/bin/env node
${NODE_ESM_COMPAT_BANNER}`;
