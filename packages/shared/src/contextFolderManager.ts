/**
 * ContextFolderManager — Manages per-context directories on disk.
 *
 * Each context gets a folder at `{contextsRoot}/{contextId}/` that starts as
 * a copy of all workspace git repos from the source tree. Working tree files
 * and mutable git state are copied per-context while immutable git objects are
 * shared with the source repo via a validated .git/objects symlink. Panel fs calls are routed
 * to these folders via RPC, making files visible on disk and accessible to
 * server-side tools and agents.
 */

import * as fs from "fs/promises";
import { constants as fsConstants } from "fs";
import * as path from "path";
import { createDevLogger } from "@natstack/dev-log";

import type { WorkspaceNode } from "./types.js";
import type { WorkspaceConfig } from "./workspace/types.js";
import { syncDeclaredRemoteForRepo } from "./workspace/remotes.js";

const log = createDevLogger("ContextFolderManager");

/** Directories to skip when copying working tree files. */
const SKIP_DIRS = new Set([".git", "node_modules", ".cache", ".databases"]);

export type ContextFolderState =
  | { status: "missing"; path: string }
  | { status: "materializing"; path: string }
  | { status: "ready"; path: string };

/**
 * Validate that a context ID is safe for per-context folder names.
 */
function validateContextId(contextId: string): void {
  if (!contextId || contextId.length > 63) {
    throw new Error(`Invalid context ID: length must be 1-63, got ${contextId.length}`);
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(contextId)) {
    throw new Error(
      `Invalid context ID: must be lowercase alphanumeric with hyphens, not starting/ending with hyphen. Got "${contextId}"`
    );
  }
}

/** fs.cp filter callback that skips SKIP_DIRS entries. */
function copyFilter(src: string): boolean {
  const base = path.basename(src);
  return !SKIP_DIRS.has(base);
}

/**
 * Create a context-local .git directory by copying mutable git state and
 * symlinking the immutable object database to the canonical source repo.
 *
 * Context refs, HEAD, index, config, and hooks remain context-local. Only
 * `.git/objects` is shared; the fs sandbox separately verifies this symlink
 * before allowing it to escape the context root.
 */
async function createSharedObjectsSymlink(
  destGit: string,
  sharedObjectsTarget: string
): Promise<void> {
  const objectsPath = path.join(destGit, "objects");
  await fs.rm(objectsPath, { recursive: true, force: true });
  const relativeTarget = path.relative(destGit, sharedObjectsTarget) || sharedObjectsTarget;
  await fs.symlink(relativeTarget, objectsPath, "dir");
}

async function setupContextGit(
  srcGit: string,
  destGit: string,
  sharedObjectsTarget: string
): Promise<void> {
  await fs.mkdir(destGit, { recursive: true });

  const entries = await fs.readdir(srcGit, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcGit, entry.name);
    const destPath = path.join(destGit, entry.name);

    if (entry.name === "objects" || entry.name.endsWith(".lock")) continue;

    if (entry.isDirectory()) {
      await fs.cp(srcPath, destPath, {
        recursive: true,
        filter: (childSrc) => !path.basename(childSrc).endsWith(".lock"),
      });
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }

  await createSharedObjectsSymlink(destGit, sharedObjectsTarget);

  // Integrity check: verify the objects/ store is readable and that HEAD
  // points to a reachable object.
  try {
    const objectsPath = path.join(destGit, "objects");
    const resolved = await fs.realpath(objectsPath);
    await fs.access(resolved);

    // Verify HEAD's target object exists in the store
    const headContent = (await fs.readFile(path.join(destGit, "HEAD"), "utf-8")).trim();
    if (headContent.startsWith("ref: ")) {
      // Symbolic ref — resolve through refs/
      const refPath = path.join(destGit, headContent.slice(5));
      try {
        const sha = (await fs.readFile(refPath, "utf-8")).trim();
        await verifyObjectExists(objectsPath, sha);
      } catch {
        // Ref doesn't exist yet (empty repo) — not necessarily an error
      }
    } else {
      // Detached HEAD — verify the commit object directly
      await verifyObjectExists(objectsPath, headContent);
    }
  } catch (err) {
    log.warn(`Git integrity check failed for ${destGit}: ${err}`);
  }
}

async function copyLooseObjectsNoOverwrite(
  srcObjects: string,
  destObjects: string
): Promise<number> {
  let copied = 0;
  let fanoutEntries: import("fs").Dirent[];
  try {
    fanoutEntries = await fs.readdir(srcObjects, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const fanout of fanoutEntries) {
    if (!fanout.isDirectory() || !/^[0-9a-f]{2}$/.test(fanout.name)) continue;
    const srcFanout = path.join(srcObjects, fanout.name);
    const destFanout = path.join(destObjects, fanout.name);
    await fs.mkdir(destFanout, { recursive: true });
    let objectEntries: import("fs").Dirent[];
    try {
      objectEntries = await fs.readdir(srcFanout, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const objectEntry of objectEntries) {
      if (!objectEntry.isFile() || !/^[0-9a-f]{38}$/.test(objectEntry.name)) continue;
      const srcObject = path.join(srcFanout, objectEntry.name);
      const destObject = path.join(destFanout, objectEntry.name);
      try {
        await fs.copyFile(srcObject, destObject, fsConstants.COPYFILE_EXCL);
        copied++;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
  }
  return copied;
}

async function nextBackupPath(basePath: string): Promise<string> {
  const stamp = Date.now();
  for (let i = 0; i < 1000; i++) {
    const candidate = `${basePath}.backup-${stamp}${i === 0 ? "" : `-${i}`}`;
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error(`Could not choose backup path for ${basePath}`);
}

/**
 * Verify a git object (by SHA) exists in the object store.
 * Checks both loose objects (objects/ab/cdef...) and the existence of
 * pack files (objects/pack/*.pack) as a heuristic for packed objects.
 */
async function verifyObjectExists(objectsPath: string, sha: string): Promise<void> {
  if (!sha || sha.length < 4) return;
  const loosePath = path.join(objectsPath, sha.slice(0, 2), sha.slice(2));
  try {
    await fs.access(loosePath);
    return; // Loose object exists
  } catch {
    // Not a loose object — check if pack files exist (packed objects can't
    // be verified without parsing the index, but their presence is a good sign)
    const packDir = path.join(objectsPath, "pack");
    try {
      const packEntries = await fs.readdir(packDir);
      if (packEntries.some((e) => e.endsWith(".pack"))) return; // Packs exist, object is likely packed
    } catch {
      // No pack directory
    }
    throw new Error(`Object ${sha} not found in object store (no loose object, no pack files)`);
  }
}

export class ContextFolderManager {
  private readonly materializing = new Set<string>();

  private readonly contextsRoot: string;
  private readonly sourcePath: string;
  private readonly getWorkspaceTree: () => Promise<{ children: WorkspaceNode[] }>;
  private readonly getWorkspaceConfig?: () => WorkspaceConfig;

  /** Concurrency guard: in-flight ensureContextFolder promises. */
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(opts: {
    /** Path to the source tree (git repos to copy from) */
    sourcePath: string;
    /** Path to the contexts root directory (where context copies are stored) */
    contextsRoot: string;
    getWorkspaceTree: () => Promise<{ children: WorkspaceNode[] }>;
    getWorkspaceConfig?: () => WorkspaceConfig;
  }) {
    this.sourcePath = opts.sourcePath;
    this.contextsRoot = opts.contextsRoot;
    this.getWorkspaceTree = opts.getWorkspaceTree;
    this.getWorkspaceConfig = opts.getWorkspaceConfig;
  }

  /**
   * Returns absolute path to the context folder, creating it if needed.
   * Copies working tree files and sets up .git with shared object store
   * (symlinked) and per-context mutable state (copied).
   */
  async ensureContextFolder(contextId: string): Promise<string> {
    validateContextId(contextId);

    // If another call for the same contextId is in flight, return the existing promise
    const existing = this.inflight.get(contextId);
    if (existing) return existing;

    const contextPath = path.join(this.contextsRoot, contextId);

    const promise = (async () => {
      try {
        // Check if already exists
        let contextExists = false;
        try {
          await fs.access(contextPath);
          contextExists = true;
        } catch {
          // Does not exist, create it
        }
        if (contextExists) {
          await this.repairSharedGitObjectsForContextPath(contextPath);
          await this.syncDeclaredRemotesForContextPath(contextPath);
          return contextPath; // Already exists
        }

        this.materializing.add(contextId);
        try {
          log.info(`Creating context folder: ${contextId}`);
          await fs.mkdir(contextPath, { recursive: true });

          // Discover all git repos in the workspace
          const tree = await this.getWorkspaceTree();
          const repos = this.collectRepos(tree.children);

          // Copy each repo: working tree files + context-local git state
          for (const repoPath of repos) {
            try {
              await this.copyRepoIntoContext(contextPath, repoPath);
            } catch (err) {
              console.warn(`[ContextFolder] Failed to setup context git for ${repoPath}:`, err);
            }
          }

          log.info(`Context folder ready: ${contextId} (${repos.length} repo(s) copied)`);
          return contextPath;
        } finally {
          this.materializing.delete(contextId);
        }
      } finally {
        this.inflight.delete(contextId);
      }
    })();

    this.inflight.set(contextId, promise);
    return promise;
  }

  /**
   * Returns the absolute path if the context folder exists, null otherwise.
   */
  getContextRoot(contextId: string): string | null {
    validateContextId(contextId);
    const contextPath = path.join(this.contextsRoot, contextId);
    try {
      // Synchronous check — fast path for already-created folders
      require("fs").accessSync(contextPath);
      return contextPath;
    } catch {
      return null;
    }
  }

  /**
   * Returns context folder readiness without starting materialization.
   *
   * `ensureContextFolder()` creates the directory before copying repo contents,
   * so a plain existence check can report a partially materialized context as
   * usable. Callers that need fail-fast readiness semantics should use this
   * method instead of probing the filesystem directly.
   */
  getContextFolderState(contextId: string): ContextFolderState {
    validateContextId(contextId);
    const contextPath = path.join(this.contextsRoot, contextId);
    if (this.materializing.has(contextId)) {
      return { status: "materializing", path: contextPath };
    }
    try {
      require("fs").accessSync(contextPath);
      return { status: "ready", path: contextPath };
    } catch {
      return { status: "missing", path: contextPath };
    }
  }

  /**
   * Deletes a context folder. NOT called automatically — context folders
   * persist as long as any non-archived panel references them.
   * For future explicit admin/GC use only.
   */
  async removeContext(contextId: string): Promise<void> {
    validateContextId(contextId);
    const contextPath = path.join(this.contextsRoot, contextId);
    await fs.rm(contextPath, { recursive: true, force: true });
    log.info(`Removed context folder: ${contextId}`);
  }

  /**
   * Sync workspace-declared remotes into existing context folders.
   * If repoPath is provided, only that repo is synced.
   */
  async syncDeclaredRemotes(repoPath?: string): Promise<void> {
    let contextEntries: import("fs").Dirent[];
    try {
      contextEntries = await fs.readdir(this.contextsRoot, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      contextEntries
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const contextPath = path.join(this.contextsRoot, entry.name);
          return repoPath
            ? this.syncDeclaredRemoteForRepo(contextPath, repoPath)
            : this.syncDeclaredRemotesForContextPath(contextPath);
        })
    );
  }

  /**
   * Copy a repo that appeared after contexts were created into every existing
   * context. Existing context repos are left in place and only have declared
   * remotes synced.
   */
  async ensureRepoPresentInContexts(repoPath: string): Promise<void> {
    let contextEntries: import("fs").Dirent[];
    try {
      contextEntries = await fs.readdir(this.contextsRoot, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      contextEntries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const contextPath = path.join(this.contextsRoot, entry.name);
          try {
            await this.copyRepoIntoContext(contextPath, repoPath, { skipIfExists: true });
          } catch (err) {
            log.warn(`Failed to copy repo ${repoPath} into context ${entry.name}: ${err}`);
          }
        })
    );
  }

  /**
   * Repair existing context repos so their `.git/objects` entry is the approved
   * symlink to the canonical source repo object database. If a context still
   * has a copied object directory, loose objects missing from the source object
   * store are copied into the canonical store with no-overwrite semantics before
   * the copied directory is moved aside.
   */
  async repairSharedGitObjects(repoPath?: string): Promise<void> {
    let contextEntries: import("fs").Dirent[];
    try {
      contextEntries = await fs.readdir(this.contextsRoot, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      contextEntries
        .filter((entry) => entry.isDirectory())
        .map((entry) =>
          this.repairSharedGitObjectsForContextPath(
            path.join(this.contextsRoot, entry.name),
            repoPath
          )
        )
    );
  }

  async repairContextRepoGit(contextId: string, repoPath: string): Promise<void> {
    validateContextId(contextId);
    await this.repairContextRepoGitAtPath(path.join(this.contextsRoot, contextId), repoPath);
  }

  /**
   * Recursively collect repo paths (relative, forward slashes) from workspace tree.
   */
  private collectRepos(nodes: WorkspaceNode[]): string[] {
    const repos: string[] = [];
    for (const node of nodes) {
      if (node.isGitRepo) {
        repos.push(node.path);
      }
      if (node.children.length > 0) {
        repos.push(...this.collectRepos(node.children));
      }
    }
    return repos;
  }

  private async syncDeclaredRemotesForContextPath(contextPath: string): Promise<void> {
    if (!this.getWorkspaceConfig) return;
    const tree = await this.getWorkspaceTree();
    const repos = this.collectRepos(tree.children);
    await Promise.all(
      repos.map((repoPath) => this.syncDeclaredRemoteForRepo(contextPath, repoPath))
    );
  }

  private async syncDeclaredRemoteForRepo(contextPath: string, repoPath: string): Promise<void> {
    if (!this.getWorkspaceConfig) return;
    try {
      await syncDeclaredRemoteForRepo({
        config: this.getWorkspaceConfig(),
        workspaceRoot: contextPath,
        repoPath,
      });
    } catch (err) {
      log.warn(`Failed to sync declared remote for ${repoPath} in ${contextPath}: ${err}`);
    }
  }

  private async copyRepoIntoContext(
    contextPath: string,
    repoPath: string,
    opts: { skipIfExists?: boolean } = {}
  ): Promise<void> {
    const src = path.join(this.sourcePath, repoPath);
    const dest = path.join(contextPath, repoPath);
    if (opts.skipIfExists) {
      try {
        await fs.access(dest);
        await this.repairContextRepoGitAtPath(contextPath, repoPath);
        await this.syncDeclaredRemoteForRepo(contextPath, repoPath);
        return;
      } catch {
        // Missing destination; copy it below.
      }
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.cp(src, dest, { recursive: true, filter: copyFilter });
    const srcGit = path.join(src, ".git");
    try {
      await fs.access(srcGit);
    } catch {
      return;
    }
    await setupContextGit(srcGit, path.join(dest, ".git"), path.join(srcGit, "objects"));
    await this.syncDeclaredRemoteForRepo(contextPath, repoPath);
  }

  private async repairSharedGitObjectsForContextPath(
    contextPath: string,
    repoPath?: string
  ): Promise<void> {
    const repos = repoPath
      ? [repoPath]
      : this.collectRepos((await this.getWorkspaceTree()).children);
    await Promise.all(repos.map((repo) => this.repairContextRepoGitAtPath(contextPath, repo)));
  }

  private async repairContextRepoGitAtPath(contextPath: string, repoPath: string): Promise<void> {
    const srcGit = path.join(this.sourcePath, repoPath, ".git");
    const destGit = path.join(contextPath, repoPath, ".git");
    const sourceObjects = path.join(srcGit, "objects");
    const destObjects = path.join(destGit, "objects");

    try {
      const sourceStat = await fs.stat(sourceObjects);
      if (!sourceStat.isDirectory()) return;
      await fs.access(destGit);
    } catch {
      return;
    }

    let objectStat: import("fs").Stats | null = null;
    try {
      objectStat = await fs.lstat(destObjects);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    if (objectStat?.isSymbolicLink()) {
      const target = await fs.realpath(destObjects).catch(() => null);
      if (
        target &&
        (await this.isAllowedSharedGitObjectsSymlink({
          contextRoot: contextPath,
          symlinkPath: destObjects,
          realTarget: target,
        }))
      ) {
        return;
      }
      await fs.rm(destObjects, { recursive: true, force: true });
    } else if (objectStat?.isDirectory()) {
      const copied = await copyLooseObjectsNoOverwrite(destObjects, sourceObjects);
      if (copied > 0) {
        log.info(
          `Migrated ${copied} loose git object(s) from ${path.relative(this.contextsRoot, destObjects)} into source store`
        );
      }
      const backupPath = await nextBackupPath(destObjects);
      await fs.rename(destObjects, backupPath);
    } else if (objectStat) {
      await fs.rm(destObjects, { recursive: true, force: true });
    }

    await createSharedObjectsSymlink(destGit, sourceObjects);
    const repaired = await fs.stat(destObjects);
    if (!repaired.isDirectory()) {
      throw new Error(`Repaired git objects path is not a directory: ${destObjects}`);
    }
  }

  /**
   * Authoritative check used by FsService before permitting a symlink to escape
   * a context root. The only approved escape is the server-created
   * `<context>/<repo>/.git/objects` symlink pointing at the corresponding
   * canonical source repo's object database.
   */
  async isAllowedSharedGitObjectsSymlink(args: {
    contextRoot: string;
    symlinkPath: string;
    realTarget: string;
  }): Promise<boolean> {
    const contextRootReal = await fs.realpath(args.contextRoot).catch(() => null);
    if (!contextRootReal) return false;

    const symlinkAbs = path.resolve(args.symlinkPath);
    const rel = path.relative(contextRootReal, symlinkAbs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;

    const suffix = `${path.sep}.git${path.sep}objects`;
    if (!symlinkAbs.endsWith(suffix)) return false;
    const repoRel = path.dirname(path.dirname(symlinkAbs));
    const repoPath = path.relative(contextRootReal, repoRel).split(path.sep).join("/");
    if (!repoPath || repoPath.startsWith("..") || path.isAbsolute(repoPath)) return false;

    const repos = new Set(this.collectRepos((await this.getWorkspaceTree()).children));
    if (!repos.has(repoPath)) return false;

    const expectedPath = path.join(this.sourcePath, repoPath, ".git", "objects");
    const expectedStat = await fs.stat(expectedPath).catch(() => null);
    if (!expectedStat?.isDirectory()) return false;
    const expected = await fs.realpath(expectedPath).catch(() => null);
    if (!expected) return false;
    const actual = await fs.realpath(args.realTarget).catch(() => null);
    if (actual !== expected) return false;
    const actualStat = await fs.stat(actual).catch(() => null);
    return actualStat?.isDirectory() === true;
  }
}
