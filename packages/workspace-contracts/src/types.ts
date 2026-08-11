/**
 * Configuration types for Vibestudio.
 *
 * Configuration is split between:
 * 1. Central config (~/.config/vibestudio/ or equivalent):
 *    - config.yml: Model roles and app-wide settings
 *    - .secrets.yml: API keys (format: `providername: secret`)
 *    - .env: Environment variables
 *
 * 2. Workspace (project directory):
 *    - meta/vibestudio.yml: Init panels and shared git remotes
 *    - meta/AGENTS.md: Agent system prompt
 *    - panels/: Panel source code
 *    - apps/: Trusted workspace-owned frontend apps
 *    - projects/: Plain editable repositories that are not runtime units
 *    - .cache/: Build cache
 */

export { WORKSPACE_APP_PACKAGE_SCOPE, WORKSPACE_EXTENSION_PACKAGE_SCOPE } from "./sourceDirs.js";

/**
 * Standard model roles with fallback behavior
 */
export type StandardModelRole = "smart" | "coding" | "fast" | "cheap";

/**
 * Extended model configuration for AI SDK.
 * Allows specifying provider, model ID, and additional parameters.
 */
export interface ModelConfig {
  /** Provider ID (e.g., "anthropic", "openai", "groq") */
  provider: string;
  /** Model ID within the provider (e.g., "claude-sonnet-4-20250514") */
  model: string;
  /** Optional temperature (0-2, default varies by model) */
  temperature?: number;
  /** Optional maximum output tokens */
  maxTokens?: number;
  /** Optional top-p sampling (0-1) */
  topP?: number;
  /** Optional top-k sampling */
  topK?: number;
  /** Optional presence penalty (-2 to 2) */
  presencePenalty?: number;
  /** Optional frequency penalty (-2 to 2) */
  frequencyPenalty?: number;
  /** Optional stop sequences */
  stopSequences?: string[];
}

/** Model role value used by the model-selection resolver. */
export type ModelRoleValue = string | ModelConfig;

/** Named model roles with the standard smart/coding and fast/cheap fallbacks. */
export interface ModelRoleConfig {
  smart?: ModelRoleValue;
  coding?: ModelRoleValue;
  fast?: ModelRoleValue;
  cheap?: ModelRoleValue;
  [key: string]: ModelRoleValue | undefined;
}

/**
 * Build cache configuration
 */
export interface CacheConfig {
  /** Maximum number of cache entries in main process (default: 100000) */
  maxEntries?: number;
  /** Maximum total cache size in bytes in main process (default: 5GB) */
  maxSize?: number;
  /** Cache expiration in dev mode, in milliseconds (default: 5 minutes) */
  expirationMs?: number;
}

/**
 * Central application configuration from ~/.config/vibestudio/config.yml
 * This is shared across all workspaces.
 */
export interface CentralConfig {
  /** Build cache configuration */
  cache?: CacheConfig;
}

/**
 * Workspace Git remote declarations
 */
export interface GitConfig {
  /**
   * Shared git remotes declared by workspace repo path.
   *
   * Example:
   * git:
   *   remotes:
   *     panels:
   *       chat:
   *         origin:
   *           url: https://github.com/example/chat.git
   *           branch: main
   *         ci:
   *           url: https://github.com/example/chat-ci.git
   */
  remotes?: WorkspaceGitRemotesConfig;
  /**
   * Per-repo upstream tracking declarations. Presence enables tracking;
   * `autoPush` controls whether exported commits are pushed unattended.
   */
  upstreams?: WorkspaceGitUpstreamsConfig;
}

/**
 * A dependency declaration authored in `meta/vibestudio.yml`.
 *
 * Source manifests intentionally name only the repository they depend on and
 * the logical credential needed to reach it. Exact source coordinates belong
 * to the generated lock.
 */
export interface WorkspaceTemplateDeclaration {
  /** Credential-free canonical Git URL. */
  url: string;
  /** Unique profile credential label, never concrete credential material. */
  credential?: string;
}

/** One exact, reproducible template source coordinate. */
export interface WorkspaceTemplatePin extends WorkspaceTemplateDeclaration {
  /** Human-readable source ref used to resolve the exact commit. */
  ref: string;
  /** Full 40-character lowercase Git SHA-1 object id. */
  commit: string;
  /** Canonical digest of the complete admitted template tree. */
  snapshot: `v1-sha256:${string}`;
}

/** Reviewed moving pointer used only by an explicit registry refresh. */
export interface WorkspaceTemplateRegistryDeclaration {
  url: string;
  /** Canonical promotion branch or tag ref. */
  ref: string;
  credential?: string;
}

export interface WorkspaceTemplatesConfig {
  /** Direct URL-only roots. Transitive relationships are read from their manifests. */
  use: WorkspaceTemplateDeclaration[];
  /** Exact root-level resolution overrides keyed by normalized template URL. */
  overrides?: Record<string, WorkspaceTemplatePin>;
  /** Presentation/promotion registry source; never part of an installed template lock. */
  registry?: WorkspaceTemplateRegistryDeclaration;
  /** Exact bootstrap root already adopted into the ordinary template graph. */
  bootstrapAdopted?: WorkspaceTemplatePin;
  /** Reviewed exact excluded-section decisions keyed by `<nodeId>:<section>`. */
  suggestionDecisions?: Record<
    string,
    { digest: `v1-sha256:${string}`; decision: "accepted" | "declined" }
  >;
}

/**
 * What a template calls itself: a name and one sentence, as the template's own
 * manifest states them.
 *
 * Self-asserted and unverified, so it may only ever be a title. Origin remains
 * the pin URL, which is the one fact about a source nobody gets to assert about
 * themselves — a template naming itself after this platform must therefore
 * change nothing about where the review says its bytes came from.
 */
export interface WorkspaceTemplatePresentation {
  name?: string;
  description?: string;
}

export interface WorkspaceTemplateLockNode {
  nodeId: string;
  alias: string;
  pin: WorkspaceTemplatePin;
  /** Direct parent node ids. Parents precede children in `nodes`. */
  parents: string[];
  fragmentDigest: `v1-sha256:${string}`;
  /**
   * What this template says it is called and what it says it does — sanitized,
   * self-asserted, and unverified. It may head a card as a title; it is never
   * identity, which stays `pin.url`.
   */
  presentation?: WorkspaceTemplatePresentation;
  /** Exact excluded authority suggestions proven by this node's pinned manifest. */
  suggestions: {
    trust?: { digest: `v1-sha256:${string}`; value: unknown };
    providers?: { digest: `v1-sha256:${string}`; value: unknown };
  };
}

export interface WorkspaceTemplateLockContribution {
  nodeId: string;
  subtreeDigest: `v1-sha256:${string}`;
}

export interface WorkspaceTemplateLockRepository {
  /** Every template layer contributing changes to this repository. */
  contributions: WorkspaceTemplateLockContribution[];
}

/** Checked projection committed in `meta/templates.lock.yml`. */
export interface WorkspaceTemplateLock {
  version: 1;
  fingerprint: `v1-sha256:${string}`;
  /** Normalized URL-only roots from the top layer that generated this closure. */
  roots: WorkspaceTemplateDeclaration[];
  /** Normalized top-layer pin overrides that generated this closure. */
  overrides: Record<string, WorkspaceTemplatePin>;
  nodes: WorkspaceTemplateLockNode[];
  repositories: Record<string, WorkspaceTemplateLockRepository>;
  verification: "verified" | "deferred";
}

/** Host-owned bootstrap intent for a workspace created from an external root. */
export interface WorkspaceCreationDescriptor {
  version: 1;
  workspaceId: string;
  rootTemplate: WorkspaceTemplatePin;
}

export interface WorkspaceGitRemoteConfig {
  name: string;
  url: string;
  branch?: string;
}

export interface WorkspaceGitRemoteDeclaration {
  url: string;
  branch?: string;
}

export type WorkspaceGitRemotesConfig = Record<
  string,
  Record<string, Record<string, WorkspaceGitRemoteDeclaration>>
>;

export interface WorkspaceGitUpstreamConfig {
  /** Name of a declared shared remote for this repo. */
  remote: string;
  /** Remote branch; defaults to the declared remote branch, then main. */
  branch?: string;
  /** Push automatically after protected main advances. */
  autoPush?: boolean;
  /**
   * Logical credential requirement resolved through the profile-local binding
   * table. Concrete credential identities never enter workspace configuration.
   */
  credential?: string;
  /** Optional exported-commit author email override. */
  authorEmail?: string;
  /** Optional exported-commit author name override. Suppresses per-actor names. */
  authorName?: string;
}

export type WorkspaceGitUpstreamsConfig = Record<
  string,
  Record<string, WorkspaceGitUpstreamConfig>
>;

/**
 * An entry in the initPanels array — panel source + optional stateArgs.
 */
export interface InitPanelEntry {
  source: string;
  stateArgs?: Record<string, unknown>;
}

export type PanelRestorePolicy = "focused" | "none";

/**
 * A stable Durable Object singleton declared in `workspace/meta/vibestudio.yml`.
 * Every workspace `services[]` / `routes[]` entry that targets a DO class must
 * resolve to one of these via `(source, className)`.
 */
export interface WorkspaceSingletonObjectDecl {
  /** Worker source path, e.g. `"workers/model-settings"`. */
  source: string;
  /** Durable Object class name as exported from the worker module. */
  className: string;
  /** Stable singleton object key (e.g. `"workspace-model-settings"`). */
  key: string;
  /** Optional context binding (free-form; e.g. workspace id). */
  contextId?: string;
}

/** Workspace-authored service declaration in `workspace/meta/vibestudio.yml`. */
export type WorkspaceServiceDecl = {
  source: string;
  name: string;
  title?: string;
  /** Verb phrase completing "Allow X to …" — e.g. "send and receive messages". */
  action: string;
  description?: string;
  /**
   * Whether this service envelope belongs in the primary install summary.
   * Optional while authoring so an incomplete declaration can still reach the
   * build system and receive an actionable diagnostic.
   */
  notability?: "headline" | "everyday";
  presentation: {
    domain: "files" | "sharing" | "accounts" | "web" | "automation" | "people" | "computer";
    verb: "see" | "act" | "manage";
    substanceKind?: "change-set" | "send" | "deletion" | "custom";
  };
  protocols?: string[];
  authority: {
    principals: ("host" | "user" | "code" | "session" | "mission")[];
    /**
     * `consent` makes use of the service itself a permission. `declared` treats
     * the binding as reviewed wiring and leaves effects to method authority.
     */
    binding?: "consent" | "declared";
  };
} & (
  | { durableObject: { className: string }; worker?: never }
  | { worker: { routePath: string }; durableObject?: never }
);

/**
 * One declarative scheduled job ("cron") in `workspace/meta/vibestudio.yml`'s
 * `recurring:` section. The server's RecurringRegistry dispatches `method` on
 * the target DO on schedule. Editing the list is a gated meta write: newly
 * declared or changed jobs surface in the meta-push approval as scheduled-job
 * entries before they ever run.
 */
export interface WorkspaceRecurringDecl {
  /** Unique job name within the workspace, e.g. "news-briefing-default". */
  name: string;
  /** Target Durable Object. `objectKey` defaults to the job name. */
  target: { source: string; className: string; objectKey?: string };
  /** DO method to invoke on schedule. */
  method: string;
  /** JSON-serializable arguments passed to the method. */
  args?: unknown[];
  /**
   * Cadence: `every` is a duration ("30m", "6h", "1d"); optional `at` is a
   * local-time anchor "HH:MM" for day-multiple intervals (e.g. daily at 08:00).
   */
  schedule: { every: string; at?: string };
}

export interface WorkspaceHeartbeatDecl {
  name: string;
  target: { source: string; className: string; objectKey?: string };
  channel?: {
    mode?: "subscribed" | "fixed";
    id?: string;
    handle?: string;
  };
  schedule: {
    every: string;
    jitter?: string;
    at?: string;
    activeHours?: { start: string; end: string; timezone?: "local" | string };
  };
  context?: {
    mode?: "heartbeat" | "full" | "isolated";
    promptFile?: string;
    includeWorkspacePrompt?: boolean;
    includeSkillIndex?: boolean;
    tokenBudget?: number;
  };
  behavior?: {
    skipWhenBusy?: boolean;
    delivery?: "none" | "channel" | "last-contact";
    ackToken?: string;
    failureBackoff?: { base?: string; max?: string };
  };
}

/**
 * Extension declaration in `workspace/meta/vibestudio.yml`. The declared list is
 * the single source of truth for which extensions a workspace uses and the only
 * install/remove surface. Editing it (a gated meta write) triggers the joint
 * unit approval and registry reconciliation.
 */
export interface WorkspaceExtensionDecl {
  /**
   * Extension identity: a workspace-relative repo path
   * (e.g. `"extensions/image-service"`) OR the package
   * name (e.g. `"@workspace-extensions/image-service"`). Both resolve via the
   * build graph.
   */
  source: string;
  /** Git ref the extension floats to. Defaults to `"main"`. */
  ref?: string;
}

/**
 * App declaration in `workspace/meta/vibestudio.yml`. Apps are the frontend
 * counterpart to extensions: privileged, workspace-coupled units that are
 * build-gated, approval-gated, and hot-loaded onto a shipped host.
 */
export interface WorkspaceAppDecl {
  /**
   * App identity: a workspace-relative repo path
   * (e.g. `"apps/shell"`) OR the package name
   * (e.g. `"@workspace-apps/shell"`). Both resolve via the build graph.
   */
  source: string;
  /** Git ref the app floats to. Defaults to `"main"`. */
  ref?: string;
}

/**
 * A provider slot naming the workspace package that fulfils one host-integrated
 * role (eval engine, portable runtime, CDP client). `source` is the unit's
 * build-graph identity — a package name (e.g. `"@workspace/eval"`) or a
 * workspace-relative repo path. The host resolves it through the build
 * service; it never hardcodes a unit name of its own.
 */
export interface WorkspaceUnitProviderDecl {
  source: string;
}

/**
 * A provider slot naming the workspace extension that fulfils one
 * host-integrated role. `extension` follows the same identity convention as
 * `extensions[]` (`extensions/name` or `@workspace-extensions/name`) and must
 * also appear in the declared `extensions[]` list.
 */
export interface WorkspaceExtensionProviderDecl {
  extension: string;
}

/**
 * Manifest-declared provider slots: which workspace units fulfil roles the
 * host integrates with. The manifest (an approval-gated meta write) is the
 * single source of truth — when a slot is absent the corresponding host
 * feature is cleanly disabled with a diagnostic; the host NEVER falls back to
 * a hardcoded unit name.
 */
export interface WorkspaceProvidersDecl {
  /** The eval engine library the EvalDO loads (executeSandbox/ScopeManager/…). */
  evalEngine?: WorkspaceUnitProviderDecl;
  /**
   * The portable runtime package backing the eval sandbox's
   * `@workspace/runtime` surface. Contract: the unit MUST expose `./hosted`,
   * `./panel-runtime`, and `./portable` package-export subpaths (the hosted
   * runtime factories, panel-runtime factories, and portable helpers).
   */
  evalRuntime?: WorkspaceUnitProviderDecl;
  /** The CDP client library seeded into eval runs that reference CDP. */
  cdpClient?: WorkspaceUnitProviderDecl;
  /** The browser-data broker extension. */
  browserData?: WorkspaceExtensionProviderDecl;
  /** Extension-backed external Git upstream engine used by gitInterop. */
  gitInterop?: WorkspaceExtensionProviderDecl;
  /** Extension-backed Claude Code launch/session adapter. */
  claudeCode?: WorkspaceExtensionProviderDecl;
}

/**
 * Manifest-declared app trust grants. Sources use the `extensions[]`/`apps[]`
 * identity convention (`apps/name` or `@workspace-apps/name`). Because the
 * manifest lives in the approval-gated meta repo, editing these lists rides
 * the existing main-advance approval flow — trust changes stay user-gated.
 *
 * A workspace app listed under `chromeApps` may render host chrome
 * (`panel-hosting`). An app not listed never receives that capability even if
 * its own unit manifest requests it.
 */
export interface WorkspaceTrustDecl {
  chromeApps?: string[];
  /** Apps allowed to manage pairing and connection recovery. */
  connectionManagementApps?: string[];
}

/**
 * Per-host-target app declaration: which declared workspace app a host target
 * (electron / react-native / terminal) prefers to launch, plus any extensions
 * that must be running before that app can build (used for startup-ordering
 * diagnostics, e.g. the react-native build provider extension).
 */
export interface WorkspaceHostTargetDecl {
  /** App identity: `apps/name` or `@workspace-apps/name`. */
  app: string;
  /** Extensions (`extensions/name` or `@workspace-extensions/name`) that must
   *  start before this app can build. */
  requiresExtensions?: string[];
}

/** Host targets a workspace app can serve. */
export type WorkspaceHostTargetName = "electron" | "react-native" | "terminal";

export type WorkspaceHostTargetsDecl = Partial<
  Record<WorkspaceHostTargetName, WorkspaceHostTargetDecl>
>;

/** HTTP route declaration in `workspace/meta/vibestudio.yml`. */
export interface WorkspaceRouteDecl {
  source: string;
  path: string;
  methods?: ("GET" | "POST" | "PUT" | "DELETE" | "PATCH")[];
  durableObject?: { className: string };
  /** When true, binds the canonical regular-worker instance's default fetch. */
  worker?: boolean;
  auth?: "public" | "admin-token" | "caller-token";
  websocket?: boolean;
}

/**
 * Workspace configuration from meta/vibestudio.yml
 * This is specific to each workspace/project.
 */
export interface WorkspaceConfig {
  /** Resolved workspace identifier. If omitted on disk, derived from the workspace location. */
  id: string;
  /** Semantic storage, host projections, and workspace runtime ABI epoch. */
  systemEpoch: number;
  /**
   * Repo used as the base for bare VCS file paths such as `notes.md`.
   * This is workspace policy, not a host convention: omit it to require every
   * tracked path to name its repo explicitly.
   */
  defaultRepo?: string;
  /** Workspace Git remote declarations */
  git?: GitConfig;
  /**
   * Panels to create on first initialization (when panel tree is empty).
   * These panels are created as root panels in the specified order.
   * Example: [{ source: "panels/chat", stateArgs: { initialPrompt: "Hello", systemPrompt: "You are..." } }]
   */
  initPanels?: InitPanelEntry[];
  /**
   * Startup/reconnect view restoration policy.
   * - "focused" (default): restore/load only the focused panel view.
   * - "none": restore tree state only; views load when selected.
   */
  panelRestorePolicy?: PanelRestorePolicy;
  /** Workspace-wide default agent config (model + behavior) for new agents.
   *  Stored as one field; written only via an explicit "Save as defaults". */
  defaultAgentConfig?: {
    model?: string;
    thinkingLevel?: string;
    fastMode?: boolean;
    approvalLevel?: number;
  };
  /**
   * Stable DO singletons. Any `services[]` / `routes[]` entry referencing a
   * `durableObject.className` MUST have a matching `(source, className)` row
   * here. Workspace load fails otherwise.
   */
  singletonObjects?: WorkspaceSingletonObjectDecl[];
  /** Workspace-authored service declarations. */
  services?: WorkspaceServiceDecl[];
  /** HTTP route declarations exposed under `/_r/w/<source>/...`. */
  routes?: WorkspaceRouteDecl[];
  /**
   * Declarative extension set for this workspace — the single source of truth
   * for which extensions are in use. Editing this list is the only way to
   * install or remove an extension; the edit is a gated meta write that
   * triggers the joint approval and reconciliation. Absent or empty means no
   * extensions (reconciliation removes any left in the registry).
   */
  extensions?: WorkspaceExtensionDecl[];
  /**
   * Declarative scheduled jobs ("cron"). The RecurringRegistry syncs this
   * list on startup and after approved meta pushes; absent or empty removes
   * all scheduled jobs.
   */
  recurring?: WorkspaceRecurringDecl[];
  /**
   * Agent-owned heartbeat declarations. The workspace reconciler configures
   * target DOs; target agents own scheduling and model turns.
   */
  heartbeats?: WorkspaceHeartbeatDecl[];
  /**
   * Declarative privileged frontend app set for this workspace. Absent or
   * empty means no apps; the reconciler removes anything not declared here.
   */
  apps?: WorkspaceAppDecl[];
  /**
   * Provider slots: which workspace units fulfil host-integrated roles
   * (eval engine/runtime, cdp client, git interop, browser-data broker). A
   * missing slot cleanly disables the corresponding host feature.
   */
  providers?: WorkspaceProvidersDecl;
  /**
   * App trust grants for chrome rendering. Approval-gated via the meta repo.
   */
  trust?: WorkspaceTrustDecl;
  /** Preferred app (and startup-ordering constraints) per host target. */
  hostTargets?: WorkspaceHostTargetsDecl;
}

/**
 * Userland-owned source layer for workspace composition. The template
 * composer stores this separately from the flattened WorkspaceConfig consumed
 * by the host.
 */
export type WorkspaceConfigTopLayer = Omit<WorkspaceConfig, "id"> & {
  /** Direct semantic template relationships. */
  templates?: WorkspaceTemplatesConfig;
  /** Canonical inherited declaration keys disabled by the workspace layer. */
  disable?: string[];
};

/**
 * Resolved workspace with computed paths.
 *
 * Directory layout:
 *   workspaces/{name}/source/   ← path (workspace source root, meta/vibestudio.yml)
 *   workspaces/{name}/state/    ← statePath (Electron userData + runtime state)
 */
export interface Workspace {
  /** Absolute path to workspace source directory (meta/vibestudio.yml and unit source trees) */
  path: string;
  /** Absolute path to state directory (Electron userData, databases, cache) */
  statePath: string;
  /** Parsed workspace configuration */
  config: WorkspaceConfig;
  /** Absolute path to panels directory (source/panels) */
  panelsPath: string;
  /** Absolute path to packages directory (source/packages) */
  packagesPath: string;
  /** Absolute path to the current disposable context-projection cache namespace. */
  contextProjectionsPath: string;
  /** Absolute path to cache directory (state/.cache) */
  cachePath: string;
  /** Absolute path to agents directory (source/agents) */
  agentsPath: string;
  /** Absolute path to projects directory (source/projects) */
  projectsPath: string;
}

/**
 * Resolved central config location
 */
export interface CentralConfigPaths {
  /** Absolute path to central config directory */
  configDir: string;
  /** Absolute path to config.yml */
  configPath: string;
  /** Absolute path to .secrets.yml */
  secretsPath: string;
  /** Absolute path to .env */
  envPath: string;
}
