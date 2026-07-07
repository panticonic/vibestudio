import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.join(repoRoot, "workspace");
const lockfile = path.join(workspaceRoot, "pnpm-lock.yaml");
const modulesFile = path.join(workspaceRoot, "node_modules", ".modules.yaml");
const installedLockfile = path.join(workspaceRoot, "node_modules", ".pnpm", "lock.yaml");

function exists(file) {
  return fs.existsSync(file);
}

function mtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

if (!exists(path.join(workspaceRoot, "package.json"))) {
  process.exit(0);
}

if (!exists(modulesFile)) {
  console.error(
    [
      "[userland] workspace/node_modules is missing.",
      "Run `pnpm bootstrap` for a full checkout setup, or `pnpm install:userland` after root dependencies are installed.",
    ].join("\n")
  );
  process.exit(1);
}

const installStamp = Math.max(mtimeMs(modulesFile), mtimeMs(installedLockfile));
if (exists(lockfile) && mtimeMs(lockfile) > installStamp) {
  console.error(
    [
      "[userland] workspace/pnpm-lock.yaml is newer than workspace/node_modules.",
      "Run `pnpm install:userland` to refresh the split userland install.",
    ].join("\n")
  );
  process.exit(1);
}
