// The exact files that must ship as PLAIN FILES for ownership to work in a
// packaged product. Packaging scripts (server/desktop bundles, the npm CLI
// package) import this list; they do not hardcode names.
//
// Why plain files: `Ownership.open` starts the reaper with
// `<runtime> reaper.mjs`. The reaper is a separate process, so it cannot live
// inside a bundle (or an asar archive: ship it unpacked, because the runtime
// that executes it may be Electron's Node mode or a plain `node`). It imports
// ONLY relative sibling `.mjs` files and `node:` builtins; no workspace package
// specifier, no TypeScript, no loader. `ownership.test.ts` scans the import
// graph and fails if this list and the graph ever disagree.
//
// The owner-side client (`ownership.mjs`) finds the reaper beside itself
// (`import.meta.url`). When the client is bundled, `import.meta.url` is the
// bundle file, so ship the reaper files in the bundle's directory. A
// product that places them elsewhere passes `Ownership.open({ reaperPath })`.

/**
 * Everything `reaper.mjs` loads, itself included. Ship these side by side in
 * one directory, byte for byte.
 */
export const OWNERSHIP_REAPER_FILES = Object.freeze([
  "reaper.mjs",
  "ownershipLedger.mjs",
  "ownedProcessIdentity.mjs",
  "darwinProcessObserver.mjs",
  "removeSealedTree.mjs",
]);

/**
 * The owner-side client as plain files (for consumers that do not bundle it,
 * such as the npm CLI package): the client modules plus the reaper files.
 */
export const OWNERSHIP_CLIENT_FILES = Object.freeze([
  "ownership.mjs",
  "ownershipLease.mjs",
  ...OWNERSHIP_REAPER_FILES,
]);
