/**
 * Type-check helper methods used by the typecheck service extension.
 *
 * Runs TypeScript's language service (via @vibestudio/typecheck) directly
 * against the disk. No external type fetching, no install-on-demand, no
 * callbacks — workspace packages resolve through the workspace context map
 * and everything else flows through standard `node_modules` walking.
 *
 * Internal method keys:
 *   - typecheck.check          — diagnostics for a file or whole project
 *   - typecheck.getTypeInfo    — hover info at a position
 *   - typecheck.getCompletions — completion list at a position
 *   - typecheck.getBrowserTypeDefinitions
 *       — bundled Monaco/TypeScript declaration files, plus optional package
 *         .d.ts payloads loaded from node_modules for browser editors.
 */

import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  TypeCheckService,
  createTypeDefinitionLoader,
  createDiskFileSource,
  getBrowserTypeDefinitions,
  getDefaultNodeModulesPaths,
  loadSourceFiles,
  type BrowserTypeDefinitions,
  type LoadedTypeDefinitions,
  type TypeCheckDiagnostic,
  discoverWorkspaceContext,
  type WorkspaceContext,
} from "@vibestudio/typecheck";
import { getUserDataPath } from "@vibestudio/env-paths";
import { runNpmInstall } from "@vibestudio/shared/npmInstaller";

/** Per-panel TypeCheckService cache — keyed by absolute panel path. */
const typeCheckServiceCache = new Map<string, TypeCheckService>();
const nodeModulesPathCache = new Map<string, string[]>();

export interface TypeCheckRpcOptions {
  workspaceContext?: WorkspaceContext | null;
}

export interface BrowserPackageTypeDefinitionFile {
  packageName: string;
  relativePath: string;
  filePath: string;
  content: string;
}

export interface SerializedPackageTypeDefinitions {
  packageName: string;
  files: Record<string, string>;
  entryPoint: string | null;
  errors: string[];
  referencedPackages: string[];
  subpaths: Record<string, string>;
  typeDefinitionFiles: BrowserPackageTypeDefinitionFile[];
}

export interface BrowserTypeDefinitionsResponse extends BrowserTypeDefinitions {
  packageTypes: SerializedPackageTypeDefinitions[];
  packageTypeDefinitionFiles: BrowserPackageTypeDefinitionFile[];
}

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function readPackageJson(packageDir: string): PackageJson | null {
  try {
    return JSON.parse(
      fsSync.readFileSync(path.join(packageDir, "package.json"), "utf-8")
    ) as PackageJson;
  } catch {
    return null;
  }
}

function hashDeps(deps: Record<string, string>): string {
  const entries = Object.entries(deps).sort(([a], [b]) => a.localeCompare(b));
  const hash = crypto.createHash("sha256");
  hash.update(JSON.stringify(entries));
  return hash.digest("hex").slice(0, 16);
}

function compareVersions(a: string, b: string): number {
  if (a === "*" || a === "workspace:*") return -1;
  if (b === "*" || b === "workspace:*") return 1;

  const parseVersion = (v: string): number[] => {
    const cleaned = v.replace(/^[\^~>=<]+/, "");
    return cleaned.split(".").map((n) => parseInt(n, 10) || 0);
  };

  const aParts = parseVersion(a);
  const bParts = parseVersion(b);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function ensureExternalDeps(deps: Record<string, string>): Promise<string> {
  if (Object.keys(deps).length === 0) return "";

  const key = hashDeps(deps);
  const cacheDir = path.join(getUserDataPath(), "external-deps", key);
  const sentinelPath = path.join(cacheDir, ".ready");
  const nodeModulesDir = path.join(cacheDir, "node_modules");

  if (fsSync.existsSync(sentinelPath)) return nodeModulesDir;

  const tmpDir = `${cacheDir}.tmp.${Date.now()}.${process.pid}`;
  fsSync.mkdirSync(tmpDir, { recursive: true });
  fsSync.writeFileSync(
    path.join(tmpDir, "package.json"),
    JSON.stringify(
      {
        name: "external-deps-install",
        version: "0.0.0",
        private: true,
        dependencies: deps,
      },
      null,
      2
    )
  );

  try {
    await runNpmInstall(tmpDir);
    fsSync.writeFileSync(path.join(tmpDir, ".ready"), new Date().toISOString());
    try {
      fsSync.renameSync(tmpDir, cacheDir);
    } catch (err: any) {
      if (err.code === "ENOTEMPTY" || err.code === "EEXIST" || err.code === "ENOTDIR") {
        if (fsSync.existsSync(sentinelPath)) {
          try {
            fsSync.rmSync(tmpDir, { recursive: true, force: true });
          } catch {}
          return nodeModulesDir;
        }
        fsSync.rmSync(cacheDir, { recursive: true, force: true });
        fsSync.renameSync(tmpDir, cacheDir);
      } else {
        throw err;
      }
    }
    return nodeModulesDir;
  } catch (error) {
    try {
      fsSync.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
    throw new Error(
      `Failed to install external dependencies for typecheck: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function typecheckCacheKey(panelPath: string, options?: TypeCheckRpcOptions): string {
  const resolved = path.resolve(panelPath);
  const workspaceKey =
    options && "workspaceContext" in options
      ? (options.workspaceContext?.monorepoRoot ?? "none")
      : "auto";
  return `${resolved}\0${workspaceKey}`;
}

async function resolveTypecheckNodeModulesPaths(
  panelPath: string,
  options?: TypeCheckRpcOptions
): Promise<string[]> {
  const resolved = path.resolve(panelPath);
  const key = typecheckCacheKey(resolved, options);
  const cached = nodeModulesPathCache.get(key);
  if (cached) return cached;

  const workspaceContext =
    options && "workspaceContext" in options
      ? options.workspaceContext
      : discoverWorkspaceContext(resolved);
  const externals: Record<string, string> = {};
  const visited = new Set<string>();

  const walk = (dir: string) => {
    const realDir = path.resolve(dir);
    if (visited.has(realDir)) return;
    visited.add(realDir);

    const pkg = readPackageJson(realDir);
    if (!pkg) return;

    const allDeps = { ...pkg.peerDependencies, ...pkg.dependencies };
    for (const [name, version] of Object.entries(allDeps)) {
      const workspaceDepDir = workspaceContext?.packages.get(name)?.dir;
      if (workspaceDepDir) {
        walk(workspaceDepDir);
        continue;
      }
      if (version.startsWith("workspace:")) continue;
      if (!externals[name] || compareVersions(version, externals[name]!) > 0) {
        externals[name] = version;
      }
    }
  };

  walk(resolved);

  const paths: string[] = [];
  const externalNodeModules = await ensureExternalDeps(externals);
  if (externalNodeModules) paths.push(externalNodeModules);

  nodeModulesPathCache.set(key, paths);
  return paths;
}

/**
 * Build (or reuse) a `TypeCheckService` for the given panel/package path.
 * The service auto-discovers the monorepo context and reads files from disk.
 */
async function getOrCreateTypeCheckService(
  panelPath: string,
  options?: TypeCheckRpcOptions
): Promise<TypeCheckService> {
  const resolved = path.resolve(panelPath);
  const key = typecheckCacheKey(resolved, options);
  const cached = typeCheckServiceCache.get(key);
  if (cached) return cached;

  const nodeModulesPaths = await resolveTypecheckNodeModulesPaths(resolved, options);
  const service = new TypeCheckService({
    panelPath: resolved,
    nodeModulesPaths,
    ...(options && "workspaceContext" in options
      ? { workspaceContext: options.workspaceContext }
      : {}),
  });

  // Load initial files with absolute paths (consistent with all downstream
  // updateFile calls).
  const fileSource = createDiskFileSource(resolved);
  const files = await loadSourceFiles(fileSource, ".");
  for (const [relPath, content] of files) {
    service.updateFile(path.resolve(resolved, relPath), content);
  }

  typeCheckServiceCache.set(key, service);
  return service;
}

/** Serializable diagnostic (without ts.DiagnosticCategory enum reference). */
interface SerializedDiagnostic {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  severity: "error" | "warning" | "info";
  code: number;
}

function serializeDiagnostics(diagnostics: TypeCheckDiagnostic[]): SerializedDiagnostic[] {
  return diagnostics.map((d) => ({
    file: d.file,
    line: d.line,
    column: d.column,
    endLine: d.endLine,
    endColumn: d.endColumn,
    message: d.message,
    severity: d.severity,
    code: d.code,
  }));
}

const NPM_PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const MAX_BROWSER_PACKAGE_TYPES = 64;

function normalizeBrowserPackageNames(packageNames?: readonly string[]): string[] {
  if (packageNames === undefined) return [];
  if (!Array.isArray(packageNames)) {
    throw new Error("typecheck.getBrowserTypeDefinitions: packageNames must be an array");
  }
  if (packageNames.length > MAX_BROWSER_PACKAGE_TYPES) {
    throw new Error(
      `typecheck.getBrowserTypeDefinitions: packageNames is limited to ${MAX_BROWSER_PACKAGE_TYPES} packages`
    );
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const packageName of packageNames) {
    if (typeof packageName !== "string" || !NPM_PACKAGE_NAME_PATTERN.test(packageName)) {
      throw new Error(
        `typecheck.getBrowserTypeDefinitions: invalid package name ${JSON.stringify(packageName)}`
      );
    }
    if (seen.has(packageName)) continue;
    seen.add(packageName);
    normalized.push(packageName);
  }
  return normalized;
}

function mapToSortedRecord(map: Map<string, string>): Record<string, string> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function toPackageTypeDefinitionFilePath(packageName: string, relativePath: string): string {
  const normalized = relativePath.split(path.sep).join("/");
  const safeRelative = normalized.startsWith("../")
    ? normalized.replace(/\.\.\//g, "__parent__/")
    : normalized;
  return `file:///node_modules/${packageName}/${safeRelative}`;
}

function serializeLoadedPackageTypeDefinitions(
  packageName: string,
  loaded: LoadedTypeDefinitions | null
): SerializedPackageTypeDefinitions {
  if (!loaded) {
    return {
      packageName,
      files: {},
      entryPoint: null,
      errors: [`No type definitions found for package: ${packageName}`],
      referencedPackages: [],
      subpaths: {},
      typeDefinitionFiles: [],
    };
  }

  const files = mapToSortedRecord(loaded.files);
  return {
    packageName,
    files,
    entryPoint: loaded.entryPoint,
    errors: [...loaded.errors],
    referencedPackages: [...loaded.referencedPackages],
    subpaths: mapToSortedRecord(loaded.subpaths),
    typeDefinitionFiles: Object.entries(files).map(([relativePath, content]) => ({
      packageName,
      relativePath,
      filePath: toPackageTypeDefinitionFilePath(packageName, relativePath),
      content,
    })),
  };
}

async function loadBrowserPackageTypeDefinitions(
  panelPath: string,
  packageNames: readonly string[],
  options?: TypeCheckRpcOptions
): Promise<SerializedPackageTypeDefinitions[]> {
  const resolved = path.resolve(panelPath);
  const nodeModulesPaths = [
    ...(await resolveTypecheckNodeModulesPaths(resolved, options)),
    ...getDefaultNodeModulesPaths(resolved),
  ];
  const loader = createTypeDefinitionLoader({
    nodeModulesPaths: [...new Set(nodeModulesPaths)],
  });

  return Promise.all(
    packageNames.map(async (packageName) =>
      serializeLoadedPackageTypeDefinitions(packageName, await loader.loadPackageTypes(packageName))
    )
  );
}

// =============================================================================
// RPC methods
// =============================================================================

export const typeCheckRpcMethods = {
  "typecheck.check": async (
    panelPath: string,
    filePath?: string,
    fileContent?: string,
    options?: TypeCheckRpcOptions
  ): Promise<{ diagnostics: SerializedDiagnostic[]; checkedFiles: string[] }> => {
    const service = await getOrCreateTypeCheckService(panelPath, options);
    const resolved = path.resolve(panelPath);

    if (filePath) {
      const resolvedFile = path.resolve(resolved, filePath);
      if (fileContent !== undefined) {
        service.updateFile(resolvedFile, fileContent);
      } else {
        // Always refresh from disk — agent may have edited since service was created
        try {
          service.updateFile(resolvedFile, await fs.readFile(resolvedFile, "utf-8"));
        } catch {
          /* file may not exist yet */
        }
      }
    } else {
      // Whole-panel check: resync all files from disk
      const files = await loadSourceFiles(createDiskFileSource(resolved), ".");
      for (const [relPath, content] of files) {
        service.updateFile(path.resolve(resolved, relPath), content);
      }
    }

    const result = service.check(filePath ? path.resolve(resolved, filePath) : undefined);
    return {
      diagnostics: serializeDiagnostics(result.diagnostics),
      checkedFiles: result.checkedFiles,
    };
  },

  "typecheck.getTypeInfo": async (
    panelPath: string,
    filePath: string,
    line: number,
    column: number,
    fileContent?: string,
    options?: TypeCheckRpcOptions
  ): Promise<{
    displayParts: string;
    documentation?: string;
    tags?: { name: string; text?: string }[];
  } | null> => {
    const service = await getOrCreateTypeCheckService(panelPath, options);
    const resolved = path.resolve(panelPath);
    const resolvedFile = path.resolve(resolved, filePath);

    if (fileContent !== undefined) {
      service.updateFile(resolvedFile, fileContent);
    } else {
      try {
        service.updateFile(resolvedFile, await fs.readFile(resolvedFile, "utf-8"));
      } catch {
        return null;
      }
    }

    const info = service.getQuickInfo(resolvedFile, line, column);
    if (!info) return null;
    return {
      displayParts: info.displayParts,
      documentation: info.documentation,
      tags: info.tags?.map((t) => ({ name: t.name, text: t.text })),
    };
  },

  "typecheck.getCompletions": async (
    panelPath: string,
    filePath: string,
    line: number,
    column: number,
    fileContent?: string,
    options?: TypeCheckRpcOptions
  ): Promise<{ entries: { name: string; kind: string }[] } | null> => {
    const service = await getOrCreateTypeCheckService(panelPath, options);
    const resolved = path.resolve(panelPath);
    const resolvedFile = path.resolve(resolved, filePath);

    if (fileContent !== undefined) {
      service.updateFile(resolvedFile, fileContent);
    } else {
      try {
        service.updateFile(resolvedFile, await fs.readFile(resolvedFile, "utf-8"));
      } catch {
        return null;
      }
    }

    const completions = service.getCompletions(resolvedFile, line, column);
    if (!completions || completions.entries.length === 0) return null;

    return {
      entries: completions.entries.map((e) => ({ name: e.name, kind: e.kind })),
    };
  },

  "typecheck.getBrowserTypeDefinitions": async (
    panelPath?: string,
    packageNames?: string[],
    options?: TypeCheckRpcOptions
  ): Promise<BrowserTypeDefinitionsResponse> => {
    const normalizedPackageNames = normalizeBrowserPackageNames(packageNames);
    if (normalizedPackageNames.length > 0 && !panelPath) {
      throw new Error(
        "typecheck.getBrowserTypeDefinitions: panelPath is required when packageNames are requested"
      );
    }

    const packageTypes = panelPath
      ? await loadBrowserPackageTypeDefinitions(panelPath, normalizedPackageNames, options)
      : [];

    return {
      ...getBrowserTypeDefinitions(),
      packageTypes,
      packageTypeDefinitionFiles: packageTypes.flatMap((pkg) => pkg.typeDefinitionFiles),
    };
  },
};

/**
 * Clear the per-panel TypeCheckService cache. Tests use this between runs;
 * production code rarely needs it since caches are cheap to rebuild on the
 * next call.
 */
export function clearTypeCheckCache(): void {
  typeCheckServiceCache.clear();
  nodeModulesPathCache.clear();
}
