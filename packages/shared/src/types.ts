// Shared types used across main, renderer, server, and preload

import type { CreateChildOptions, PanelPlacementHint } from "@vibestudio/types";
import type { CapabilityScope } from "@vibestudio/rpc";
import type { UnitAuthorityManifest } from "./authorityManifest.js";
import type { StateArgsSchema, StateArgsValue } from "./stateArgs.js";
import type { PanelFailureCode } from "./panel/observation.js";
import type { AppCapability, WorkspaceAppTarget } from "./unitManifest.js";
export type { ThemeConfig } from "./theme.js";

// Re-export types for consumers of this module
export type { StateArgsSchema, StateArgsValue };
export type { PanelPlacementHint };

// =============================================================================
// Package Manifest
// =============================================================================

/**
 * The `vibestudio` block of a workspace package's package.json.
 *
 * One canonical shape for panels, about pages, and workers. The build pipeline
 * (`src/server/buildV2`) and the runtime panel loader (`panelTypes.ts`) both
 * read from this same type. Each consumer uses the fields it cares about and
 * ignores the rest — workers ignore `dependencies` / `stateArgs`; panels ignore
 * `durable` / `framework`. `loadPanelManifest` enforces panel-specific
 * requirements (e.g., a non-empty `title`) at runtime, so all fields stay
 * optional in the type.
 */
export interface PackageManifest {
  /** Explicit test suites. Runtime selection is reviewed source, never a call-time fallback. */
  tests?: WorkspaceTestSuiteDeclaration[];
  /** Build V2-owned external dependency resolution policy for this unit's closure. */
  dependencyResolution?: {
    /** npm-compatible dependency overrides applied only while building consumers of this unit. */
    overrides?: Record<string, string>;
    /** Exact package@version selectors mapped to owner-relative patches and direct roots. */
    patches?: Record<string, { path: string; roots: string[] }>;
  };
  /** Authority requests sealed into this executable unit's build. */
  authority?: UnitAuthorityManifest;
  /** Human-readable display name shared by all workspace unit kinds. */
  displayName?: string;
  /** Display title (required at runtime for panels; workers don't need it). */
  title?: string;
  /** Optional description shown in the launcher and used as documentation. */
  description?: string;
  /** Semantic emoji or unit-relative image path used consistently everywhere this unit appears. */
  icon?: string;
  /** Entry file relative to the package root (e.g., `"index.tsx"`, `"index.ts"`). */
  entry?: string;
  /** Extension discriminator block. Presence marks this package as an extension unit. */
  extension?: {
    /** v1 accepts only eager activation (`"*"`). */
    activationEvents?: string[];
    /**
     * Extension dependency handling. Defaults to "auto": bundle ordinary JS
     * dependencies and externalize packages that need runtime assets/native code.
     */
    dependencyMode?: "auto" | "bundle" | "external";
    /**
     * API methods that return a streaming `Response` and must be routed through
     * `extensions.invokeStream`. Declared here so consumers never have to know
     * the extension's internals — the client resolves them automatically.
     */
    streamingMethods?: string[];
    /**
     * Provider-namespaced contracts implemented by this extension, keyed by
     * manifest provider slot. These methods are not part of the flat public
     * extension API and are dispatched only through the matching namespace.
     */
    providerContracts?: Record<string, { methods: string[] }>;
  };
  /** Future shared manifest discriminator for worker units. */
  worker?: Record<string, unknown>;
  /** Future shared manifest discriminator for panel units. */
  panel?: Record<string, unknown>;
  /** Native host app contract, validated by the app manifest descriptor. */
  app?: {
    target: WorkspaceAppTarget;
    capabilities?: AppCapability[];
    renderer?: string;
    preload?: string;
    /**
     * Package-root-relative modules dynamically selected on the normal startup
     * path. Their emitted closures are transferred with the initial artifact
     * bundle without changing when or whether the modules execute.
     */
    startupModules?: string[];
  };
  // ----- Panel-only fields -----
  /** Top-level package.json dependencies merged in by `loadPanelManifest`. */
  dependencies?: Record<string, string>;
  /** JSON Schema for validating panel state arguments. */
  stateArgs?: StateArgsSchema;
  /** Inject the host theme CSS variables into the panel iframe. */
  injectHostThemeVariables?: boolean;
  /** Hide this panel from the launcher UI. */
  hiddenInLauncher?: boolean;
  /** Auto-archive a panel when it has no children at startup. */
  autoArchiveWhenEmpty?: boolean;
  /** Default layout placement hint for this panel (call-site `placement` wins). */
  placement?: PanelPlacementHint;
  // ----- Build-pipeline fields -----
  /** Whether to emit linked source maps for this unit build. */
  sourcemap?: boolean;
  /** Import-map externals (panels: produces `<script type="importmap">`). */
  externals?: Record<string, string>;
  /**
   * Modules registered on `globalThis.__vibestudioModuleMap__` so eval'd code
   * can `require()` them by canonical specifier without an explicit import.
   */
  exposeModules?: string[];
  /** Additional packages to deduplicate beyond the framework defaults. */
  dedupeModules?: string[];
  /** Name of a workspace template directory in `workspace/templates/`. */
  template?: string;
  /** Resolved framework ID — set at graph time from template, or at build time from extracted source. */
  framework?: string;
  // ----- Worker-only fields -----
  /** Durable Object classes exported by this worker (workers only). */
  durable?: {
    classes: Array<{
      className: string;
      /** Stable host-reviewed typed receiver contract used by build discovery. */
      rpcSchema?: string;
    }>;
  };
  /**
   * Marks this worker as a selectable chat agent and supplies gallery metadata.
   * Presence of this block is what distinguishes chat-agent DOs from service DOs
   * (pubsub-channel, semantic control plane, fork, …) in the chat panel's agent picker.
   */
  agent?: { displayName?: string; description?: string };
  // Note: workspace services and HTTP routes are no longer declared per worker.
  // They live in `workspace/meta/vibestudio.yml` under `services:` and `routes:`,
  // joined against `singletonObjects:` for DO singleton keys.
}

export type WorkspaceTestRuntime = "browser" | "workerd" | "native";

export interface WorkspaceTestSuiteDeclaration {
  /** Unit-local stable suite name. */
  name: string;
  /** Production-matched execution realm. */
  runtime: WorkspaceTestRuntime;
  /** Unit-relative glob patterns. Files must be owned by exactly one suite. */
  include: string[];
}

export type ThemeMode = "light" | "dark" | "system";
export type ThemeAppearance = "light" | "dark";

export interface AppInfo {
  version: string;
  /** Connection mode: "local" (child process) or "remote" (standalone server) */
  connectionMode: "local" | "remote";
  /** Remote server hostname (only when connectionMode is "remote") */
  remoteHost?: string;
  /** Current connection status */
  connectionStatus: "connected" | "connecting" | "disconnected";
  /** Current Iroh network path; null for local or not-yet-established sessions. */
  remoteTransport?: RemoteTransportDiagnostics | null;
}

export interface RemoteTransportDiagnostics {
  path: "direct" | "relay";
  rttMs?: number;
  remoteAddress?: string;
  relayUrl?: string;
  endpointGeneration?: number;
  dialAttempts?: number;
  transmittedBytes?: number;
  receivedBytes?: number;
  lostBytes?: number;
  logicalSessions?: number;
  activeRequests?: number;
}

export interface PanelInfo {
  panelId: string;
  title?: string;
  source?: string;
  kind?: "workspace" | "browser";
  parentId?: string | null;
  partition: string;
  contextId: string;
  runtimeEntityId?: string | null;
  effectiveVersion?: string | null;
  buildKey?: string | null;
  executionDigest?: string | null;
  authorityRequests?: readonly CapabilityScope[];
  ref?: string;
  build?: {
    effectiveVersion?: string | null;
    ref?: string;
  };
}

// Panel-related types (shared between main and renderer)

/**
 * Build state for panels built by main process.
 * Used to show placeholder UI during build.
 */
export type PanelBuildState = "pending" | "cloning" | "building" | "ready" | "error";

/**
 * Failure produced while a host materializes a panel view. This is distinct
 * from a source build failure: retrying the same sealed build in a fresh view
 * is valid and must not require a rebuild.
 */
export interface PanelViewFailure {
  code: Extract<PanelFailureCode, "navigation_failed">;
  message: string;
}

export interface PanelArtifacts {
  htmlPath?: string;
  /** Runtime entity currently occupying the native host view. */
  hostedRuntimeEntityId?: string;
  bundlePath?: string;
  /** Source-resolution or compilation failure. */
  error?: string;
  /** Host view/navigation failure for an otherwise valid panel build. */
  viewFailure?: PanelViewFailure;
  buildRevision?: number;
  /** Build state for async main-process builds */
  buildState?: PanelBuildState;
  /** Human-readable progress message (e.g., "Installing dependencies...") */
  buildProgress?: string;
  /** Detailed build log (esbuild output, errors, etc.) */
  buildLog?: string;
}

export interface PanelBuildStatus {
  state?: PanelBuildState;
  revision?: number;
  artifactUrl?: string;
  bundlePath?: string;
  error?: string;
  progress?: string;
  log?: string;
}

export interface PanelViewStatus {
  exists: boolean;
  url?: string;
  /** Runtime entity whose renderer is currently presented in this view. */
  runtimeEntityId?: string;
  visible?: boolean;
  failure?: PanelViewFailure;
}

export interface PanelRuntimeStatus {
  leased: boolean;
  holderLabel?: string;
  platform?: "desktop" | "headless" | "mobile";
  hostConnectionId?: string;
  supportsCdp?: boolean;
  clientSessionId?: string;
  connectionId?: string;
}

export type PanelLifecycleOperation = "reload" | "rebuild" | "unload" | "close";

export interface PanelLifecycleResult {
  panelId: string;
  operation: PanelLifecycleOperation;
  status: string;
  loaded: boolean;
  rebuilt: boolean;
  reloaded: boolean;
  buildRevision?: number;
  effectiveVersion?: string | null;
  closedCount?: number;
}

export interface PanelExplicitState {
  build: PanelBuildStatus;
  view: PanelViewStatus;
  runtime?: PanelRuntimeStatus;
}

export type PanelFocusStatus =
  | "missing"
  | "focused"
  | "preparing"
  | "loaded"
  | "leased_elsewhere"
  | "build_failed"
  | "view_creation_failed";

export interface PanelFocusResult {
  panelId: string;
  status: PanelFocusStatus;
  focused: boolean;
  loaded: boolean;
  message?: string;
  holderLabel?: string;
}

/**
 * A per-user panel-tree forest (WP3). The single-tree `rootPanels` collapse is
 * replaced by N owner-grouped trees: every client sees every owner's roots
 * (mutual visibility is the feature, plan §0.0), grouped by `owner`. Roots with
 * no owner (pre-identity/system-seeded) group under the empty-string owner.
 */
export interface PanelTreeSnapshot {
  revision: number;
  forest: Array<{ owner: string; rootPanels: Panel[] }>;
}

export interface PanelRecoverySnapshot {
  revision: number;
  viewRevision: number;
  rootPanels: Panel[];
  collapsedIds: string[];
  focusedPanelId: string | null;
  focus?: PanelFocusResult;
}

// =============================================================================
// Tool Execution Result
// =============================================================================

/** Tool execution result sent from panel to main */
export interface ToolExecutionResult {
  /** Text content of the result */
  content: Array<{ type: "text"; text: string }>;
  /** Whether the tool execution resulted in an error */
  isError?: boolean;
  /** Optional structured data (e.g., for code execution results with components) */
  data?: unknown;
}

// =============================================================================
// Panel Type Discriminated Unions
// =============================================================================

// =============================================================================
// PanelSnapshot - Unified Panel State (New Architecture)
// =============================================================================

/**
 * Complete panel configuration at one point in history.
 * Explicitly embeds CreateChildOptions to ensure correspondence.
 */
export interface PanelSnapshot {
  /** Workspace-relative source path (e.g., "panels/chat", "about/new") */
  source: string;
  /** Resolved context ID (e.g., "ctx-panels-editor") - determines storage isolation */
  contextId: string;
  /** Panel options from CreateChildOptions (excluding eventSchemas, focus) */
  options: Omit<CreateChildOptions, "eventSchemas" | "focus">;
  /** Validated state args for this snapshot */
  stateArgs?: StateArgsValue;
  /** Actual URL after redirects (when applicable) */
  resolvedUrl?: string;
  /** If true, panel is auto-archived when it has no children (e.g., launcher panels) */
  autoArchiveWhenEmpty?: boolean;
  /** If true, this panel is privileged and approvals targeting it use severe tone. */
  privileged?: boolean;
  /**
   * Effective layout placement hint, resolved server-side at creation time
   * (call-site `placement` ?? manifest `placement`). The shell reads this one
   * value and never re-implements precedence.
   */
  placement?: PanelPlacementHint;
}

/**
 * Runtime navigation state for the WebContents/WebView that is currently
 * rendering a panel. This is intentionally not persisted as part of the
 * snapshot; it reflects the live browser-like surface.
 */
export interface PanelNavigationState {
  url?: string;
  pageTitle?: string;
  /** Opaque canonical favicon reference; shell renderers resolve bytes through browser-data. */
  favicon?: {
    pageUrl: string;
    updatedAt: number;
  };
  isLoading?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  mediaPlaying?: boolean;
}

export interface PanelSnapshotHistory {
  entries: PanelSnapshot[];
  index: number;
}

/**
 * Panel runtime state. Configuration comes from current snapshot.
 */
export interface Panel {
  id: string;
  title: string;
  /** Semantic icon declared by the current workspace panel manifest. */
  icon?: string;
  /** Immutable workspace state that owns a relative icon declaration. */
  iconVersion?: string;
  /** Immutable workspace state used to retrieve the declared icon bytes. */
  iconState?: string;
  runtimeEntityId?: string | null;
  effectiveVersion?: string | null;
  /** Content-addressed BuildV2 artifact executed by this panel incarnation. */
  buildKey?: string | null;
  executionDigest?: string | null;
  authorityRequests?: readonly CapabilityScope[];
  /**
   * Owning-user id (WP3): the user whose tree this panel's root belongs to.
   * Attribution/provenance only — NOT an inter-user security token (plan §0.0).
   * Stamped from the creating caller's `subject.userId`; a subtree moved into
   * another user's tree re-owns to the destination root's owner (WP3 §10.1).
   * Absent for pre-identity/system-seeded panels.
   */
  owner?: string;

  // Tree structure
  children: Panel[];
  selectedChildId?: string | null;
  snapshot: PanelSnapshot;
  history?: PanelSnapshotHistory;

  // Runtime only (not in snapshot)
  artifacts: PanelArtifacts;
  state?: PanelExplicitState;
  navigation?: PanelNavigationState;
}

// =============================================================================
// Workspace & Settings Types
// =============================================================================

export interface WorkspaceEntry {
  /**
   * Opaque stable workspace id ("ws_<rand>") minted once when the workspace is
   * first registered. Decoupled from the display name and on-disk path (both of
   * which may change); membership rows and per-user scoping key on this id.
   * Never reused: delete + recreate mints a fresh id.
   */
  workspaceId: string;
  name: string;
  lastOpened: number;
}

/** Actions available in panel context menus */
export type PanelContextMenuAction =
  | "reload"
  | "command-agent"
  | "reload-panel"
  | "reload-view"
  | "force-reload"
  | "force-reload-view"
  | "rebuild-panel"
  | "stop"
  | "back"
  | "forward"
  | "copy-address"
  | "copy-panel-id"
  | "open-external"
  | "duplicate"
  | "open-child-beside"
  | "add-child"
  | "add-child-below"
  | "open-in-new-column"
  | "close-pane"
  | "toggle-pin"
  | "unload"
  | "archive";

// =============================================================================
// Panel Move/Drag-and-Drop Types
// =============================================================================

/**
 * Request to move a panel using stable neighboring siblings.
 * Used for drag-and-drop reordering and reparenting.
 */
export interface MovePanelRequest {
  panelId: string;
  /** New parent ID, or null to make it a root panel */
  newParentId: string | null;
  /** Sibling immediately before the moved panel, if any. */
  beforePanelId?: string | null;
  /** Sibling immediately after the moved panel, if any. */
  afterPanelId?: string | null;
}

/**
 * Request for paginated children.
 */
export interface GetChildrenPaginatedRequest {
  parentId: string;
  offset: number;
  limit: number;
}

/**
 * Response for paginated children.
 */
export interface PaginatedChildren {
  children: PanelSummary[];
  total: number;
  hasMore: boolean;
}

/**
 * Response for paginated root panels.
 */
export interface PaginatedRootPanels {
  panels: PanelSummary[];
  total: number;
  hasMore: boolean;
}

// =============================================================================
// Panel Summary Types (for tree queries and UI)
// =============================================================================

/**
 * Panel summary for tree queries (minimal data for UI).
 */
export interface PanelSummary {
  id: string;
  title: string;
  icon?: string;
  iconVersion?: string;
  iconState?: string;
  /** Workspace unit that owns a relative image icon. */
  source?: string;
  childCount: number;
  buildState?: string;
  position: number;
  favicon?: PanelNavigationState["favicon"];
}

/**
 * Panel ancestor for breadcrumb rendering.
 */
export interface PanelAncestor {
  id: string;
  title: string;
  icon?: string;
  iconVersion?: string;
  iconState?: string;
  /** Workspace unit that owns a relative image icon. */
  source?: string;
  favicon?: PanelNavigationState["favicon"];
  childCount: number;
  depth: number;
}

/**
 * Sibling group at a descendant level for breadcrumb rendering.
 */
export interface DescendantSiblingGroup {
  depth: number;
  parentId: string;
  selectedId: string;
  siblings: PanelSummary[];
}

// =============================================================================
// Workspace Discovery Types (for workspace units and launchable panels)
// =============================================================================

/**
 * A node in the workspace tree.
 * Folders contain children, workspace units are leaves (children = []).
 */
export interface WorkspaceNode {
  /** Directory or unit name. */
  name: string;
  /**
   * Relative path from workspace root using forward slashes.
   * Example: "panels/editor"
   */
  path: string;
  /** True if this directory is a workspace unit root. */
  isUnit: boolean;
  /**
   * If this is a launchable panel (has vibestudio config).
   * Note: We intentionally include entries even if some fields are missing
   * (e.g., no title) - better to show them in the UI and let the build system
   * report the real error than to silently hide repos with incomplete configs.
   */
  launchable?: {
    type: "app";
    title: string;
    description?: string;
    icon?: string;
    /**
     * Short digest of a `./`-relative `icon`'s bytes, so its URL can name its
     * content.
     *
     * Without it the icon route has to answer `private, no-cache` — the source
     * is mutable, so nothing may store the response — and a client re-fetches
     * every unit's icon on every launcher render. Measured on a phone: 20 of 57
     * round trips for one panel open, a few hundred bytes each. With it the
     * route answers `immutable`, so the fetch happens once per icon, ever.
     */
    iconVersion?: string;
    hidden?: boolean;
  };
  /**
   * Package metadata if this unit has a package.json with a name.
   */
  packageInfo?: {
    name: string;
    version?: string;
  };
  /**
   * Skill metadata if this unit has a SKILL.md file with YAML frontmatter.
   */
  skillInfo?: {
    name: string;
    description: string;
  };
  /** Child nodes (empty for workspace units since they're leaves). */
  children: WorkspaceNode[];
}

/**
 * Complete workspace tree with root-level children.
 */
export interface WorkspaceTree {
  /** Root children (top-level directories) */
  children: WorkspaceNode[];
}

// Shell IPC channels (shell renderer -> main for service calls)
