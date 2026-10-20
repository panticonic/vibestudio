import type * as fs from "node:fs";

/**
 * Remove a tree that may contain deliberately sealed (0o500) directories.
 * Plain `.mjs` so the reaper process, which runs without a TypeScript
 * loader, can use it.
 */
export function removeSealedTree(
  target: string,
  deps?: {
    rmSync?: typeof fs.rmSync;
    chmodSync?: typeof fs.chmodSync;
    lstatSync?: typeof fs.lstatSync;
  }
): void;
