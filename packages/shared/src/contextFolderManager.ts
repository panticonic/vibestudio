/**
 * ContextFolderManager — Manages per-context directories on disk.
 *
 * Each context gets a folder at `{contextsRoot}/{contextId}/` materialized as
 * a GAD branch fork: the workspace `vcs:workspace` main head is forked to
 * `ctx:{contextId}` and the fork state is written out from the blobstore CAS.
 * Panel/agent fs calls are routed to these folders via RPC, making files
 * visible on disk and accessible to server-side tools and agents. Commits
 * from inside a context land on the context head (see WorkspaceVcs).
 *
 * The actual fork/materialize lives server-side (gadVcs); this class owns the
 * id validation, in-flight dedupe, and readiness state, and is the surface
 * fsService/contextMiddleware depend on.
 */

import * as fs from "fs/promises";
import { accessSync } from "fs";
import * as path from "path";
import { createDevLogger } from "@vibez1/dev-log";

const log = createDevLogger("ContextFolderManager");

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

export class ContextFolderManager {
  private readonly materializing = new Set<string>();
  private readonly contextsRoot: string;
  private readonly materialize: (contextId: string) => Promise<{ dir: string }>;

  /** Concurrency guard: in-flight ensureContextFolder promises. */
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(opts: {
    /** Path to the contexts root directory (where context worktrees live). */
    contextsRoot: string;
    /**
     * Fork + materialize a context worktree (WorkspaceVcs.ensureContextFolder
     * server-side). Must be idempotent.
     */
    materialize: (contextId: string) => Promise<{ dir: string }>;
  }) {
    this.contextsRoot = opts.contextsRoot;
    this.materialize = opts.materialize;
  }

  /**
   * Returns absolute path to the context folder, creating it if needed
   * (fork of the workspace main head, materialized from the CAS).
   */
  async ensureContextFolder(contextId: string): Promise<string> {
    validateContextId(contextId);

    const existing = this.inflight.get(contextId);
    if (existing) return existing;

    const contextPath = path.join(this.contextsRoot, contextId);

    const promise = (async () => {
      try {
        try {
          await fs.access(contextPath);
          return contextPath; // already materialized
        } catch {
          // missing — fork + materialize below
        }
        this.materializing.add(contextId);
        try {
          log.info(`Creating context folder: ${contextId}`);
          const { dir } = await this.materialize(contextId);
          log.info(`Context folder ready: ${contextId}`);
          return dir;
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
      accessSync(contextPath);
      return contextPath;
    } catch {
      return null;
    }
  }

  /**
   * Returns context folder readiness without starting materialization.
   */
  getContextFolderState(contextId: string): ContextFolderState {
    validateContextId(contextId);
    const contextPath = path.join(this.contextsRoot, contextId);
    if (this.materializing.has(contextId)) {
      return { status: "materializing", path: contextPath };
    }
    try {
      accessSync(contextPath);
      return { status: "ready", path: contextPath };
    } catch {
      return { status: "missing", path: contextPath };
    }
  }

  /**
   * Deletes a context folder. NOT called automatically — context folders
   * persist as long as any non-archived panel references them.
   */
  async removeContext(contextId: string): Promise<void> {
    validateContextId(contextId);
    const contextPath = path.join(this.contextsRoot, contextId);
    await fs.rm(contextPath, { recursive: true, force: true });
  }

}
