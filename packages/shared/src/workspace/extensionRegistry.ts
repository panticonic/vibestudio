/**
 * Generates the workspace extension-registry barrel.
 *
 * Extensions augment a global type registry: each extension's `index.ts`
 * declares `interface WorkspaceExtensions { "@scope/name": Api }` via
 * `declare module "@vibez1/extension"`. That augmentation is only active in a
 * TypeScript program that actually contains the extension's `index.ts`. The
 * repo-wide `tsc` gets this for free through `include: workspace/**`, but
 * scoped programs (the per-panel typecheck service, Monaco) only contain a
 * panel plus what it imports — and a panel calls `extensions.use("...")` with a
 * string, never importing the extension. So the registry comes up empty.
 *
 * The barrel closes that gap through ordinary imports rather than per-surface
 * special-casing: it type-only re-exports each extension's `Api`, which pulls
 * the extension module into the program (activating its augmentation). The
 * runtime SDK package re-exports it from its extensions surface, which every
 * panel reaches by importing `@workspace/runtime` — so the registry propagates
 * exactly like any other type. The set mirrors `include: workspace/**` (every
 * extension package present in the workspace), keeping all type-check surfaces
 * consistent.
 *
 * ## Delivery contract (host ⇄ workspace)
 *
 * The barrel is host-generated content delivered into WORKSPACE-OWNED source.
 * The host does not decide where it lives — the workspace does, by opting in:
 *
 *   - A workspace package declares a registry *sink* by checking in a file
 *     named {@link EXTENSION_REGISTRY_SINK_FILENAME} whose first line is the
 *     {@link EXTENSION_REGISTRY_SINK_DIRECTIVE} directive comment.
 *   - {@link writeExtensionRegistry} discovers sinks by scanning
 *     `<workspace>/packages/*` and rewrites each sink's contents in place
 *     (preserving the directive, so the file stays a sink).
 *   - No sink ⇒ no write. The workspace can opt out by deleting the file or
 *     removing the directive, and can relocate the registry by moving the
 *     file — the host follows the directive, not a hardcoded path.
 *   - The checked-in sink contents are the workspace-owned fallback: the
 *     package type-checks without host generation, using whatever registry
 *     was last committed (an empty registry `export {};` is valid).
 *
 * Today the sole sink lives in the runtime SDK package (`@workspace/runtime`
 * — see `src/server/buildV2/platformModules.ts` for the host's other runtime
 * package expectations), at `packages/runtime/src/shared/extensions-registry.ts`.
 * The generated exports are type-only, so bundlers erase the barrel from
 * built artifacts; only type-check surfaces consume it.
 */

import * as fs from "fs";
import * as path from "path";

/**
 * File name a workspace package uses to declare a registry sink. The name is
 * part of the contract; the location within the package is the workspace's
 * choice.
 */
export const EXTENSION_REGISTRY_SINK_FILENAME = "extensions-registry.ts";

/**
 * Directive comment that marks a file as a registry sink. Must appear on the
 * first line of the file. Generated output always starts with it, so a sink
 * stays a sink across regenerations.
 */
export const EXTENSION_REGISTRY_SINK_DIRECTIVE = "// @vibez1-extension-registry-sink";

interface ExtensionManifest {
  name?: string;
  vibez1?: { extension?: unknown; entry?: unknown };
}

/** Matches an extension's `declare module "@vibez1/extension" { ... }` block. */
const REGISTRY_AUGMENTATION = /declare\s+module\s+["']@vibez1\/extension["']/;

/** Directory names never descended into while scanning for sinks. */
const SINK_SCAN_SKIP_DIRS = new Set(["node_modules", "dist", "lib", "build", "out"]);

function aliasFor(packageName: string): string {
  return "Ext_" + packageName.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function isExtensionManifest(pkg: ExtensionManifest | null): pkg is ExtensionManifest & { name: string } {
  return Boolean(
    pkg?.name &&
      pkg.vibez1 &&
      typeof pkg.vibez1 === "object" &&
      "extension" in pkg.vibez1,
  );
}

function readManifest(dir: string): ExtensionManifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")) as ExtensionManifest;
  } catch {
    return null;
  }
}

/**
 * Whether an extension opts into the typed registry by augmenting
 * `WorkspaceExtensions` in its entry file. This is the same declaration the
 * repo-wide `tsc` reads via `include`, so gating the barrel on it keeps every
 * surface's registry identical. Infra extensions that don't self-register (e.g.
 * typecheck-service) are excluded, so their type graph never enters panels.
 */
function selfRegisters(dir: string, manifest: ExtensionManifest): boolean {
  const entry = typeof manifest.vibez1?.entry === "string" ? manifest.vibez1.entry : "index.ts";
  try {
    return REGISTRY_AUGMENTATION.test(fs.readFileSync(path.join(dir, entry), "utf-8"));
  } catch {
    return false;
  }
}

/**
 * Names of every extension package under `<workspacePath>/extensions/*` that
 * registers itself in the `WorkspaceExtensions` type registry.
 */
export function discoverExtensionPackageNames(workspacePath: string): string[] {
  const root = path.join(workspacePath, "extensions");
  const names: string[] = [];
  const consider = (dir: string): void => {
    const pkg = readManifest(dir);
    if (isExtensionManifest(pkg) && selfRegisters(dir, pkg)) names.push(pkg.name);
  };

  let top: fs.Dirent[];
  try {
    top = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of top) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const dir = path.join(root, entry.name);
    consider(dir);
  }
  return names;
}

/** Whether a file's contents declare it as a registry sink. */
function isSinkContent(content: string): boolean {
  return content.startsWith(EXTENSION_REGISTRY_SINK_DIRECTIVE);
}

function collectSinksIn(dir: string, sinks: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SINK_SCAN_SKIP_DIRS.has(entry.name)) continue;
      collectSinksIn(full, sinks);
      continue;
    }
    if (!entry.isFile() || entry.name !== EXTENSION_REGISTRY_SINK_FILENAME) continue;
    try {
      if (isSinkContent(fs.readFileSync(full, "utf-8"))) sinks.push(full);
    } catch {
      /* unreadable — not a sink */
    }
  }
}

/**
 * Absolute paths of every declared registry sink under
 * `<workspacePath>/packages/*`. A sink is a workspace-owned file named
 * {@link EXTENSION_REGISTRY_SINK_FILENAME} that starts with the
 * {@link EXTENSION_REGISTRY_SINK_DIRECTIVE} directive.
 */
export function findExtensionRegistrySinks(workspacePath: string): string[] {
  const sinks: string[] = [];
  const packagesRoot = path.join(workspacePath, "packages");
  let packageDirs: fs.Dirent[];
  try {
    packageDirs = fs.readdirSync(packagesRoot, { withFileTypes: true });
  } catch {
    return sinks;
  }
  for (const entry of packageDirs) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    collectSinksIn(path.join(packagesRoot, entry.name), sinks);
  }
  return sinks.sort();
}

/** Render the barrel contents for a set of extension package names. */
export function renderExtensionRegistry(packageNames: Iterable<string>): string {
  const sorted = [...new Set(packageNames)].sort();
  const header =
    `${EXTENSION_REGISTRY_SINK_DIRECTIVE}\n` +
    "// Workspace-owned registry sink — the Vibez1 host rewrites everything below the\n" +
    "// directive line whenever the workspace extension set changes (generator:\n" +
    "// @vibez1/shared/workspace/extensionRegistry). Keep the directive to stay\n" +
    "// subscribed; remove it (or delete the file) to opt out; move the file to\n" +
    "// relocate the registry. The committed contents are the fallback used when the\n" +
    "// host has not (re)generated the registry.\n" +
    "//\n" +
    "// Type-only re-exports that pull each workspace extension's module into the\n" +
    '// type-check program so its `declare module "@vibez1/extension"` registry\n' +
    "// augmentation is active. Re-exported from the runtime SDK's extensions\n" +
    '// surface, so any panel that imports `@workspace/runtime` can type-check\n' +
    '// `extensions.use("...")` against the full registry — the same set the\n' +
    "// repo-wide `tsc` sees via `include`.\n\n";
  if (sorted.length === 0) {
    return header + "export {};\n";
  }
  return (
    header +
    sorted.map((name) => `export type { Api as ${aliasFor(name)} } from "${name}";`).join("\n") +
    "\n"
  );
}

/**
 * Regenerate the registry barrel for a workspace, writing to every declared
 * sink (see module docs for the sink contract). Returns whether any sink
 * changed. No-op (returns false) when the workspace declares no sink.
 */
export function writeExtensionRegistry(workspacePath: string): boolean {
  const sinks = findExtensionRegistrySinks(workspacePath);
  if (sinks.length === 0) return false;

  const content = renderExtensionRegistry(discoverExtensionPackageNames(workspacePath));
  let changed = false;
  for (const sinkPath of sinks) {
    let existing: string | null = null;
    try {
      existing = fs.readFileSync(sinkPath, "utf-8");
    } catch {
      /* treat as absent */
    }
    if (existing === content) continue;
    fs.writeFileSync(sinkPath, content);
    changed = true;
  }
  return changed;
}
