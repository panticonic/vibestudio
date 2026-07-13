/**
 * Configuration loading for Vibestudio.
 *
 * Two configuration sources:
 * 1. Central config (~/.config/vibestudio/): Models, secrets, env vars (shared)
 * 2. Workspace (~/.config/vibestudio/workspaces/{name}/): vibestudio.yml, panels, etc.
 *
 * Workspace resolution: CLI --workspace=name → VIBESTUDIO_WORKSPACE env → null (show init UI)
 */

import fs from "node:fs";
import * as path from "path";
import { getCentralDataPath, getWorkspacesDir, getWorkspaceDir } from "@vibestudio/env-paths";
import YAML from "yaml";
import dotenv from "dotenv";
import { z } from "zod";
import { createDevLogger } from "@vibestudio/dev-log";
import { parseWorkspaceConfigContentWithId, resolveWorkspaceTrustGrants } from "./configParser.js";
import { setWorkspaceAppTrust } from "../chromeTrust.js";
export {
  resolveDeclaredApps,
  resolveDeclaredExtensions,
  resolveHostTargetRequiredExtensions,
} from "./configParser.js";

const log = createDevLogger("Workspace");
const DESKTOP_AUTO_APPROVE_ONCE_FILE = "desktop-auto-approve-once";

/** Carry a trusted in-app create action across the desktop relaunch. */
export function markDesktopAutoApproveOnce(wsDir: string): void {
  const stateDir = path.join(wsDir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, DESKTOP_AUTO_APPROVE_ONCE_FILE), "created-in-app\n", "utf8");
}

/** Consume the one-shot create marker. A missing marker is the normal path. */
export function consumeDesktopAutoApproveOnce(wsDir: string): boolean {
  const marker = path.join(wsDir, "state", DESKTOP_AUTO_APPROVE_ONCE_FILE);
  try {
    fs.unlinkSync(marker);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    console.warn(`[Workspace] Could not consume ${marker}:`, error);
    return false;
  }
}
import type {
  Workspace,
  WorkspaceConfig,
  CentralConfig,
  CentralConfigPaths,
  WorkspaceEntry,
} from "./types.js";
import type { CentralDataManager } from "../centralData.js";
import {
  getExistingWorkspaceTemplateDir,
  getWorkspaceTemplateCandidates,
} from "../runtimePaths.js";
import { WORKSPACE_SOURCE_DIRS, WORKSPACE_STATE_DIRS } from "./sourceDirs.js";

const WORKSPACE_CONFIG_FILE = "meta/vibestudio.yml";
const CENTRAL_CONFIG_FILE = "config.yml";
const SECRETS_FILE = ".secrets.yml";
const ENV_FILE = ".env";
const WORKSPACE_DELETE_MAX_RETRIES = 10;
const WORKSPACE_DELETE_RETRY_DELAY_MS = 100;
const WORKSPACE_DELETION_MARKER = "deletion.json";
const WORKSPACE_DELETION_MARKER_VERSION = 1;

const ModelConfigSchema = z
  .object({
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
    topP: z.number().min(0).max(1).optional(),
    topK: z.number().int().nonnegative().optional(),
    presencePenalty: z.number().min(-2).max(2).optional(),
    frequencyPenalty: z.number().min(-2).max(2).optional(),
    stopSequences: z.array(z.string()).optional(),
  })
  .strict()
  .refine((value) => value.provider !== "claude-agent", {
    message: "The claude-agent model provider is not supported",
    path: ["provider"],
  });

const ModelRoleValueSchema = z.union([
  z
    .string()
    .regex(/^[^:\s]+:[^\s]+$/, "Expected a provider:model reference")
    .refine((value) => !value.startsWith("claude-agent:"), {
      message: "The claude-agent model provider is not supported",
    }),
  ModelConfigSchema,
]);

export const CentralConfigSchema = z
  .object({
    models: z.record(z.string().min(1), ModelRoleValueSchema).optional(),
    cache: z
      .object({
        maxEntries: z.number().int().positive().optional(),
        maxSize: z.number().int().positive().optional(),
        expirationMs: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict() satisfies z.ZodType<CentralConfig>;

// =============================================================================
// Central Config
// =============================================================================

/**
 * Get the central config directory path (shared across all workspaces).
 * - Linux: ~/.config/vibestudio
 * - macOS: ~/Library/Application Support/vibestudio
 * - Windows: %APPDATA%/vibestudio
 */
export function getCentralConfigDir(): string {
  return getCentralDataPath();
}

// Central-config dir management lives in `centralAuth.ts` because it is a
// central-data concern, not a workspace concern.
import { ensureCentralConfigDir } from "../centralAuth.js";

/**
 * Get all central config paths
 */
export function getCentralConfigPaths(): CentralConfigPaths {
  const configDir = getCentralConfigDir();
  return {
    configDir,
    configPath: path.join(configDir, CENTRAL_CONFIG_FILE),
    secretsPath: path.join(configDir, SECRETS_FILE),
    envPath: path.join(configDir, ENV_FILE),
  };
}

/**
 * Load central config from ~/.config/vibestudio/config.yml
 */
export function loadCentralConfig(): CentralConfig {
  const paths = getCentralConfigPaths();

  if (!fs.existsSync(paths.configPath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(paths.configPath, "utf-8");
    return CentralConfigSchema.parse(YAML.parse(content) ?? {});
  } catch (error) {
    throw new Error(`Failed to load central config at ${paths.configPath}`, { cause: error });
  }
}

/**
 * Load secrets from central .secrets.yml
 * Format: providername: secret (flat key-value)
 */
export function loadSecrets(): Record<string, string> {
  const paths = getCentralConfigPaths();
  return loadSecretsFromPath(paths.secretsPath);
}

export function loadSecretsFromPath(secretsPath: string): Record<string, string> {
  if (!fs.existsSync(secretsPath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(secretsPath, "utf-8");
    const secrets = YAML.parse(content) as Record<string, string>;
    return secrets ?? {};
  } catch (error) {
    console.warn(`[Config] Failed to load ${secretsPath}:`, error);
    return {};
  }
}

/**
 * Load environment from central .env file into process.env
 */
export function loadCentralEnvFile(): void {
  const paths = getCentralConfigPaths();

  if (fs.existsSync(paths.envPath)) {
    dotenv.config({ path: paths.envPath });
  }
}

/**
 * Load central environment from ~/.config/vibestudio/.env into process.env
 */
export function loadCentralEnv(): void {
  loadCentralEnvFile();
}

/**
 * Save secrets to central .secrets.yml
 */
export function saveSecrets(secrets: Record<string, string>): void {
  const paths = getCentralConfigPaths();
  saveSecretsToPath(paths.secretsPath, secrets);
}

export function saveSecretsToPath(secretsPath: string, secrets: Record<string, string>): void {
  try {
    // Audit finding #51 (cross-cutting), F-04 / F-17 (creds + filesystem
    // reports): `.secrets.yml` was previously written with default umask
    // (0o644), relying on the parent dir being 0o700. Force 0o600 explicitly
    // and re-chmod after write to repair files created with looser modes by
    // older code.
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(secretsPath, YAML.stringify(secrets), { encoding: "utf-8", mode: 0o600 });
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(secretsPath, 0o600);
      } catch {
        /* best-effort */
      }
    }
  } catch (error) {
    console.error("[Config] Failed to save secrets:", error);
    throw error;
  }
}

/**
 * Save central config to ~/.config/vibestudio/config.yml
 */
export function saveCentralConfig(config: CentralConfig): void {
  const paths = getCentralConfigPaths();

  try {
    ensureCentralConfigDir();
    // Audit finding #51: central config may carry provider references that
    // imply token presence; treat as secret-adjacent and lock to 0o600.
    const canonical = CentralConfigSchema.parse(config);
    fs.writeFileSync(paths.configPath, YAML.stringify(canonical), {
      encoding: "utf-8",
      mode: 0o600,
    });
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(paths.configPath, 0o600);
      } catch {
        /* best-effort */
      }
    }
  } catch (error) {
    console.error("[Config] Failed to save central config:", error);
    throw error;
  }
}

// =============================================================================
// Workspace
// =============================================================================

const WORKSPACE_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const WORKSPACE_NAME_MAX_LENGTH = 64;

/**
 * Resolve workspace name from CLI --workspace=name or VIBESTUDIO_WORKSPACE env var.
 * Returns the validated name string or null if neither is set.
 * Throws if the name is present but invalid (prevents path traversal).
 */
export function resolveWorkspaceName(): string | null {
  let raw: string | undefined;

  // 1. CLI argument: --workspace=name or --workspace name
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--workspace=")) {
      raw = arg.slice("--workspace=".length);
      break;
    }
  }
  if (!raw) {
    const idx = process.argv.indexOf("--workspace");
    if (idx !== -1) {
      const nextArg = process.argv[idx + 1];
      if (nextArg && !nextArg.startsWith("--")) {
        raw = nextArg;
      }
    }
  }

  // 2. Environment variable
  if (!raw) {
    raw = process.env["VIBESTUDIO_WORKSPACE"];
  }

  if (!raw) return null;

  // Validate to prevent path traversal (e.g., "../otherdir")
  validateWorkspaceName(raw);
  return raw;
}

/**
 * Validate a workspace name.
 * Must be alphanumeric with hyphens/underscores, max 64 chars.
 */
function validateWorkspaceName(name: string): void {
  if (!name) throw new Error("Workspace name cannot be empty");
  if (name.length > WORKSPACE_NAME_MAX_LENGTH) {
    throw new Error(`Workspace name too long (max ${WORKSPACE_NAME_MAX_LENGTH} chars)`);
  }
  if (!WORKSPACE_NAME_RE.test(name)) {
    throw new Error("Workspace name must contain only letters, numbers, hyphens, and underscores");
  }
}

/**
 * Resolve the workspace template directory for first-run workspace creation.
 *
 * Packaged builds ship workspace-template/ as an Electron resource. Dev uses
 * workspace/ at the app root. The candidate selection is shared with the rest
 * of runtime path resolution so dev and packaged follow the same contract.
 *
 * Returns null if no template directory exists.
 */
export function resolveWorkspaceTemplateDir(appRoot: string): string | null {
  const debug = process.env["VIBESTUDIO_DEBUG_PATHS"] === "1";
  const templateDir = getExistingWorkspaceTemplateDir(appRoot, WORKSPACE_CONFIG_FILE);
  if (debug) {
    console.log(
      `[Workspace] resolveWorkspaceTemplateDir appRoot=${appRoot} candidates=${JSON.stringify(
        getWorkspaceTemplateCandidates(appRoot)
      )} selected=${templateDir ?? "(none)"}`
    );
  }
  return templateDir;
}

/**
 * Initialize a new managed workspace directory.
 *
 * Source options (mutually exclusive, exactly one):
 * - `templateDir`: Copy source dirs from a local directory (e.g., the shipped workspace template)
 * - `forkFrom`:   Copy source dirs from another managed workspace by name
 *
 * Workspaces are always created from a template or an existing workspace fork.
 * Fails if the directory already exists on disk.
 */
export function initWorkspace(
  name: string,
  opts?: { templateDir?: string; forkFrom?: string }
): void {
  validateWorkspaceName(name);

  const wsDir = getWorkspaceDir(name);

  if (fs.existsSync(wsDir)) {
    throw new Error(`Workspace directory already exists: ${wsDir}`);
  }

  // Resolve template source directory for template/fork
  let templateSrc: string | null = null;
  if (opts?.templateDir && opts.forkFrom) {
    throw new Error("Workspace creation accepts exactly one of templateDir or forkFrom");
  } else if (opts?.templateDir) {
    templateSrc = opts.templateDir;
  } else if (opts?.forkFrom) {
    validateWorkspaceName(opts.forkFrom);
    templateSrc = path.join(getWorkspaceDir(opts.forkFrom), "source");
    if (!fs.existsSync(path.join(templateSrc, WORKSPACE_CONFIG_FILE))) {
      throw new Error(`Source workspace "${opts.forkFrom}" does not exist`);
    }
  }
  if (!templateSrc) {
    throw new Error("Workspace creation requires a templateDir or forkFrom workspace");
  }

  const workspacesDir = getWorkspacesDir();
  fs.mkdirSync(workspacesDir, { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(workspacesDir, `.create-${name}-`));
  const stagedSourceRoot = path.join(stagingDir, "source");
  const stagedStateRoot = path.join(stagingDir, "state");
  let published = false;

  try {
    fs.mkdirSync(stagedSourceRoot, { recursive: true });
    for (const dir of WORKSPACE_SOURCE_DIRS) {
      const src = path.join(templateSrc, dir);
      if (fs.existsSync(src)) {
        copyDirRecursive(src, path.join(stagedSourceRoot, dir));
      }
    }

    for (const dir of WORKSPACE_SOURCE_DIRS) {
      fs.mkdirSync(path.join(stagedSourceRoot, dir), { recursive: true });
    }

    fs.mkdirSync(stagedStateRoot, { recursive: true });
    for (const dir of WORKSPACE_STATE_DIRS) {
      fs.mkdirSync(path.join(stagedStateRoot, dir), { recursive: true });
    }

    const stagedConfigPath = path.join(stagedSourceRoot, WORKSPACE_CONFIG_FILE);
    if (!fs.existsSync(stagedConfigPath)) {
      throw new Error(`Workspace template is missing ${WORKSPACE_CONFIG_FILE}: ${templateSrc}`);
    }

    // Validate against the FINAL managed path before publishing. Parsing the
    // staged file directly would derive the temporary directory name as the
    // workspace id and would let malformed manifests become visible on disk.
    parseWorkspaceConfigContent(
      fs.readFileSync(stagedConfigPath, "utf-8"),
      path.join(wsDir, "source")
    );

    fs.renameSync(stagingDir, wsDir);
    published = true;
  } finally {
    if (!published && fs.existsSync(stagingDir)) {
      fs.rmSync(stagingDir, {
        recursive: true,
        force: true,
        maxRetries: WORKSPACE_DELETE_MAX_RETRIES,
        retryDelay: WORKSPACE_DELETE_RETRY_DELAY_MS,
      });
    }
  }
  log.info(`[Workspace] Created managed workspace "${name}" at ${wsDir}`);
}

/** Recursively copy a directory, skipping .git, node_modules, and .cache. */
function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".cache")
        continue;
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export { WORKSPACE_SOURCE_DIRS, WORKSPACE_STATE_DIRS };

/**
 * Load and parse vibestudio.yml from a workspace directory.
 *
 * Loading the ACTIVE workspace manifest also seeds this process's workspace
 * app trust grants (`trust.chromeApps` → chromeTrust.ts). This is the single
 * establishment point for manifest-declared app trust: any process that owns
 * a workspace on disk (server, local Electron main) enforces the declared list;
 * parse-only consumers
 * (historical-commit previews via `parseWorkspaceConfigContent*`) do NOT
 * seed, so previewing a candidate manifest never changes live trust.
 */
export function loadWorkspaceConfig(workspacePath: string): WorkspaceConfig {
  const configPath = path.join(workspacePath, WORKSPACE_CONFIG_FILE);

  if (!fs.existsSync(configPath)) {
    throw new Error(`${WORKSPACE_CONFIG_FILE} not found at ${workspacePath}`);
  }

  const content = fs.readFileSync(configPath, "utf-8");
  const config = parseWorkspaceConfigContent(content, workspacePath);
  setWorkspaceAppTrust(resolveWorkspaceTrustGrants(config));
  return config;
}

export function parseWorkspaceConfigContent(
  content: string,
  workspacePath: string
): WorkspaceConfig {
  // Workspace id is not read from disk. Managed workspaces derive it from the
  // data-dir folder name; explicit external workspaces derive it from their
  // absolute workspace root path.
  return parseWorkspaceConfigContentWithId(content, deriveWorkspaceId(workspacePath));
}

function deriveWorkspaceId(workspacePath: string): string {
  const sourceRoot = path.resolve(workspacePath);
  const workspaceRoot =
    path.basename(sourceRoot) === "source" ? path.dirname(sourceRoot) : sourceRoot;
  const workspacesDir = path.resolve(getWorkspacesDir());

  if (path.dirname(workspaceRoot) === workspacesDir) {
    return path.basename(workspaceRoot);
  }
  return workspaceRoot;
}

/**
 * Create a fully resolved Workspace object from a managed workspace directory.
 * The wsDir contains source/ (workspace source state) and state/ (runtime data).
 */
export function createWorkspace(wsDir: string): Workspace {
  const resolvedDir = path.resolve(wsDir);
  const sourceRoot = path.join(resolvedDir, "source");
  const stateRoot = path.join(resolvedDir, "state");

  const panelsPath = path.join(sourceRoot, "panels");
  const packagesPath = path.join(sourceRoot, "packages");
  const contextsPath = path.join(stateRoot, ".contexts");
  const cachePath = path.join(stateRoot, ".cache");
  const agentsPath = path.join(sourceRoot, "agents");
  const projectsPath = path.join(sourceRoot, "projects");

  // Ensure directory structure exists
  fs.mkdirSync(panelsPath, { recursive: true });
  fs.mkdirSync(projectsPath, { recursive: true });
  fs.mkdirSync(contextsPath, { recursive: true });
  fs.mkdirSync(cachePath, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });

  const config = loadWorkspaceConfig(sourceRoot);

  return {
    path: sourceRoot,
    statePath: stateRoot,
    config,
    panelsPath,
    packagesPath,
    contextsPath,
    cachePath,
    agentsPath,
    projectsPath,
  };
}

// =============================================================================
// Workspace Resolution (shared between Electron and headless server)
// =============================================================================

export interface ResolveWorkspaceOpts {
  /** Explicit managed workspace root path */
  wsDir?: string;
  /** Workspace name (resolved via getWorkspaceDir) */
  name?: string;
  /** App root for template resolution (required when init is true) */
  appRoot?: string;
  /** Auto-create from template if workspace doesn't exist */
  init?: boolean;
}

export interface ResolvedWorkspace {
  /** Managed workspace root directory */
  wsDir: string;
  /** Fully resolved workspace object */
  workspace: Workspace;
  /** Workspace name (derived from dir basename if not provided) */
  name: string;
  /** Whether workspace was newly created during this call */
  created: boolean;
}

/**
 * Resolve a workspace by name or path, optionally creating from template.
 *
 * Used by both Electron main and headless server to share workspace
 * initialization logic.
 *
 * Throws if workspace doesn't exist and init is false.
 */
export function resolveOrCreateWorkspace(opts: ResolveWorkspaceOpts): ResolvedWorkspace {
  let wsDir = opts.wsDir;
  let name = opts.name;

  if (!wsDir && name) {
    wsDir = getWorkspaceDir(name);
  }
  if (!wsDir) {
    throw new Error("No workspace specified (provide wsDir or name)");
  }
  if (!name) {
    name = path.basename(wsDir);
  }

  const configPath = path.join(wsDir, "source", WORKSPACE_CONFIG_FILE);
  let created = false;

  if (!fs.existsSync(configPath)) {
    if (!opts.init) {
      throw new Error(`Workspace not found at ${wsDir}`);
    }
    // Never infer that an existing directory is disposable just because its
    // manifest is missing. It may contain panels, source, or state that the
    // user can recover by restoring source/meta/vibestudio.yml.
    if (fs.existsSync(wsDir)) {
      const entries = fs.readdirSync(wsDir);
      if (entries.length > 0) {
        throw new Error(
          `Workspace exists at ${wsDir} but ${WORKSPACE_CONFIG_FILE} is missing. ` +
            "Restore the manifest or choose a different workspace name; existing files were not changed."
        );
      }
      // An empty directory contains no user data and is a common remnant of an
      // interrupted create. initWorkspace intentionally requires the target not
      // to exist, so remove only this proven-empty shell before scaffolding it.
      fs.rmdirSync(wsDir);
    }
    const templateDir = opts.appRoot ? resolveWorkspaceTemplateDir(opts.appRoot) : null;
    initWorkspace(name, templateDir ? { templateDir } : undefined);
    created = true;
    log.info(`[Workspace] Created "${name}"${templateDir ? " from template" : ""}`);
  }

  const workspace = createWorkspace(wsDir);
  return { wsDir, workspace, name, created };
}

/**
 * Create a new workspace and register it in the central data store.
 * Used for user-initiated workspace creation (UI wizard, CLI).
 * Fails if the workspace already exists in the registry.
 */
export function createAndRegisterWorkspace(
  name: string,
  centralData: CentralDataManager,
  opts?: { templateDir?: string; forkFrom?: string }
): WorkspaceEntry {
  if (centralData.hasWorkspace(name)) {
    throw new Error(`Workspace "${name}" already exists`);
  }
  const resolvedOpts = resolveWorkspaceCreationOpts(opts);
  initWorkspace(name, resolvedOpts);
  try {
    return centralData.addWorkspace(name);
  } catch (error) {
    try {
      removeWorkspaceTree(getWorkspaceDir(name));
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Workspace "${name}" registration failed and its published directory could not be removed`
      );
    }
    throw error;
  }
}

interface StagedWorkspaceDeletion {
  workspaceDir: string;
  trashRoot: string;
  trashWorkspaceDir: string;
}

interface WorkspaceDeletionMarker {
  version: typeof WORKSPACE_DELETION_MARKER_VERSION;
  name: string;
  workspaceId: string;
}

export interface WorkspaceDeletionRecoveryFailure {
  trashRoot: string;
  message: string;
}

export interface WorkspaceDeletionRecoveryReport {
  finalized: string[];
  restored: string[];
  failures: WorkspaceDeletionRecoveryFailure[];
}

/**
 * Remove a managed workspace from the visible filesystem namespace and the
 * SQLite registry as one compensated lifecycle operation.
 *
 * The initial rename is atomic and same-filesystem. If the catalog transaction
 * fails, the original directory is restored before the error escapes. The
 * central-data transaction itself removes memberships, resume targets, and
 * revocation-cleanup rows together with the catalog row.
 */
export function deleteAndUnregisterWorkspace(
  name: string,
  centralData: CentralDataManager
): string | null {
  validateWorkspaceName(name);
  const workspaceDir = getWorkspaceDir(name);
  const entry = centralData.getWorkspaceEntry(name);
  const existsOnDisk = fs.existsSync(workspaceDir);

  if (!entry && !existsOnDisk) return null;
  if (!entry || !existsOnDisk) {
    throw new Error(
      `Workspace "${name}" is inconsistent: catalog=${entry ? "present" : "missing"}, directory=${existsOnDisk ? "present" : "missing"}`
    );
  }

  const staged = stageWorkspaceDeletion(name, entry.workspaceId, workspaceDir);
  let removedWorkspaceId: string | null;
  try {
    removedWorkspaceId = centralData.removeWorkspace(name);
    if (removedWorkspaceId !== entry.workspaceId) {
      throw new Error(`Workspace "${name}" changed while it was being deleted`);
    }
  } catch (error) {
    try {
      restoreWorkspaceDeletion(staged);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `Workspace "${name}" registry deletion failed and its directory could not be restored`
      );
    }
    throw error;
  }

  try {
    removeWorkspaceTree(staged.trashRoot);
  } catch (error) {
    log.warn(
      `[Workspace] Deleted managed workspace "${name}"; filesystem cleanup remains queued at ${staged.trashRoot}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  log.info(`[Workspace] Deleted managed workspace "${name}"`);
  return removedWorkspaceId;
}

/**
 * Recover filesystem deletion records left by a crash or a post-commit cleanup
 * failure. The central catalog is the commit record: a present matching row
 * restores a pre-commit rename, while an absent row finalizes the deletion.
 */
export function recoverStagedWorkspaceDeletions(
  centralData: CentralDataManager
): WorkspaceDeletionRecoveryReport {
  const report: WorkspaceDeletionRecoveryReport = {
    finalized: [],
    restored: [],
    failures: [],
  };
  const workspacesDir = getWorkspacesDir();
  if (!fs.existsSync(workspacesDir)) return report;

  for (const entry of fs.readdirSync(workspacesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(".delete-")) continue;
    const trashRoot = path.join(workspacesDir, entry.name);
    try {
      const marker = readWorkspaceDeletionMarker(trashRoot);
      const workspaceDir = getWorkspaceDir(marker.name);
      const trashWorkspaceDir = path.join(trashRoot, "workspace");
      const catalogEntry = centralData.getWorkspaceEntry(marker.name);

      if (!catalogEntry) {
        removeWorkspaceTree(trashRoot);
        report.finalized.push(marker.name);
        continue;
      }
      if (catalogEntry.workspaceId !== marker.workspaceId) {
        throw new Error(
          `catalog id ${catalogEntry.workspaceId} does not match deletion id ${marker.workspaceId}`
        );
      }
      if (fs.existsSync(workspaceDir)) {
        throw new Error(`catalog and live directory already exist for ${marker.name}`);
      }
      if (!fs.existsSync(trashWorkspaceDir)) {
        throw new Error(`staged workspace directory is missing for ${marker.name}`);
      }
      fs.renameSync(trashWorkspaceDir, workspaceDir);
      removeWorkspaceTree(trashRoot);
      report.restored.push(marker.name);
    } catch (error) {
      const failure = {
        trashRoot,
        message: error instanceof Error ? error.message : String(error),
      };
      report.failures.push(failure);
      log.warn(
        `[Workspace] Staged deletion recovery remains pending at ${failure.trashRoot}: ${failure.message}`
      );
    }
  }
  return report;
}

/**
 * Delete a deliberately unregistered workspace directory, currently used for
 * the hub's random on-disk ephemeral dev child. Requiring the catalog handle
 * here prevents this narrow path from becoming an escape hatch around the
 * coordinated registered-workspace deletion above.
 */
export function deleteUnregisteredWorkspace(
  name: string,
  centralData: CentralDataManager
): boolean {
  validateWorkspaceName(name);
  if (centralData.hasWorkspace(name)) {
    throw new Error(
      `Workspace "${name}" is registered and must be deleted with deleteAndUnregisterWorkspace`
    );
  }
  const workspaceDir = getWorkspaceDir(name);
  if (!fs.existsSync(workspaceDir)) return false;
  const staged = stageWorkspaceDeletion(name, `unregistered:${name}`, workspaceDir);
  removeWorkspaceTree(staged.trashRoot);
  log.info(`[Workspace] Deleted unregistered ephemeral workspace "${name}"`);
  return true;
}

function stageWorkspaceDeletion(
  name: string,
  workspaceId: string,
  workspaceDir: string
): StagedWorkspaceDeletion {
  const trashRoot = fs.mkdtempSync(path.join(getWorkspacesDir(), `.delete-${name}-`));
  const trashWorkspaceDir = path.join(trashRoot, "workspace");
  try {
    const marker: WorkspaceDeletionMarker = {
      version: WORKSPACE_DELETION_MARKER_VERSION,
      name,
      workspaceId,
    };
    fs.writeFileSync(path.join(trashRoot, WORKSPACE_DELETION_MARKER), JSON.stringify(marker), {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(workspaceDir, trashWorkspaceDir);
  } catch (error) {
    removeWorkspaceTree(trashRoot);
    throw error;
  }
  return { workspaceDir, trashRoot, trashWorkspaceDir };
}

function restoreWorkspaceDeletion(staged: StagedWorkspaceDeletion): void {
  if (fs.existsSync(staged.workspaceDir)) {
    throw new Error(
      `Cannot restore workspace because its directory was recreated: ${staged.workspaceDir}`
    );
  }
  fs.renameSync(staged.trashWorkspaceDir, staged.workspaceDir);
  removeWorkspaceTree(staged.trashRoot);
}

function removeWorkspaceTree(target: string): void {
  fs.rmSync(target, {
    recursive: true,
    force: true,
    maxRetries: WORKSPACE_DELETE_MAX_RETRIES,
    retryDelay: WORKSPACE_DELETE_RETRY_DELAY_MS,
  });
}

function readWorkspaceDeletionMarker(trashRoot: string): WorkspaceDeletionMarker {
  const value = JSON.parse(
    fs.readFileSync(path.join(trashRoot, WORKSPACE_DELETION_MARKER), "utf-8")
  ) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid workspace deletion marker");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "name,version,workspaceId") {
    throw new Error("workspace deletion marker has an unsupported shape");
  }
  if (record["version"] !== WORKSPACE_DELETION_MARKER_VERSION) {
    throw new Error("workspace deletion marker has an unsupported version");
  }
  if (typeof record["name"] !== "string") {
    throw new Error("workspace deletion marker name is required");
  }
  validateWorkspaceName(record["name"]);
  if (typeof record["workspaceId"] !== "string" || !record["workspaceId"].trim()) {
    throw new Error("workspace deletion marker workspaceId is required");
  }
  return {
    version: WORKSPACE_DELETION_MARKER_VERSION,
    name: record["name"],
    workspaceId: record["workspaceId"],
  };
}

function resolveWorkspaceCreationOpts(opts?: { templateDir?: string; forkFrom?: string }): {
  templateDir?: string;
  forkFrom?: string;
} {
  if (opts?.templateDir || opts?.forkFrom) return opts;
  const appRoot = process.env["VIBESTUDIO_APP_ROOT"] ?? process.cwd();
  const templateDir = resolveWorkspaceTemplateDir(appRoot);
  if (!templateDir) {
    throw new Error("Workspace creation requires a template, but no workspace template was found");
  }
  return { templateDir };
}

/**
 * Manages atomic reads/writes of workspace config fields.
 * Updates both the in-memory config and disk (vibestudio.yml).
 */
export function createWorkspaceConfigManager(configPath: string, config: WorkspaceConfig) {
  return {
    get: () => config,
    set(key: keyof WorkspaceConfig | string, value: unknown): void {
      // Write disk first — if I/O fails, in-memory config stays consistent
      const content = fs.readFileSync(configPath, "utf-8");
      const onDisk = (YAML.parse(content) as Record<string, unknown>) ?? {};
      onDisk[key] = value;
      fs.writeFileSync(configPath, YAML.stringify(onDisk), "utf-8");
      // Only mutate in-memory after successful disk write
      (config as unknown as Record<string, unknown>)[key] = value;
    },
  };
}
