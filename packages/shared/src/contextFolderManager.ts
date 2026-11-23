/** Manage confined context scratch and the host's context paths. */
import * as fs from "fs/promises";
import { accessSync } from "fs";
import * as path from "path";

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
  private readonly contextProjectionsRoot: string;
  private readonly contextScratchRoot: string;
  private readonly scratch: {
    ensure(contextId: string): Promise<void>;
    remove(contextId: string): Promise<void>;
  };
  constructor(opts: {
    /** Exact current-epoch root of disposable context projections. */
    contextProjectionsRoot: string;
    /** Writable context worktrees; disjoint from managed source projections. */
    contextScratchRoot: string;
    /** Execute writable-tree operations inside the workspace sandbox. */
    scratch: { ensure(contextId: string): Promise<void>; remove(contextId: string): Promise<void> };
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
  }

  /** Validated source address. Resolving scope does not materialize source bytes. */
  contextSourcePath(contextId: string): string {
    validateContextId(contextId);
    return path.join(this.contextProjectionsRoot, contextId);
  }

  /** Validated scratch address; native operations establish the directory. */
  contextScratchPath(contextId: string): string {
    validateContextId(contextId);
    return path.join(this.contextScratchRoot, contextId);
  }

  async ensureContextScratch(contextId: string): Promise<string> {
    validateContextId(contextId);
    const scratch = this.contextScratchPath(contextId);
    try {
      await this.scratch.ensure(contextId);
    } catch (cause) {
      // The installed lifecycle consumes only success/failure. Never relay
      // arbitrary native diagnostics through a semantic filesystem operation.
      console.error("[ContextFolderManager] Confined context scratch creation failed:", cause);
      throw new Error("Confined context scratch creation failed", { cause });
    }
    return scratch;
  }

  /**
   * Returns the absolute path if the context folder exists, null otherwise.
   */
  getContextRoot(contextId: string): string | null {
    validateContextId(contextId);
    const contextPath = this.contextSourcePath(contextId);
    try {
      accessSync(contextPath);
      return contextPath;
    } catch {
      return null;
    }
  }

  /**
   * Deletes a context folder. NOT called automatically — context folders
   * persist as long as any non-archived panel references them.
   */
  async removeContext(contextId: string): Promise<void> {
    validateContextId(contextId);
    const contextPath = this.contextSourcePath(contextId);
    await Promise.all([
      fs.rm(contextPath, { recursive: true, force: true }),
      this.scratch.remove(contextId).catch(() => {
        throw new Error("Confined context scratch removal failed");
      }),
    ]);
  }
}
