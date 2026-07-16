import * as fs from "node:fs";
import * as path from "node:path";
import { PANEL_PRINCIPAL_PREFIX } from "@vibestudio/shared/principalIds";
import { typeCheckRpcMethods } from "./typecheckService.js";
import {
  discoverWorkspaceContext,
  type WorkspaceContext,
  type WorkspacePackageInfo,
} from "@vibestudio/typecheck";

const WORKSPACE_PACKAGE_ROOTS = [
  "about",
  "apps",
  "extensions",
  "packages",
  "panels",
  "projects",
  "skills",
  "templates",
  "workers",
] as const;

interface ExtensionContextLike {
  workspace: {
    getInfo(): Promise<{ path: string; contextProjectionsPath: string }>;
  };
  fs: {
    /** Materialize the given workspace path(s)/repo(s) into the (sparse) context
     *  folder so they can be read from disk. */
    ensureMaterialized(scope: string | string[] | "all"): Promise<void>;
  };
  invocation: {
    current(): {
      caller: { callerId: string; contextId?: string };
      chainCaller?: { contextId?: string };
    } | null;
  };
  log: {
    info(message: string): void;
  };
}

type CheckPanelOptions = {
  contextId?: string;
};

type BrowserTypeDefinitionsOptions = {
  panelPath?: string;
  packageNames?: string[];
  contextId?: string;
};

function extractPanelSourceFromCallerId(callerId: string): string | undefined {
  const treePrefix = `${PANEL_PRINCIPAL_PREFIX}tree/`;
  if (!callerId.startsWith(treePrefix)) return undefined;
  const afterTree = callerId.slice(treePrefix.length);
  const slashIdx = afterTree.indexOf("/");
  const segment = slashIdx >= 0 ? afterTree.slice(0, slashIdx) : afterTree;
  if (!segment) return undefined;
  return segment.replace(/~/g, "/");
}

function validateContextId(contextId: string): void {
  if (!contextId || contextId.length > 63) {
    throw new Error(`Invalid context ID: length must be 1-63, got ${contextId.length}`);
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(contextId)) {
    throw new Error(`Invalid context ID: ${contextId}`);
  }
}

function resolveWithin(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes context root: ${relativePath}`);
  }
  return resolved;
}

async function resolvePanelPath(
  ctx: ExtensionContextLike,
  panelPath: string,
  contextId: string | undefined
): Promise<string> {
  const info = await ctx.workspace.getInfo();
  if (!contextId)
    return path.isAbsolute(panelPath) ? panelPath : resolveWithin(info.path, panelPath);
  validateContextId(contextId);
  return resolveWithin(path.join(info.contextProjectionsPath, contextId), panelPath);
}

async function validateFilePath(
  ctx: ExtensionContextLike,
  filePath: string | undefined,
  contextId: string | undefined
): Promise<void> {
  if (!filePath) return;
  const info = await ctx.workspace.getInfo();
  if (!contextId) {
    if (!path.isAbsolute(filePath)) resolveWithin(info.path, filePath);
    return;
  }
  validateContextId(contextId);
  resolveWithin(path.join(info.contextProjectionsPath, contextId), filePath);
}

async function buildContextWorkspaceContext(
  ctx: ExtensionContextLike,
  contextId: string | undefined
): Promise<WorkspaceContext | undefined> {
  const info = await ctx.workspace.getInfo();
  if (!contextId) {
    return (
      discoverWorkspaceContext(info.path) ?? discoverWorkspaceSourceContext(info.path) ?? undefined
    );
  }
  validateContextId(contextId);

  // A context working head is the complete dependency universe for a context-bound
  // typecheck. Project it in full before discovery; consulting the live source
  // tree for missing packages would silently combine two different revisions.
  await ctx.fs.ensureMaterialized("all");
  const contextRoot = path.join(info.contextProjectionsPath, contextId);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(contextRoot);
  } catch (error) {
    throw new Error(`Materialized context root is unavailable: ${contextRoot}`, { cause: error });
  }
  if (!stat.isDirectory())
    throw new Error(`Materialized context root is not a directory: ${contextRoot}`);

  return discoverExactContextWorkspaceContext(contextRoot);
}

/**
 * Discover package metadata from one fully materialized semantic context.
 * Unlike the tolerant source-workspace discovery used outside contexts, this
 * is an authority boundary: malformed or duplicate package metadata is an
 * explicit failure, never a reason to borrow a package from live main.
 */
function discoverExactContextWorkspaceContext(contextRoot: string): WorkspaceContext {
  const packages = new Map<string, WorkspacePackageInfo>();
  for (const root of WORKSPACE_PACKAGE_ROOTS) {
    for (const pkgDir of packageDirsUnder(path.join(contextRoot, root))) {
      const packageJsonPath = path.join(pkgDir, "package.json");
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as Record<string, unknown>;
      } catch (error) {
        throw new Error(`Invalid package metadata in semantic context: ${packageJsonPath}`, {
          cause: error,
        });
      }
      const name = parsed["name"];
      if (typeof name !== "string" || name.trim().length === 0) {
        throw new Error(`Semantic context package has no valid name: ${packageJsonPath}`);
      }
      const existing = packages.get(name);
      if (existing) {
        throw new Error(
          `Semantic context contains duplicate package name ${JSON.stringify(name)}: ` +
            `${existing.dir} and ${pkgDir}`
        );
      }
      packages.set(name, { name, dir: pkgDir, packageJson: parsed });
    }
  }
  return { monorepoRoot: contextRoot, packages };
}

function discoverWorkspaceSourceContext(workspaceRoot: string): WorkspaceContext | null {
  const packages = new Map<string, WorkspacePackageInfo>();
  for (const root of WORKSPACE_PACKAGE_ROOTS) {
    const dir = path.join(workspaceRoot, root);
    for (const pkgDir of packageDirsUnder(dir)) {
      const packageJsonPath = path.join(pkgDir, "package.json");
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      const parsedName = parsed["name"];
      const name = typeof parsedName === "string" ? parsedName : "";
      if (!name || packages.has(name)) continue;
      packages.set(name, { name, dir: pkgDir, packageJson: parsed });
    }
  }
  return packages.size > 0 ? { monorepoRoot: workspaceRoot, packages } : null;
}

function packageDirsUnder(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const child = path.join(root, entry.name);
    if (fs.existsSync(path.join(child, "package.json"))) dirs.push(child);
    if (entry.name.startsWith("@")) dirs.push(...packageDirsUnder(child));
  }
  return dirs;
}

function currentCallerPanelPath(ctx: ExtensionContextLike): string | undefined {
  const callerId = ctx.invocation.current()?.caller.callerId;
  return callerId ? extractPanelSourceFromCallerId(callerId) : undefined;
}

function currentInvocationContextId(ctx: ExtensionContextLike): string | undefined {
  const invocation = ctx.invocation.current();
  return invocation?.chainCaller?.contextId ?? invocation?.caller.contextId;
}

function normalizeCheckPanelOptions(options?: CheckPanelOptions | string): CheckPanelOptions {
  if (options === undefined) return {};
  if (typeof options === "string") return { contextId: options };
  return options;
}

/** Public API surface of this extension — the awaited return of {@link activate}. */
export type Api = Awaited<ReturnType<typeof activate>>;
// Intentionally NOT registered in the WorkspaceExtensions type registry.
// typecheck-service is agent/host infrastructure invoked over the extension RPC,
// not something panels call via extensions.use(...). Registering it would drag
// its type graph — including @vibestudio/typecheck and the ~2.4MB bundled
// TypeScript lib sources — into every panel's type-check program for no benefit.

export async function activate(ctx: ExtensionContextLike) {
  ctx.log.info("typecheck-service activating");
  return {
    async checkPanel(panelPath?: string, options?: CheckPanelOptions | string) {
      const source = panelPath ?? currentCallerPanelPath(ctx);
      if (!source) {
        throw new Error(
          "Could not auto-detect panel path from caller ID. " +
            'Pass the panel source path explicitly, e.g. checkPanel("panels/my-app")'
        );
      }
      const { contextId = currentInvocationContextId(ctx) } = normalizeCheckPanelOptions(options);
      const resolvedPath = await resolvePanelPath(ctx, source, contextId);
      const result = await typeCheckRpcMethods["typecheck.check"](
        resolvedPath,
        undefined,
        undefined,
        { workspaceContext: await buildContextWorkspaceContext(ctx, contextId) }
      );
      return {
        diagnostics: result.diagnostics,
        errorCount: result.diagnostics.filter((d) => d.severity === "error").length,
        warningCount: result.diagnostics.filter((d) => d.severity === "warning").length,
      };
    },

    async check(panelPath?: string, filePath?: string, fileContent?: string, contextId?: string) {
      const source = panelPath ?? currentCallerPanelPath(ctx);
      if (!source) {
        throw new Error(
          "typecheck-service.check: panel path is required and could not be auto-detected from caller. " +
            'Pass the panel source path explicitly, e.g. check("panels/my-app")'
        );
      }
      const effectiveContextId = contextId ?? currentInvocationContextId(ctx);
      const resolvedPanelPath = await resolvePanelPath(ctx, source, effectiveContextId);
      await validateFilePath(ctx, filePath, effectiveContextId);
      return typeCheckRpcMethods["typecheck.check"](resolvedPanelPath, filePath, fileContent, {
        workspaceContext: await buildContextWorkspaceContext(ctx, effectiveContextId),
      });
    },

    async getTypeInfo(
      panelPath: string,
      filePath: string,
      line: number,
      column: number,
      fileContent?: string,
      contextId?: string
    ) {
      const effectiveContextId = contextId ?? currentInvocationContextId(ctx);
      const resolvedPanelPath = await resolvePanelPath(ctx, panelPath, effectiveContextId);
      await validateFilePath(ctx, filePath, effectiveContextId);
      return typeCheckRpcMethods["typecheck.getTypeInfo"](
        resolvedPanelPath,
        filePath,
        line,
        column,
        fileContent,
        { workspaceContext: await buildContextWorkspaceContext(ctx, effectiveContextId) }
      );
    },

    async getCompletions(
      panelPath: string,
      filePath: string,
      line: number,
      column: number,
      fileContent?: string,
      contextId?: string
    ) {
      const effectiveContextId = contextId ?? currentInvocationContextId(ctx);
      const resolvedPanelPath = await resolvePanelPath(ctx, panelPath, effectiveContextId);
      await validateFilePath(ctx, filePath, effectiveContextId);
      return typeCheckRpcMethods["typecheck.getCompletions"](
        resolvedPanelPath,
        filePath,
        line,
        column,
        fileContent,
        { workspaceContext: await buildContextWorkspaceContext(ctx, effectiveContextId) }
      );
    },

    async getBrowserTypeDefinitions(options?: BrowserTypeDefinitionsOptions) {
      const opts = options ?? {};
      const packageNames = opts.packageNames ?? [];
      const effectiveContextId = opts.contextId ?? currentInvocationContextId(ctx);
      const source =
        opts.panelPath ?? (packageNames.length > 0 ? currentCallerPanelPath(ctx) : undefined);

      if (!source) {
        return typeCheckRpcMethods["typecheck.getBrowserTypeDefinitions"](undefined, packageNames);
      }

      const resolvedPanelPath = await resolvePanelPath(ctx, source, effectiveContextId);
      return typeCheckRpcMethods["typecheck.getBrowserTypeDefinitions"](
        resolvedPanelPath,
        packageNames,
        { workspaceContext: await buildContextWorkspaceContext(ctx, effectiveContextId) }
      );
    },
  };
}
