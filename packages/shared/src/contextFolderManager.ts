/**
 * ContextFolderManager — Manages per-context directories on disk.
 *
 * Each semantic context may have a disposable folder at
 * `{currentEpochRoot}/{contextId}/`. State topology supplies the exact current
 * epoch root; this manager never discovers or migrates older namespaces. The
 * semantic workspace state machine owns the exact working head; the host
 * materializes its content-addressed repository states when disk access is
 * needed. Panel/agent fs calls are routed to these folders via RPC, while
 * tracked mutations still flow through the semantic workspace.
 *
 * The actual fork/materialize lives server-side (vcsHost); this class owns the
 * id validation, in-flight dedupe, and readiness state, and is the surface
 * fsService/contextMiddleware depend on.
 */

import * as fs from "fs/promises";
import { accessSync } from "fs";
import * as path from "path";
import { createDevLogger } from "@vibestudio/dev-log";

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
  private readonly contextProjectionsRoot: string;
  private readonly contextScratchRoot: string;
  private readonly scratch: {
    ensure(contextId: string): Promise<void>;
    remove(contextId: string): Promise<void>;
  };
  private readonly materialize: (contextId: string) => Promise<{ dir: string }>;

  /** Concurrency guard: in-flight ensureContextFolder promises. */
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(opts: {
    /** Exact current-epoch root of disposable context projections. */
    contextProjectionsRoot: string;
    /** Writable context worktrees; disjoint from managed source projections. */
    contextScratchRoot: string;
    /** Execute writable-tree operations inside the workspace sandbox. */
    scratch: { ensure(contextId: string): Promise<void>; remove(contextId: string): Promise<void> };
    /**
     * Ensure the semantic context and its projection directory exist
     * (WorkspaceVcs.ensureContextFolder server-side). Must be idempotent.
     */
    materialize: (contextId: string) => Promise<{ dir: string }>;
  }) {
    this.contextProjectionsRoot = opts.contextProjectionsRoot;
    this.contextScratchRoot = opts.contextScratchRoot;
    this.scratch = opts.scratch;
    const relative = path.relative(
      path.resolve(opts.contextProjectionsRoot),
      path.resolve(opts.contextScratchRoot)
    );
    const reverse = path.relative(
      path.resolve(opts.contextScratchRoot),
      path.resolve(opts.contextProjectionsRoot)
    );
    if (
      ![relative, reverse].every(
        (value) => value.startsWith(".." + path.sep) || value === ".." || path.isAbsolute(value)
      )
    )
      throw new Error("Source projections and writable scratch must be disjoint");
    this.materialize = opts.materialize;
  }

  async ensureContextScratch(contextId: string): Promise<string> {
    validateContextId(contextId);
    const scratch = path.join(this.contextScratchRoot, contextId);
    try {
      await this.scratch.ensure(contextId);
    } catch {
      // The installed lifecycle consumes only success/failure. Never relay
      // arbitrary native diagnostics through a semantic filesystem operation.
      throw new Error("Confined context scratch creation failed");
    }
    return scratch;
  }

  /**
   * Return the context projection directory, creating it if needed.
   */
  async ensureContextFolder(contextId: string): Promise<string> {
    validateContextId(contextId);

    const existing = this.inflight.get(contextId);
    if (existing) return existing;

    const contextPath = path.join(this.contextProjectionsRoot, contextId);

    const promise = (async () => {
      try {
        try {
          await fs.access(contextPath);
          return contextPath; // already materialized
        } catch {
          // Missing — ask the semantic context host to establish it below.
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
    const contextPath = path.join(this.contextProjectionsRoot, contextId);
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
    const contextPath = path.join(this.contextProjectionsRoot, contextId);
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
    const contextPath = path.join(this.contextProjectionsRoot, contextId);
    await Promise.all([
      fs.rm(contextPath, { recursive: true, force: true }),
      this.scratch.remove(contextId).catch(() => {
        throw new Error("Confined context scratch removal failed");
      }),
    ]);
  }
}
