export const WORKSPACE_SOURCE_DIRS = [
  "meta",
  "panels",
  "clients",
  "packages",
  "agents",
  "workers",
  "extensions",
  "skills",
  "about",
  "terminal-apps",
  "templates",
  "projects",
] as const;

export type WorkspaceSourceDir = (typeof WORKSPACE_SOURCE_DIRS)[number];

export const WORKSPACE_STATE_DIRS = [".cache", ".databases", ".context-projections"] as const;

export const WORKSPACE_IMPORT_PARENT_DIRS = [
  "panels",
  "clients",
  "packages",
  "agents",
  "workers",
  "extensions",
  "skills",
  "about",
  "terminal-apps",
  "templates",
  "projects",
] as const;

export type WorkspaceImportParentDir = (typeof WORKSPACE_IMPORT_PARENT_DIRS)[number];

// ---------------------------------------------------------------------------
// Buildable-unit taxonomy
//
// `WORKSPACE_SOURCE_DIRS` above lists EVERY directory in the workspace source
// tree. The build system (src/server/buildV2) only scans a SUBSET of those for
// buildable units: meta/, agents/, and projects/ hold source/content but are
// not scanned for build graph nodes. Model that subset explicitly here so the
// build system, the graph scopes, and the packaged-template staging script all
// derive from one place instead of re-hardcoding overlapping lists.
// ---------------------------------------------------------------------------

/** The build-graph node kind a buildable directory's units produce. */
export type BuildableUnitKind =
  | "package"
  | "panel"
  | "worker"
  | "extension"
  | "client"
  | "template";

export interface BuildableUnitDir {
  /** Workspace-relative directory name (a member of WORKSPACE_SOURCE_DIRS). */
  dir: WorkspaceSourceDir;
  /** Graph node kind produced for units discovered in this directory. */
  kind: BuildableUnitKind;
  /**
   * npm package scope units in this directory publish under, or `null` when the
   * directory's units are not `@workspace*`-scoped (templates use `template:*`
   * synthetic names rather than a package scope).
   */
  scope: string | null;
}

/**
 * Package-name scopes for workspace unit kinds. The scope conventions are a
 * host-owned contract: `workspace/clients/foo` publishes as `@workspace-clients/foo`
 * and `workspace/extensions/bar` as `@workspace-extensions/bar`. Centralized
 * here (and referenced by BUILDABLE_UNIT_DIRS below) so host code never
 * re-spells the scope strings.
 */
export const WORKSPACE_CLIENT_PACKAGE_SCOPE = "@workspace-clients/" as const;
export const WORKSPACE_EXTENSION_PACKAGE_SCOPE = "@workspace-extensions/" as const;
export const WORKSPACE_TERMINAL_APP_PACKAGE_SCOPE = "@workspace-terminal-apps/" as const;

/**
 * Terminal apps are panels hosted by terminals instead of browser views: the
 * same unit kind, build pipeline, admission, identity and per-instance state,
 * built as a Node program that runs in a workspace PTY. Their location is what
 * makes them terminal-hosted; the manifest never selects it.
 */
export const TERMINAL_APP_DIR = "terminal-apps" as const;

/** Whether a panel unit at `relativePath` is hosted by terminals. */
export function isTerminalAppLocation(relativePath: string): boolean {
  return relativePath.replace(/\\/gu, "/").replace(/^\/+/u, "").split("/")[0] === TERMINAL_APP_DIR;
}

/**
 * Directories the build system scans for buildable units, in scan order, each
 * paired with the graph node kind and package scope it produces. This is the
 * single source of truth for `packageGraph.discoverPackageGraph` (which dirs to
 * scan) and `WORKSPACE_PACKAGE_SCOPES` (which scopes mark an internal dep).
 *
 * INTENTIONALLY a subset of WORKSPACE_SOURCE_DIRS — adding an entry here makes
 * the build system discover a new directory, so keep it deliberate.
 */
export const BUILDABLE_UNIT_DIRS: readonly BuildableUnitDir[] = [
  { dir: "packages", kind: "package", scope: "@workspace/" },
  { dir: "panels", kind: "panel", scope: "@workspace-panels/" },
  { dir: "clients", kind: "client", scope: WORKSPACE_CLIENT_PACKAGE_SCOPE },
  { dir: "about", kind: "panel", scope: "@workspace-about/" },
  { dir: TERMINAL_APP_DIR, kind: "panel", scope: WORKSPACE_TERMINAL_APP_PACKAGE_SCOPE },
  { dir: "workers", kind: "worker", scope: "@workspace-workers/" },
  { dir: "extensions", kind: "extension", scope: WORKSPACE_EXTENSION_PACKAGE_SCOPE },
  { dir: "skills", kind: "package", scope: "@workspace-skills/" },
  { dir: "templates", kind: "template", scope: null },
] as const;

/**
 * Package scopes that mark a dependency as an internal workspace edge. Derived
 * from BUILDABLE_UNIT_DIRS so the scope list can never drift from the scanned
 * directories.
 */
export const WORKSPACE_PACKAGE_SCOPES: readonly string[] = BUILDABLE_UNIT_DIRS.flatMap((d) =>
  d.scope ? [d.scope] : []
);

/**
 * Resolve the identity owned by a unit's workspace location. Manifests must
 * agree with this identity; they never select or override their unit kind.
 */
export function expectedBuildUnitName(relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
  const [section, name, ...rest] = normalized.split("/");
  if (!section || !name || rest.length > 0) return null;
  const descriptor = BUILDABLE_UNIT_DIRS.find(({ dir }) => dir === section);
  if (!descriptor) return null;
  return descriptor.kind === "template" ? `template:${name}` : `${descriptor.scope}${name}`;
}
