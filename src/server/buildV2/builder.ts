/**
 * Builder — esbuild orchestration for panels, about pages, workers, and extensions.
 *
 * Two build strategies:
 *   - Panel/About (browser target): ESM, code splitting, fs/path shims
 *   - Worker (workerd target): ESM, code splitting into an in-memory module map
 *   - Extension (Node target): ESM, no splitting
 *
 * Build options are manifest-derived, not caller-supplied.
 * Concurrency: semaphore with MAX_CONCURRENT_BUILDS = 8 by default.
 * Coalescing: dedup concurrent builds of the same build key.
 *
 * Source files are materialized from the requested GAD state, so builds always
 * match what the EV describes regardless of working tree state.
 */

import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createHash } from "crypto";
import { execFile } from "child_process";
import { createRequire } from "module";
import { promisify } from "util";
import { pathToFileURL } from "url";
import {
  transformSync as transformBabel,
  types as babelTypes,
  type PluginItem,
  type PluginObj,
} from "@babel/core";
import type { GraphNode, PackageGraph } from "./packageGraph.js";
import { BuildRequestError } from "./diagnostics.js";
import type { LibraryBuildTarget } from "@vibestudio/service-schemas/build";
import {
  appUnitManifestDescriptor,
  extensionUnitManifestDescriptor,
  validateUnitManifest,
  isTerminalWorker,
  parseExtensionMethodAuthority,
} from "@vibestudio/shared/unitManifest";
import { sha256Canonical } from "@vibestudio/shared/authority/invocationSnapshot";
import {
  parseUnitAuthorityManifest,
  type UnitAuthorityManifest,
} from "@vibestudio/shared/authorityManifest";
import * as buildStore from "./buildStore.js";
import {
  contentTypeForPath,
  primaryArtifactFilePath,
  primaryTextArtifactContent,
  type BuildArtifactInput,
  type BuildArtifactWithContent,
  type BuildArtifacts,
  type BuildMetadata,
  type BuildResult,
} from "./buildStore.js";
import { computeBuildKey } from "./effectiveVersion.js";
import {
  dependencyPatchesForExternalRoots,
  acquireExternalDeps,
  ensureExtensionRuntimeDeps,
  prepareExternalDependencyEnvironment,
  type ExternalDependencyPatch,
} from "./externalDeps.js";
import { collectTransitiveInternalDeps, getBuildSourceProvider } from "./buildSource.js";
import { assertUnitIconSize, declaredUnitIconPath } from "./unitIcon.js";
import { PANEL_CSP_META } from "@vibestudio/shared/constants";
import { EXTENSION_RUNTIME_ABI_VERSION } from "@vibestudio/shared/extensionRuntimeAbi";
import { getAdapter } from "./adapters/index.js";
import type { FrameworkAdapter } from "./adapters/types.js";
import { resolveTemplate } from "./templateResolver.js";
import {
  RUNTIME_MODULE,
  TERMINAL_SHIM_YOGA,
  TERMINAL_SHIM_SIGNAL_EXIT,
  TERMINAL_SHIM_TERMINAL_SIZE,
  WORKER_RUNTIME_COMPANION_MODULES,
} from "./platformModules.js";
import { resolveExportSubpath } from "@vibestudio/typecheck/workspace";
import { assertPresent } from "../../lintHelpers";
import { resolveBuildProvider } from "./buildProviderRegistry.js";
import { createBuildScratchDir } from "./buildScratch.js";
import type {
  BuildProvider,
  BuildProviderArtifact,
  BuildProviderInput,
} from "@vibestudio/shared/buildProvider";
import { collectWorkspaceRpcCatalog } from "./workspaceRpcCatalog.js";
import { unknownWorkspaceRpcSchemaMessage, workspaceRpcSchema } from "./workspaceRpcSchemas.js";
import { createPanelBundleReport } from "./panelBundleReport.js";
import { generatePanelEntry } from "./panelEntryProtocol.js";
import { createSharedStyleDedupePlugin } from "./sharedStyleDedupe.js";
export { generatePanelEntry } from "./panelEntryProtocol.js";

/**
 * Library artifacts execute inside the eval linker, not the host ESM loader.
 * Route every syntactic dynamic import through the linker's closure-held
 * callback. This is a per-build transform, so newly authored workspace
 * packages do not depend on a host-generated source census.
 */
const controlledDynamicImportPlugin: PluginObj = {
  name: "vibestudio-controlled-dynamic-import",
  visitor: {
    CallExpression(callPath) {
      if (callPath.node.callee.type !== "Import") return;
      callPath.replaceWith(
        babelTypes.callExpression(babelTypes.identifier("__vibestudioImport"), [
          ...callPath.node.arguments,
        ])
      );
    },
  },
};

// ---------------------------------------------------------------------------
// Module Initialization
// ---------------------------------------------------------------------------

/**
 * Absolute paths to the app's node_modules directories, where runtime packages
 * and @vibestudio/* platform packages are installed. Packaged builds may need
 * both app.asar.unpacked/node_modules for physical packages and app.asar/node_modules
 * for workspace-linked packages that electron-builder stores in the archive.
 */
let _appNodeModules: string[] = [];
let _appRoot = "";
let _transformModulesCommonJs: PluginItem | null = null;

function createHostRequire(nodeModulesRoot: string): NodeJS.Require {
  return createRequire(path.join(nodeModulesRoot, "__vibestudio_host_resolver.cjs"));
}

function resolveHostDependency(specifier: string): string {
  let cause: unknown;
  for (const nodeModulesRoot of _appNodeModules) {
    try {
      return createHostRequire(nodeModulesRoot).resolve(specifier);
    } catch (error) {
      cause = error;
    }
  }
  throw new Error(
    `Could not resolve host dependency ${JSON.stringify(specifier)} from configured app node_modules roots: ${_appNodeModules.join(", ") || "(none)"}`,
    { cause }
  );
}

function requireHostDependency(specifier: string): unknown {
  const resolved = resolveHostDependency(specifier);
  return createRequire(resolved)(resolved);
}

function getTransformModulesCommonJs(): PluginItem {
  if (!_transformModulesCommonJs) {
    _transformModulesCommonJs = requireHostDependency(
      "@babel/plugin-transform-modules-commonjs"
    ) as PluginItem;
  }
  return _transformModulesCommonJs;
}

/**
 * Initialize the builder with the app's node_modules paths.
 * Must be called once before any buildUnit() calls.
 */
export function initBuilder(appNodeModules: string | string[], appRoot: string): void {
  _appNodeModules = Array.isArray(appNodeModules) ? appNodeModules : [appNodeModules];
  _appRoot = path.resolve(appRoot);
  _transformModulesCommonJs = null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

function resolveMaxConcurrentBuilds(): number {
  const parsed = Number.parseInt(process.env["VIBESTUDIO_MAX_CONCURRENT_BUILDS"] ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 8;
}

const MAX_CONCURRENT_BUILDS = resolveMaxConcurrentBuilds();
const PANEL_ASSET_LOADERS: Record<string, esbuild.Loader> = {
  ".png": "file",
  ".jpg": "file",
  ".jpeg": "file",
  ".gif": "file",
  ".webp": "file",
  ".avif": "file",
  ".svg": "file",
  ".ico": "file",
  ".bmp": "file",
  ".tif": "file",
  ".tiff": "file",
  ".woff": "file",
  ".woff2": "file",
  ".ttf": "file",
  ".otf": "file",
  ".eot": "file",
  ".mp3": "file",
  ".aac": "file",
  ".m4a": "file",
  ".flac": "file",
  ".oga": "file",
  ".wav": "file",
  ".ogg": "file",
  ".opus": "file",
  ".aif": "file",
  ".aiff": "file",
  ".mp4": "file",
  ".m4v": "file",
  ".webm": "file",
  ".ogv": "file",
  ".mov": "file",
  ".avi": "file",
  ".mkv": "file",
  ".wasm": "file",
  ".pdf": "file",
};

const LIBRARY_ASSET_LOADERS: Record<string, esbuild.Loader> = Object.fromEntries(
  Object.keys(PANEL_ASSET_LOADERS).map((ext) => [ext, "dataurl" as esbuild.Loader])
);

const TEXT_EXTENSIONS = new Set([".js", ".css", ".json", ".map", ".svg", ".txt", ".md", ".html"]);

const KNOWN_NATIVE_EXTERNALS = [
  "*.node",
  "fsevents",
  "bufferutil",
  "utf-8-validate",
  "node-pty",
  "cpu-features",
  "@parcel/watcher",
];

export type ExtensionDependencyMode = "auto" | "bundle" | "external";

export interface ClassifiedExtensionDep {
  name: string;
  version: string;
  external: boolean;
  format: "cjs" | "esm" | "unknown";
  reasons: string[];
  explanation: string;
}

export interface ExtensionDependencyDiagnostics {
  dependencyMode: ExtensionDependencyMode;
  classifiedDeps: ClassifiedExtensionDep[];
  runtimeExternalDeps: Record<string, string>;
  bundledDeps: Record<string, string>;
  notes: string[];
}

const execFileAsync = promisify(execFile);

function isVerboseBuildLogEnabled(): boolean {
  return (
    process.env["VIBESTUDIO_LOG_LEVEL"] === "verbose" ||
    process.env["VIBESTUDIO_LOG_LEVEL"] === "trace"
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${bytes}B`;
}

// ---------------------------------------------------------------------------
// Path Remapping
// ---------------------------------------------------------------------------

/**
 * Resolve a graph node inside a materialized source root.
 *
 * Graph nodes may have been discovered from a different checkout than the one
 * used for this build. The stable coordinate is `relativePath`; resolving from
 * absolute `node.path` would mix mutable checkout content into an exact build.
 */
function sourcePathForNode(node: GraphNode, sourceRoot: string): string {
  return path.join(sourceRoot, node.relativePath);
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

let runningBuilds = 0;
const waitQueue: (() => void)[] = [];

async function acquireSemaphore(): Promise<void> {
  if (runningBuilds < MAX_CONCURRENT_BUILDS) {
    runningBuilds++;
    return;
  }
  await new Promise<void>((resolve) => waitQueue.push(resolve));
  runningBuilds++;
}

function releaseSemaphore(): void {
  runningBuilds--;
  const next = waitQueue.shift();
  if (next) next();
}

// Build coalescing: dedup concurrent builds of the same key
const inFlightBuilds = new Map<string, Promise<BuildResult>>();
const inFlightLibraryBuilds = new Map<string, Promise<BuildResult>>();

// ---------------------------------------------------------------------------
// Resolve Plugin
// ---------------------------------------------------------------------------

/**
 * Create an esbuild plugin that resolves @workspace/* imports from
 * the materialized source tree. All packages are read from the same immutable
 * GAD state to preserve content-addressable semantics: the build always
 * matches the EV regardless of filesystem state.
 *
 * Since materialized source states do not include generated dist/, the plugin maps
 * exports-based dist/ paths to their TypeScript source equivalents.
 */
const PANEL_CONDITIONS = ["vibestudio-panel", "import", "default"] as const;

function parseGraphImport(
  importPath: string,
  graph: PackageGraph
): { packageName: string; subpath: string } | null {
  const names = graph
    .allNodes()
    .map((node) => node.name)
    .sort((a, b) => b.length - a.length);

  for (const name of names) {
    if (importPath === name) {
      return { packageName: name, subpath: "." };
    }
    if (importPath.startsWith(`${name}/`)) {
      return { packageName: name, subpath: `./${importPath.slice(name.length + 1)}` };
    }
  }

  return null;
}

function createWorkspaceResolvePlugin(
  graph: PackageGraph,
  sourceRoot: string,
  conditions: readonly string[] = PANEL_CONDITIONS,
  externalSpecifiers: readonly string[] = []
): esbuild.Plugin {
  // esbuild applies the top-level `external` option in its DEFAULT resolver,
  // which runs AFTER plugins — so a workspace specifier this plugin resolves to
  // source would be bundled even when listed in `external`. Honor the externals
  // here (exact match) so caller-provided externals actually win. Used by eval
  // library builds to keep `@workspace/runtime` (and other host-provided modules)
  // OUT of the bundle: they must resolve at runtime to the EvalDO's hosted `rt`,
  // not the panel entry (whose top-level `initRuntime()` crashes in a DO isolate).
  const externalSet = new Set(externalSpecifiers);
  return {
    name: "workspace-packages",
    setup(build) {
      // Match any package discovered in the workspace graph, including
      // @workspace/* aliases and template-provided @vibestudio/* source packages.
      build.onResolve({ filter: /^[^./]|^@/ }, (args) => {
        if (externalSet.has(args.path)) return { path: args.path, external: true };
        const parsed = parseGraphImport(args.path, graph);
        if (!parsed) return null;

        const node = graph.tryGet(parsed.packageName);
        if (!node) return null;

        const sourcePath = sourcePathForNode(node, sourceRoot);
        const pkgJsonPath = path.join(sourcePath, "package.json");
        if (!fs.existsSync(pkgJsonPath)) {
          return {
            errors: [
              {
                text:
                  `Internal package ${parsed.packageName} is missing from the exact build closure. ` +
                  `Declare the dependency that owns this generated/runtime import.`,
              },
            ],
          };
        }

        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
          main?: string;
          exports?: Record<string, unknown>;
        };

        // Try exports-based resolution, then main field
        let target: string | null = null;
        if (pkgJson.exports) {
          target = resolveExportSubpath(pkgJson.exports, parsed.subpath, conditions);
        }
        if (!target && parsed.subpath === "." && pkgJson.main) {
          target = pkgJson.main;
        }

        if (target) {
          const resolved = path.resolve(sourcePath, target);

          // Build-output exports are generated artifacts. Prefer source even
          // when a stale dist/lib/build/out file exists in the extracted tree.
          const srcFallback = resolveSourceFallback(sourcePath, target);
          if (isBuildOutputTarget(target) && srcFallback) return { path: srcFallback };

          if (fs.existsSync(resolved)) return { path: resolved };

          // dist/ is generated output; map to TypeScript source.
          if (srcFallback) return { path: srcFallback };
        }

        // Last resort: try common source entry patterns
        if (parsed.subpath === ".") {
          for (const entry of SOURCE_ENTRY_CANDIDATES) {
            const full = path.join(sourcePath, entry);
            if (fs.existsSync(full)) return { path: full };
          }
        }

        return null;
      });
    },
  };
}

const SOURCE_ENTRY_CANDIDATES = ["src/index.ts", "src/index.tsx", "index.ts", "index.tsx"];

/** Common build output directories that tsc/other compilers write to (gitignored). */
const BUILD_OUTPUT_DIRS = ["dist", "lib", "build", "out"];

function isBuildOutputTarget(target: string): boolean {
  return BUILD_OUTPUT_DIRS.some((dir) => target === `./${dir}` || target.startsWith(`./${dir}/`));
}

/**
 * Map a build-output export target to its TypeScript source equivalent.
 * Inverts the tsc compilation mapping, e.g.:
 *   ./dist/foo.js    → ./src/foo.ts
 *   ./lib/panel.js   → ./src/panel.ts
 *   ./index.js       → ./index.ts (flat layout, no output dir)
 *
 * Tries each known output dir replacement with src/, then tries the target
 * as-is with .js→.ts rewrite (for flat layouts without an output dir).
 */
function resolveSourceFallback(sourcePath: string, target: string): string | null {
  const candidates: string[] = [];

  // Try replacing each known output dir with src/
  for (const dir of BUILD_OUTPUT_DIRS) {
    const pattern = new RegExp(`^\\./${dir}/`);
    if (pattern.test(target)) {
      candidates.push(target.replace(pattern, "./src/"));
      break; // Only one output dir can match
    }
  }

  // Also try the target as-is (flat layout: ./index.js → ./index.ts)
  candidates.push(target);

  for (const candidate of candidates) {
    const base = candidate.replace(/\.js$/, "");
    for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      const full = path.resolve(sourcePath, base + ext);
      if (fs.existsSync(full)) return full;
    }
  }

  return null;
}

/**
 * Rewrite .js extension imports to .ts/.tsx within the materialized source tree.
 *
 * TypeScript ESM sources use .js extensions in imports (e.g., `from "./rpc.js"`)
 * per the TypeScript convention: these reference compiled output. In the
 * materialized source state, only .ts files exist. This plugin intercepts .js imports
 * within the source root and rewrites them to their .ts/.tsx equivalents.
 */
function createTsExtensionPlugin(sourceRoot: string): esbuild.Plugin {
  return {
    name: "ts-extension-rewrite",
    setup(build) {
      build.onResolve({ filter: /\.js$/ }, (args) => {
        // Only relative imports within materialized source
        if (!args.path.startsWith(".") || !args.resolveDir) return null;
        if (!args.resolveDir.startsWith(sourceRoot)) return null;

        const resolved = path.resolve(args.resolveDir, args.path);
        if (fs.existsSync(resolved)) return null; // .js exists, use it

        // Try .ts and .tsx equivalents
        const base = resolved.slice(0, -3); // strip .js
        for (const ext of [".ts", ".tsx"]) {
          if (fs.existsSync(base + ext)) return { path: base + ext };
        }

        return null;
      });
    },
  };
}

function isBareSpecifier(spec: string): boolean {
  return !spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("node:");
}

function normalizeManifestSpecList(specs: string[] | undefined): string[] {
  if (!specs) return [];
  const deduped = new Set<string>();
  for (const raw of specs) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (!value || !isBareSpecifier(value)) continue;
    deduped.add(value);
  }
  return [...deduped].sort();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function packageToRegex(pkg: string): RegExp {
  return new RegExp(`^${escapeRegex(pkg)}(?:$|/)`);
}

function sanitizeModuleForFileName(specifier: string): string {
  return specifier.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function pickResolveDir(nodePaths: string[], fallback: string): string {
  for (const p of nodePaths) {
    if (p && fs.existsSync(p)) return p;
  }
  return fallback;
}

function expandExternalSpecifiers(externals: Record<string, string>): string[] {
  const patterns = new Set<string>();
  for (const specifier of Object.keys(externals)) {
    if (!specifier) continue;
    patterns.add(specifier);
    if (specifier.endsWith("/")) {
      patterns.add(`${specifier}*`);
    }
  }
  return [...patterns];
}

export function normalizeExtensionDependencyMode(value: unknown): ExtensionDependencyMode {
  return value === "bundle" || value === "external" || value === "auto" ? value : "auto";
}

function packageJsonPathForSpecifier(specifier: string, nodePaths: string[]): string | null {
  const parts = specifier.split("/");
  const packagePath = specifier.startsWith("@")
    ? path.join(parts[0] ?? "", parts[1] ?? "")
    : (parts[0] ?? "");
  for (const root of nodePaths) {
    if (!root) continue;
    const candidate = path.join(root, packagePath, "package.json");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function hasFileWithExtension(dir: string, extensions: Set<string>): boolean {
  if (!fs.existsSync(dir)) return false;
  const stack = [dir];
  while (stack.length > 0) {
    const current = assertPresent(stack.pop());
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
        return true;
      }
    }
  }
  return false;
}

function explainExtensionDep(
  name: string,
  mode: ExtensionDependencyMode,
  format: ClassifiedExtensionDep["format"],
  reasons: string[]
): string {
  if (mode === "external") return `${name} is externalized because dependencyMode is "external".`;
  if (mode === "bundle") return `${name} is bundled because dependencyMode is "bundle".`;
  if (reasons.includes("native"))
    return `${name} is externalized because it contains native bindings.`;
  if (reasons.includes("wasm-asset"))
    return `${name} is externalized because it contains WASM assets.`;
  if (reasons.includes("missing-package-json")) {
    return `${name} is bundled by default, but its package.json was not found during classification.`;
  }
  if (reasons.includes("unreadable-package-json")) {
    return `${name} is bundled by default, but its package.json could not be read.`;
  }
  return `${name} is bundled because it looks like plain ${format === "esm" ? "ESM" : format === "cjs" ? "CommonJS" : "JavaScript"}.`;
}

export function classifyExtensionDeps(
  deps: Record<string, string>,
  nodePaths: string[],
  mode: ExtensionDependencyMode
): ClassifiedExtensionDep[] {
  return Object.entries(deps)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, version]) => {
      const pkgJsonPath = packageJsonPathForSpecifier(name, nodePaths);
      const reasons: string[] = [];
      let format: ClassifiedExtensionDep["format"] = "unknown";
      if (pkgJsonPath) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
            type?: string;
            main?: string;
            module?: string;
            binary?: unknown;
            gypfile?: unknown;
          };
          format = pkg.type === "module" ? "esm" : "cjs";
          const packageDir = path.dirname(pkgJsonPath);
          if (pkg.binary || pkg.gypfile || hasFileWithExtension(packageDir, new Set([".node"]))) {
            reasons.push("native");
          }
          if (hasFileWithExtension(packageDir, new Set([".wasm"]))) {
            reasons.push("wasm-asset");
          }
        } catch {
          reasons.push("unreadable-package-json");
        }
      } else {
        reasons.push("missing-package-json");
      }

      const external =
        mode === "external"
          ? true
          : mode === "bundle"
            ? false
            : reasons.includes("native") || reasons.includes("wasm-asset");

      return {
        name,
        version,
        external,
        format,
        reasons,
        explanation: explainExtensionDep(name, mode, format, reasons),
      };
    });
}

export function depsRecord(
  classified: ClassifiedExtensionDep[],
  external: boolean
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const dep of classified) {
    if (dep.external === external) selected[dep.name] = dep.version;
  }
  return selected;
}

export function analyzeExtensionDependencies(
  deps: Record<string, string>,
  nodePaths: string[],
  dependencyMode: ExtensionDependencyMode
): ExtensionDependencyDiagnostics {
  const classifiedDeps = classifyExtensionDeps(deps, nodePaths, dependencyMode);
  const runtimeExternalDeps = depsRecord(classifiedDeps, true);
  const bundledDeps = depsRecord(classifiedDeps, false);
  const notes: string[] = [];
  for (const dep of classifiedDeps) {
    notes.push(dep.explanation);
    if (dep.external && dep.format === "cjs") {
      notes.push(
        `${dep.name} is external CommonJS. Generated ESM code should import it with a default import; named imports fail fast at build time.`
      );
    }
  }
  if (classifiedDeps.length === 0) {
    notes.push("No external npm dependencies were discovered for this extension.");
  }
  return { dependencyMode, classifiedDeps, runtimeExternalDeps, bundledDeps, notes };
}

function createExtensionCjsShimPlugin(
  outdir: string,
  deps: ClassifiedExtensionDep[]
): esbuild.Plugin | null {
  const cjsExternalDeps = deps.filter((dep) => dep.external && dep.format === "cjs");
  if (cjsExternalDeps.length === 0) return null;
  const cjsExternalNames = new Set(cjsExternalDeps.map((dep) => dep.name));
  const shimDir = path.join(outdir, "_extension-cjs-shims");
  fs.mkdirSync(shimDir, { recursive: true });

  return {
    name: "extension-cjs-external-shims",
    setup(build) {
      for (const name of cjsExternalNames) {
        const filter = packageToRegex(name);
        build.onResolve({ filter }, (args) => {
          if (args.kind === "require-call") return null;
          if (args.path !== name) return null;
          return {
            path: path.join(shimDir, `${sanitizeModuleForFileName(name)}.mjs`),
            namespace: "extension-cjs-shim",
            pluginData: { name },
          };
        });
      }
      build.onLoad({ filter: /.*/, namespace: "extension-cjs-shim" }, (args) => {
        const name = (args.pluginData as { name: string }).name;
        return {
          loader: "js",
          contents: [
            "import { createRequire as __vibestudioCjsShimCreateRequire } from 'node:module';",
            "const __vibestudioCjsShimRequire = __vibestudioCjsShimCreateRequire(import.meta.url);",
            `const mod = __vibestudioCjsShimRequire(${JSON.stringify(name)});`,
            "export default mod;",
          ].join("\n"),
        };
      });
    },
  };
}

function createDedupePlugin(runtimeNodeModules: string, packages: string[]): esbuild.Plugin | null {
  if (!runtimeNodeModules || !fs.existsSync(runtimeNodeModules)) {
    return null;
  }
  if (packages.length === 0) {
    return null;
  }

  const resolvedRuntimeNodeModules = path.resolve(runtimeNodeModules);
  const patterns = packages.map((pkg) => packageToRegex(pkg));

  return {
    name: "module-dedupe",
    setup(build) {
      for (const pattern of patterns) {
        build.onResolve({ filter: pattern }, async (args) => {
          // Keep resolution unchanged when we're already resolving from runtime node_modules.
          if (path.resolve(args.resolveDir).startsWith(resolvedRuntimeNodeModules)) {
            return null;
          }
          try {
            const result = await build.resolve(args.path, {
              kind: args.kind,
              resolveDir: resolvedRuntimeNodeModules,
            });
            if (!result.errors || result.errors.length === 0) {
              return result;
            }
          } catch {
            // Fall through to default resolver.
          }
          return null;
        });
      }
    },
  };
}

function createAppRuntimeShimPlugin(): esbuild.Plugin {
  const unavailable = `() => { throw new Error(${JSON.stringify(
    `${RUNTIME_MODULE} panel APIs are not available in workspace app renderers`
  )}); }`;
  const ns = `new Proxy({}, { get: () => unavailable })`;
  const contents = `const unavailable = ${unavailable};
// --- Portable runtime surface (identical names on panel/worker/eval) ---
export const id = "app";
export const contextId = "";
export const rpc = {};
export const fs = new Proxy({}, { get: () => unavailable });
export const callMain = unavailable;
export const parent = {};
export const getParent = unavailable;
export const getParentWithContract = unavailable;
export const gad = ${ns};
export const workspace = ${ns};
export const credentials = ${ns};
export const git = ${ns};
export const vcs = ${ns};
export const webhooks = ${ns};
export const extensions = ${ns};
export const approvals = ${ns};
export const notifications = ${ns};
export const workers = ${ns};
export const doTargetId = unavailable;
export const createDurableObjectServiceClient = unavailable;
export const gatewayConfig = {};
export const gatewayFetch = unavailable;
export const openExternal = unavailable;
export const openPanel = unavailable;
export const getPanelHandle = unavailable;
export const panelTree = ${ns};
// --- Portable authoring helpers ---
export const Rpc = {};
export const z = {};
export const defineContract = (contract) => contract;
export const buildPanelLink = unavailable;
export const parseContextId = unavailable;
export const isValidContextId = () => false;
export const getInstanceId = unavailable;
export const normalizePath = (value) => String(value);
export const getFileName = (value) => String(value).split("/").pop() ?? "";
export const resolvePath = (...parts) => parts.join("/");
export const createGatewayFetch = () => unavailable;
// --- Panel-only namespaces / domain ---
export const panel = ${ns};
export const journal = ${ns};
export const agentApi = {};
export const adblock = ${ns};
export default {};`;
  return {
    name: "app-runtime-shim",
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${escapeRegex(RUNTIME_MODULE)}$`) }, () => ({
        path: RUNTIME_MODULE,
        namespace: "app-runtime-shim",
      }));
      build.onLoad({ filter: /.*/, namespace: "app-runtime-shim" }, () => ({
        contents,
        loader: "js",
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// FS/Path Shim Plugins
// ---------------------------------------------------------------------------

function createFsShimPlugin(options: {
  runtimeBacked: boolean;
  resolveDir: string;
}): esbuild.Plugin {
  const resolveDir = options.resolveDir;
  return {
    name: "fs-shim",
    setup(build) {
      build.onResolve({ filter: /^(fs|node:fs|fs\/promises|node:fs\/promises)$/ }, (args) => ({
        path: args.path,
        namespace: "workspace-fs-shim",
      }));

      build.onLoad({ filter: /.*/, namespace: "workspace-fs-shim" }, (args) => {
        const isPromises = args.path === "fs/promises" || args.path === "node:fs/promises";
        if (!options.runtimeBacked) {
          const unavailable =
            '() => { throw new Error("Node fs is not available in workspace app renderers"); }';
          const contents = isPromises
            ? `export const readFile = ${unavailable};
export const writeFile = ${unavailable};
export const readdir = ${unavailable};
export const stat = ${unavailable};
export const lstat = ${unavailable};
export const mkdir = ${unavailable};
export const rmdir = ${unavailable};
export const unlink = ${unavailable};
export const rename = ${unavailable};
export const copyFile = ${unavailable};
export const access = ${unavailable};
export const appendFile = ${unavailable};
export const chmod = ${unavailable};
export const chown = ${unavailable};
export const symlink = ${unavailable};
export const readlink = ${unavailable};
export const realpath = ${unavailable};
export const truncate = ${unavailable};
export const utimes = ${unavailable};
export const rm = ${unavailable};
export const open = ${unavailable};
export const link = ${unavailable};
export const mkdtemp = ${unavailable};
export const watch = ${unavailable};
export const cp = ${unavailable};
export const constants = {};`
            : `const unavailable = ${unavailable};
export const promises = new Proxy({}, { get: () => unavailable });
export const readFile = unavailable;
export const writeFile = unavailable;
export const readdir = unavailable;
export const stat = unavailable;
export const lstat = unavailable;
export const mkdir = unavailable;
export const rmdir = unavailable;
export const unlink = unavailable;
export const rename = unavailable;
export const copyFile = unavailable;
export const access = unavailable;
export const appendFile = unavailable;
export const chmod = unavailable;
export const chown = unavailable;
export const symlink = unavailable;
export const readlink = unavailable;
export const realpath = unavailable;
export const truncate = unavailable;
export const utimes = unavailable;
export const rm = unavailable;
export const open = unavailable;
export const link = unavailable;
export const mkdtemp = unavailable;
export const watch = unavailable;
export const cp = unavailable;
export const constants = {};
export const existsSync = unavailable;
export const readFileSync = unavailable;
export const writeFileSync = unavailable;
export const mkdirSync = unavailable;
export const rmSync = unavailable;
export const statSync = unavailable;
export const lstatSync = unavailable;
export default { promises, readFile, writeFile, readdir, stat, lstat, mkdir, rmdir, unlink, rename, copyFile, access, appendFile, chmod, chown, symlink, readlink, realpath, truncate, utimes, rm, open, link, mkdtemp, watch, cp, constants, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync, lstatSync };`;
          return { loader: "js", resolveDir, contents };
        }
        // The runtime SDK exports `fs` as a Proxy object with async methods
        // (see platformModules.RUNTIME_MODULE for the contract).
        // We destructure individual methods from it for Node fs/promises compat.
        const contents = isPromises
          ? `import { fs as _fs } from ${JSON.stringify(RUNTIME_MODULE)};
export const readFile = (...a) => _fs.readFile(...a);
export const writeFile = (...a) => _fs.writeFile(...a);
export const readdir = (...a) => _fs.readdir(...a);
export const stat = (...a) => _fs.stat(...a);
export const lstat = (...a) => _fs.lstat(...a);
export const mkdir = (...a) => _fs.mkdir(...a);
export const rmdir = (...a) => _fs.rmdir(...a);
export const unlink = (...a) => _fs.unlink(...a);
export const rename = (...a) => _fs.rename(...a);
export const copyFile = (...a) => _fs.copyFile(...a);
export const access = (...a) => _fs.access(...a);
export const appendFile = (...a) => _fs.appendFile(...a);
export const chmod = (...a) => _fs.chmod(...a);
export const chown = () => { throw new Error("chown is not available in workspace panels"); };
export const symlink = (...a) => _fs.symlink(...a);
export const readlink = (...a) => _fs.readlink(...a);
export const realpath = (...a) => _fs.realpath(...a);
export const truncate = (...a) => _fs.truncate(...a);
export const utimes = (...a) => _fs.utimes(...a);
export const rm = (...a) => _fs.rm(...a);
export const open = (...a) => _fs.open(...a);
export const link = () => { throw new Error("link is not available in workspace panels"); };
export const mkdtemp = () => { throw new Error("mkdtemp is not available in workspace panels"); };
export const watch = () => { throw new Error("watch is not available in workspace panels"); };
export const cp = () => { throw new Error("cp is not available in workspace panels"); };
export const constants = {};`
          : `import { fs as _fs } from ${JSON.stringify(RUNTIME_MODULE)};
export const promises = _fs;
export const readFile = (...a) => _fs.readFile(...a);
export const writeFile = (...a) => _fs.writeFile(...a);
export const readdir = (...a) => _fs.readdir(...a);
export const stat = (...a) => _fs.stat(...a);
export const lstat = (...a) => _fs.lstat(...a);
export const mkdir = (...a) => _fs.mkdir(...a);
export const rmdir = (...a) => _fs.rmdir(...a);
export const unlink = (...a) => _fs.unlink(...a);
export const rename = (...a) => _fs.rename(...a);
export const copyFile = (...a) => _fs.copyFile(...a);
export const access = (...a) => _fs.access(...a);
export const appendFile = (...a) => _fs.appendFile(...a);
export const chmod = (...a) => _fs.chmod(...a);
export const symlink = (...a) => _fs.symlink(...a);
export const readlink = (...a) => _fs.readlink(...a);
export const realpath = (...a) => _fs.realpath(...a);
export const truncate = (...a) => _fs.truncate(...a);
export const utimes = (...a) => _fs.utimes(...a);
export const rm = (...a) => _fs.rm(...a);
export const open = (...a) => _fs.open(...a);
export const constants = {};
export const existsSync = () => { throw new Error("Synchronous fs methods are not available in workspace panels. Use async alternatives."); };
export const readFileSync = existsSync;
export const writeFileSync = existsSync;
export const readdirSync = existsSync;
export const statSync = existsSync;
export const mkdirSync = existsSync;
export const realpathSync = existsSync;
export default { promises: _fs, readFile, writeFile, readdir, stat, lstat, mkdir, rmdir, unlink, rename, copyFile, access, appendFile, chmod, symlink, readlink, realpath, truncate, utimes, rm, open, constants, existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, realpathSync };`;
        return { contents, loader: "js", resolveDir };
      });
    },
  };
}

function createPathShimPlugin(resolveDir: string): esbuild.Plugin {
  const reviewedPatheEntry = resolveHostDependency("pathe");
  return {
    name: "path-shim",
    setup(build) {
      build.onResolve({ filter: /^(path|node:path|path\/posix|node:path\/posix)$/ }, (args) => ({
        path: args.path,
        namespace: "workspace-path-shim",
      }));

      build.onLoad({ filter: /.*/, namespace: "workspace-path-shim" }, () => ({
        contents: `export { basename, dirname, extname, format, isAbsolute, join, normalize, parse, relative, resolve, sep, delimiter, toNamespacedPath } from ${JSON.stringify(reviewedPatheEntry)};
import * as pathe from ${JSON.stringify(reviewedPatheEntry)};
export const posix = pathe;
export default pathe;`,
        loader: "js",
        resolveDir,
      }));
    },
  };
}

function createCryptoShimPlugin(options: {
  includeNodePrefix?: boolean;
  resolveDir: string;
}): esbuild.Plugin {
  const includeNodePrefix = options.includeNodePrefix ?? true;
  const resolveDir = options.resolveDir;
  return {
    name: "crypto-shim",
    setup(build) {
      build.onResolve(
        { filter: includeNodePrefix ? /^(crypto|node:crypto)$/ : /^crypto$/ },
        (args) => ({
          path: args.path,
          namespace: "workspace-crypto-shim",
        })
      );

      build.onLoad({ filter: /.*/, namespace: "workspace-crypto-shim" }, () => ({
        contents: `/* Shim: Node crypto → Web Crypto API / sha.js for browser-like builds.
 *
 * Only the subset needed by bundled dependencies (e.g. isomorphic-git) is
 * provided.  Everything else throws so we notice quickly if a new call-site
 * appears.
 */
import Hash from "sha.js/sha1.js";

export function getRandomValues(arr) { return globalThis.crypto.getRandomValues(arr); }

export function randomBytes(size) {
  const buf = new Uint8Array(size);
  globalThis.crypto.getRandomValues(buf);
  return buf;
}

export function createHash(algorithm) {
  if (algorithm !== "sha1" && algorithm !== "sha-1") {
    throw new Error("crypto shim: unsupported algorithm " + algorithm);
  }
  const hash = new Hash();
  return {
    update(data) {
      hash.update(data);
      return this;
    },
    digest(encoding) {
      return hash.digest(encoding);
    },
  };
}

export default { getRandomValues, randomBytes, createHash };`,
        loader: "js",
        resolveDir,
      }));
    },
  };
}

function createWorkerBufferShimPlugin(_resolveDir: string): esbuild.Plugin {
  const reviewedBufferEntry = resolveHostDependency("buffer/");
  return {
    name: "worker-buffer-shim",
    setup(build) {
      build.onResolve({ filter: /^(buffer|node:buffer)$/ }, () => ({
        path: reviewedBufferEntry,
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// HTML Generation
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function relativeAssetHref(artifactPath: string): string {
  return artifactPath.startsWith("/") || artifactPath.startsWith("./")
    ? artifactPath
    : `./${artifactPath}`;
}

function panelLoaderScript(bundleSrc: string): string {
  return `<script src="./__loader.js" data-bundle-src="${escapeHtml(bundleSrc)}"></script>`;
}

function panelPreloadLinks(bundleSrc: string): string {
  return [
    '<link rel="preload" href="./__transport.js" as="script" />',
    `<link rel="modulepreload" href="${escapeHtml(bundleSrc)}" />`,
  ].join("\n  ");
}

function isPanelEntryJsOutput(outputPath: string): boolean {
  return /^bundle(?:-[^.]+)?\.js$/i.test(path.basename(outputPath));
}

function isPanelEntryCssOutput(outputPath: string): boolean {
  return /^bundle(?:-[^.]+)?\.css$/i.test(path.basename(outputPath));
}

function relativeBuildOutputPath(outdir: string, outputPath: string): string {
  return path.relative(outdir, path.resolve(outdir, outputPath)).replace(/\\/g, "/");
}

function relativeModuleSpecifier(fromDir: string, targetPath: string): string {
  const relative = path.relative(fromDir, targetPath).replace(/\\/g, "/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

/**
 * Inject standard transforms into a custom/template HTML file:
 * importmap, CSP, base href, bundle.js → __loader.js replacement.
 */
export function injectHtmlTransforms(
  html: string,
  baseHref: string | null,
  hasCss: boolean,
  externals?: Record<string, string>,
  title?: string,
  usePanelLoader = true,
  assetPaths: {
    bundleSrc?: string;
    cssHref?: string;
    sharedStyleHrefs?: readonly string[];
    iconHref?: string;
  } = {}
): string {
  let result = html;
  const bundleSrc = assetPaths.bundleSrc ?? "./bundle.js";
  const cssHref = assetPaths.cssHref ?? "./bundle.css";
  if (title !== undefined) {
    const titleElement = `<title>${escapeHtml(title)}</title>`;
    if (/<title\b[^>]*>[\s\S]*?<\/title>/i.test(result)) {
      result = result.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, titleElement);
    } else if (/<head\b[^>]*>/i.test(result)) {
      result = result.replace(/(<head\b[^>]*>)/i, `$1\n  ${titleElement}`);
    } else {
      result = `${titleElement}\n${result}`;
    }
  }
  if (
    externals &&
    Object.keys(externals).length > 0 &&
    !/<script[^>]+type\s*=\s*["']importmap["']/i.test(result)
  ) {
    const importMapScript = `<script type="importmap">${JSON.stringify({ imports: externals })}</script>`;
    if (/<head\b[^>]*>/i.test(result)) {
      result = result.replace(/(<head\b[^>]*>)/i, `$1\n  ${importMapScript}`);
    } else {
      result = `${importMapScript}\n${result}`;
    }
  }
  // Inject CSP if not present
  if (!/<meta[^>]+http-equiv\s*=\s*["']Content-Security-Policy["']/i.test(result)) {
    result = result.replace(/(<head\b[^>]*>)/i, `$1\n  ${PANEL_CSP_META}`);
  }
  // Panel builds may be served behind a workspace route prefix such as
  // /_workspace/dev. Keep the base relative so bundle/helper requests stay
  // under the selected workspace route instead of escaping to the hub root.
  const effectiveBaseHref = usePanelLoader && baseHref ? "./" : baseHref;
  // Inject base href if not present
  if (effectiveBaseHref && !/<base\b/i.test(result)) {
    result = result.replace(
      /(<head\b[^>]*>)/i,
      `$1\n  <base href="${escapeHtml(effectiveBaseHref)}">`
    );
  }
  if (assetPaths.iconHref && !/<link\b[^>]*\brel\s*=\s*["'][^"']*\bicon\b/iu.test(result)) {
    const iconLink = `<link rel="icon" href="${escapeHtml(assetPaths.iconHref)}" />`;
    result = /<\/head>/iu.test(result)
      ? result.replace(/<\/head>/iu, `  ${iconLink}\n</head>`)
      : `${iconLink}\n${result}`;
  }
  // Globally order-safe base styles must precede panel/component CSS so the
  // existing cascade remains intact.
  const sharedStyleLinks = (assetPaths.sharedStyleHrefs ?? [])
    .map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}" />`)
    .join("\n  ");
  if (hasCss || sharedStyleLinks) {
    const bundleCssLink =
      /(<link\b[^>]*\bhref\s*=\s*["'])(?:\.\/)?bundle\.css(?:\?[^"']*)?(["'][^>]*>)/i;
    if (hasCss && bundleCssLink.test(result)) {
      result = result.replace(
        bundleCssLink,
        `${sharedStyleLinks ? `${sharedStyleLinks}\n  ` : ""}$1${escapeHtml(cssHref)}$2`
      );
    } else {
      const links = [
        sharedStyleLinks,
        ...(hasCss ? [`<link rel="stylesheet" href="${escapeHtml(cssHref)}" />`] : []),
      ]
        .filter(Boolean)
        .join("\n  ");
      if (/<\/head>/i.test(result)) {
        result = result.replace(/<\/head>/i, `  ${links}\n</head>`);
      } else {
        result = `${links}\n${result}`;
      }
    }
  }
  const preloads = panelPreloadLinks(bundleSrc);
  if (usePanelLoader && !result.includes(preloads)) {
    if (/<\/head>/i.test(result)) {
      result = result.replace(/<\/head>/i, `  ${preloads}\n</head>`);
    } else {
      result = `${preloads}\n${result}`;
    }
  }
  const bundleScript =
    /<script\b[^>]*\bsrc\s*=\s*["'](?:\.\/)?bundle\.js(?:\?[^"']*)?["'][^>]*><\/script>/i;
  if (usePanelLoader) {
    // Replace bundle.js script with the panel identity/config loader.
    result = result.replace(bundleScript, panelLoaderScript(bundleSrc));
  } else if (bundleSrc !== "./bundle.js") {
    result = result.replace(
      bundleScript,
      `<script type="module" src="${escapeHtml(bundleSrc)}"></script>`
    );
  }
  return result;
}

function generatePanelHtml(
  title: string,
  templateHtmlPath: string | null,
  adapter: FrameworkAdapter,
  options: {
    hasCss: boolean;
    externals?: Record<string, string>;
    usePanelLoader?: boolean;
    bundleSrc?: string;
    cssHref?: string;
    sharedStyleHrefs?: readonly string[];
    iconHref?: string;
  }
): string {
  const usePanelLoader = options.usePanelLoader ?? true;
  const baseHref = usePanelLoader ? "./" : null;
  const bundleSrc = options.bundleSrc ?? "./bundle.js";
  const cssHref = options.cssHref ?? "./bundle.css";

  // If template or panel provides HTML, use it with standard injections
  if (templateHtmlPath && fs.existsSync(templateHtmlPath)) {
    const html = fs.readFileSync(templateHtmlPath, "utf-8");
    return injectHtmlTransforms(
      html,
      baseHref,
      options.hasCss,
      options.externals,
      title,
      usePanelLoader,
      {
        bundleSrc,
        cssHref,
        sharedStyleHrefs: options.sharedStyleHrefs,
        iconHref: options.iconHref,
      }
    );
  }

  // Adapter-generated fallback HTML
  const cssLink = [
    ...(options.sharedStyleHrefs ?? []).map(
      (href) => `<link rel="stylesheet" href="${escapeHtml(href)}" />`
    ),
    ...(options.hasCss ? [`<link rel="stylesheet" href="${escapeHtml(cssHref)}" />`] : []),
  ]
    .map((link) => `\n  ${link}`)
    .join("");
  const importMapScript =
    options.externals && Object.keys(options.externals).length > 0
      ? `<script type="importmap">${JSON.stringify({ imports: options.externals })}</script>\n  `
      : "";

  const cdnLinks = (adapter.cdnStylesheets ?? [])
    .map((url) => `<link rel="stylesheet" href="${escapeHtml(url)}">`)
    .join("\n  ");
  const additionalCss = adapter.additionalCss ?? "";
  const rootElement = adapter.rootElementHtml ?? '<div id="root"></div>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${baseHref ? `<base href="${escapeHtml(baseHref)}">` : ""}
  ${PANEL_CSP_META}
  <title>${escapeHtml(title)}</title>
  ${options.iconHref ? `<link rel="icon" href="${escapeHtml(options.iconHref)}" />` : ""}
  ${importMapScript}${cdnLinks}${cssLink}
  ${usePanelLoader ? panelPreloadLinks(bundleSrc) : ""}
  <style>
    html, body { margin: 0; padding: 0; height: 100%; }
    ${additionalCss}
  </style>
</head>
<body>
  ${rootElement}
  ${
    options.usePanelLoader === false
      ? `<script type="module" src="${escapeHtml(bundleSrc)}"></script>`
      : panelLoaderScript(bundleSrc)
  }
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Entry point wrappers
// ---------------------------------------------------------------------------

/**
 * Bootstrap target. Determines which globals are emitted:
 * - `"panel"` — full bootstrap including `__vibestudioRequireAsync__`, which uses
 *   browser-native `import(id)` to lazily load unbundled modules. Used by
 *   `compileComponent` (inline_ui / feedback_custom).
 * - `"worker"` — async loading is restricted to generated literal loaders.
 *   workerd cannot resolve arbitrary runtime `import(id)` specifiers, but the
 *   worker build preserves literal dynamic imports as sealed module chunks.
 */
export type BootstrapTarget = "panel" | "worker";

export function generateModuleMapBootstrap(
  target: BootstrapTarget = "panel",
  nativeImportSpecifiers: readonly string[] = []
): string {
  const base = `globalThis.__vibestudioModuleMap__ = globalThis.__vibestudioModuleMap__ || {};
globalThis.__vibestudioRequire__ = function(id) {
  const mod = globalThis.__vibestudioModuleMap__[id];
  if (mod) return mod;
  throw new Error('Module "' + id + '" not available. Workspace packages (@workspace/*, @vibestudio/*) are auto-resolved. For npm packages, use imports: { "' + id + '": "npm:latest" }');
};`;

  if (target === "worker") {
    return `${base}
globalThis.__vibestudioModuleLoaders__ = globalThis.__vibestudioModuleLoaders__ || {};
globalThis.__vibestudioModuleLoadingPromises__ = globalThis.__vibestudioModuleLoadingPromises__ || {};
globalThis.__vibestudioRequireAsync__ = async function(id) {
  if (globalThis.__vibestudioModuleMap__[id]) return globalThis.__vibestudioModuleMap__[id];
  if (globalThis.__vibestudioModuleLoadingPromises__[id]) return globalThis.__vibestudioModuleLoadingPromises__[id];
  const loader = globalThis.__vibestudioModuleLoaders__[id];
  if (!loader) throw new Error('Module "' + id + '" has no generated worker loader');
  const loadPromise = loader().then((mod) => {
    globalThis.__vibestudioModuleMap__[id] = mod;
    return mod;
  }).finally(() => {
    delete globalThis.__vibestudioModuleLoadingPromises__[id];
  });
  globalThis.__vibestudioModuleLoadingPromises__[id] = loadPromise;
  return loadPromise;
};
globalThis.__vibestudioPreloadModules__ = function(ids) {
  return Promise.all(ids.map(function(id) {
    return globalThis.__vibestudioRequireAsync__(id);
  }));
};`;
  }

  return `${base}
globalThis.__vibestudioModuleLoaders__ = globalThis.__vibestudioModuleLoaders__ || {};
globalThis.__vibestudioModuleLoadingPromises__ = globalThis.__vibestudioModuleLoadingPromises__ || {};
globalThis.__vibestudioNativeImportSpecifiers__ = globalThis.__vibestudioNativeImportSpecifiers__ || new Set();
${nativeImportSpecifiers
  .map(
    (specifier) =>
      `globalThis.__vibestudioNativeImportSpecifiers__.add(${JSON.stringify(specifier)});`
  )
  .join("\n")}
globalThis.__vibestudioRequireAsync__ = async function(id) {
  if (globalThis.__vibestudioModuleMap__[id]) return globalThis.__vibestudioModuleMap__[id];
  if (globalThis.__vibestudioModuleLoadingPromises__[id]) return globalThis.__vibestudioModuleLoadingPromises__[id];
  const loader = globalThis.__vibestudioModuleLoaders__[id];
  const canImportNatively = globalThis.__vibestudioNativeImportSpecifiers__.has(id) ||
    /^(?:https?:|data:|blob:|\\/|\\.{1,2}\\/)/.test(id);
  if (!loader && !canImportNatively) {
    throw new Error('Module "' + id + '" has no generated loader or import-map external');
  }
  const loadPromise = (loader ? loader() : import(id)).then((mod) => {
    globalThis.__vibestudioModuleMap__[id] = mod;
    return mod;
  }).finally(() => {
    delete globalThis.__vibestudioModuleLoadingPromises__[id];
  });
  globalThis.__vibestudioModuleLoadingPromises__[id] = loadPromise;
  return loadPromise;
};
globalThis.__vibestudioPreloadModules__ = function(ids) {
  return Promise.all(ids.map(function(id) {
    return globalThis.__vibestudioRequireAsync__(id);
  }));
};`;
}

export function generateExposeModuleCode(
  exposeModules: string[],
  target: BootstrapTarget = "panel",
  nativeImportSpecifiers: readonly string[] = []
): string {
  let effectiveExposeModules = exposeModules;
  if (target === "worker" && exposeModules.includes(RUNTIME_MODULE)) {
    effectiveExposeModules = [...exposeModules];
    for (const specifier of WORKER_RUNTIME_COMPANION_MODULES) {
      if (!effectiveExposeModules.includes(specifier)) {
        effectiveExposeModules.push(specifier);
      }
    }
  }
  if (target === "panel") {
    const loaderLines: string[] = [];
    for (const [index, dep] of effectiveExposeModules.entries()) {
      if (dep === RUNTIME_MODULE) continue;
      const entrySpecifier = panelExposeEntrySpecifier(index);
      loaderLines.push(
        `globalThis.__vibestudioModuleLoaders__[${JSON.stringify(dep)}] = function() {
  return import(${JSON.stringify(entrySpecifier)}).then(function(entry) {
    var mod = entry.default;
    globalThis.__vibestudioModuleMap__[${JSON.stringify(dep)}] = mod;
    return mod;
  });
};`
      );
    }

    if (effectiveExposeModules.includes(RUNTIME_MODULE)) {
      const runtimeIndex = effectiveExposeModules.indexOf(RUNTIME_MODULE);
      const runtimeEntrySpecifier = panelExposeEntrySpecifier(runtimeIndex);
      loaderLines.push(`var __vibestudioRuntimeLoadPromise__;
function __vibestudioLoadRuntime__() {
  if (__vibestudioRuntimeLoadPromise__) return __vibestudioRuntimeLoadPromise__;
  __vibestudioRuntimeLoadPromise__ = import(${JSON.stringify(runtimeEntrySpecifier)}).then(function(entry) {
    var mod = entry.default;
    var map = globalThis.__vibestudioModuleMap__;
    map[${JSON.stringify(RUNTIME_MODULE)}] = mod;
    var _fs = mod["fs"];
    if (_fs) {
      var fsShim = { promises: _fs, default: null, constants: {} };
      var methods = ["readFile","writeFile","readdir","stat","lstat","mkdir","rmdir","unlink","rename","copyFile","access","rm","symlink","readlink","realpath","appendFile","chmod","truncate","utimes","open"];
      methods.forEach(function(method) {
        if (_fs[method]) fsShim[method] = function() { return _fs[method].apply(_fs, arguments); };
      });
      fsShim.default = fsShim;
      map["fs"] = fsShim; map["node:fs"] = fsShim;
      map["fs/promises"] = _fs; map["node:fs/promises"] = _fs;
    }
    return mod;
  }).catch(function(error) {
    __vibestudioRuntimeLoadPromise__ = undefined;
    throw error;
  });
  return __vibestudioRuntimeLoadPromise__;
}
function __vibestudioLoadRuntimeAlias__(id) {
  return __vibestudioLoadRuntime__().then(function() {
    return globalThis.__vibestudioModuleMap__[id];
  });
}
globalThis.__vibestudioModuleLoaders__[${JSON.stringify(RUNTIME_MODULE)}] = __vibestudioLoadRuntime__;
globalThis.__vibestudioModuleLoaders__["fs"] = function() { return __vibestudioLoadRuntimeAlias__("fs"); };
globalThis.__vibestudioModuleLoaders__["node:fs"] = function() { return __vibestudioLoadRuntimeAlias__("node:fs"); };
globalThis.__vibestudioModuleLoaders__["fs/promises"] = function() { return __vibestudioLoadRuntimeAlias__("fs/promises"); };
globalThis.__vibestudioModuleLoaders__["node:fs/promises"] = function() { return __vibestudioLoadRuntimeAlias__("node:fs/promises"); };`);
    }

    return `${generateModuleMapBootstrap(target, nativeImportSpecifiers)}
${loaderLines.join("\n")}
`;
  }

  const loaderLines = effectiveExposeModules.flatMap((dep) => {
    if (dep === RUNTIME_MODULE) return [];
    return [
      `globalThis.__vibestudioModuleLoaders__[${JSON.stringify(dep)}] = function() { return import(${JSON.stringify(dep)}); };`,
    ];
  });

  // Register Node built-in shims when the runtime SDK is first requested.
  // The aliases share the runtime's single-flight loader.
  const runtimeIndex = effectiveExposeModules.indexOf(RUNTIME_MODULE);
  if (runtimeIndex >= 0) {
    loaderLines.push(`var __vibestudioRuntimeLoadPromise__;
function __vibestudioLoadRuntime__() {
  if (__vibestudioRuntimeLoadPromise__) return __vibestudioRuntimeLoadPromise__;
  __vibestudioRuntimeLoadPromise__ = import(${JSON.stringify(RUNTIME_MODULE)}).then(function(mod) {
  var map = globalThis.__vibestudioModuleMap__;
  map[${JSON.stringify(RUNTIME_MODULE)}] = mod;
  var _fs = mod["fs"];
  if (!_fs) return mod;
  var fsShim = { promises: _fs, default: null, constants: {} };
  var methods = ["readFile","writeFile","readdir","stat","lstat","mkdir","rmdir","unlink","rename","copyFile","access","rm","symlink","readlink","realpath","appendFile","chmod","truncate","utimes","open"];
  methods.forEach(function(m) { if (_fs[m]) fsShim[m] = function() { return _fs[m].apply(_fs, arguments); }; });
  fsShim.default = fsShim;
  map["fs"] = fsShim; map["node:fs"] = fsShim;
  map["fs/promises"] = _fs; map["node:fs/promises"] = _fs;
  return mod;
  }).catch(function(error) {
    __vibestudioRuntimeLoadPromise__ = undefined;
    throw error;
  });
  return __vibestudioRuntimeLoadPromise__;
}
function __vibestudioLoadRuntimeAlias__(id) {
  return __vibestudioLoadRuntime__().then(function() {
    return globalThis.__vibestudioModuleMap__[id];
  });
}
globalThis.__vibestudioModuleLoaders__[${JSON.stringify(RUNTIME_MODULE)}] = __vibestudioLoadRuntime__;
globalThis.__vibestudioModuleLoaders__["fs"] = function() { return __vibestudioLoadRuntimeAlias__("fs"); };
globalThis.__vibestudioModuleLoaders__["node:fs"] = function() { return __vibestudioLoadRuntimeAlias__("node:fs"); };
globalThis.__vibestudioModuleLoaders__["fs/promises"] = function() { return __vibestudioLoadRuntimeAlias__("fs/promises"); };
globalThis.__vibestudioModuleLoaders__["node:fs/promises"] = function() { return __vibestudioLoadRuntimeAlias__("node:fs/promises"); };`);
  }

  return `${generateModuleMapBootstrap(target)}
${loaderLines.join("\n")}
`;
}

function panelExposeEntryFilename(index: number): string {
  return `_expose_module_${index}.js`;
}

function panelExposeEntrySpecifier(index: number): string {
  return `./${panelExposeEntryFilename(index)}`;
}

export function generatePanelExposeEntryCode(specifier: string): string {
  return `import * as namespace from ${JSON.stringify(specifier)};
export default namespace;
`;
}

/**
 * Read the optional `vibestudio.frameworkModule` manifest override: the workspace
 * module the generated panel entry imports the framework auto-mount contract
 * from, instead of the platform default (platformModules.FRAMEWORK_MODULES).
 * Must be a bare specifier; anything else is ignored.
 */
function manifestFrameworkModule(manifest: Record<string, unknown>): string | undefined {
  const raw = manifest["frameworkModule"];
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return value && isBareSpecifier(value) ? value : undefined;
}

/**
 * Generate a worker entry wrapper.
 *
 * Workers run in workerd as ES modules: workerd reads `default` for the fetch
 * handler and named exports for Durable Object classes. The wrapper imports
 * the expose file (so __vibestudioRequire__/__vibestudioModuleMap__ are populated
 * before any user code runs) and then re-exports everything from the user
 * entry to preserve the workerd module shape.
 *
 * `export *` covers named exports (including DO classes). A namespace import
 * lets us forward the default fetch handler when present without making it a
 * hard requirement for DO-only modules.
 */
export function generateWorkerEntry(exposeEntryFile: string, entryFile: string): string {
  return `import ${JSON.stringify(exposeEntryFile)};
import * as __vibestudioWorkerEntry from ${JSON.stringify(entryFile)};
export * from ${JSON.stringify(entryFile)};
const __vibestudioDefaultExport = Object.prototype.hasOwnProperty.call(__vibestudioWorkerEntry, "default")
  ? Reflect.get(__vibestudioWorkerEntry, "default")
  : { fetch() { return new Response("Vibestudio worker module has no default fetch handler."); } };
export default __vibestudioDefaultExport;
`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuildOptions {
  sourcemap: boolean;
}

export interface BuildUnitOptions {
  /** Build as a CJS library bundle instead of a standalone app */
  library?: boolean;
  /** Externals for library builds — specifiers to emit as require() calls */
  externals?: string[];
  /** Package export subpath to use as the library entry point. */
  libraryEntrySubpath?: string;
  /**
   * Which execution target will run this library bundle — selects the module
   * resolution conditions (see `conditionsForLibraryTarget`). Defaults to
   * `panel`; eval imports pass `eval` so workspace packages resolve their
   * worker/workerd entry instead of a panel entry that bootstraps on load.
   */
  libraryTarget?: LibraryBuildTarget;
}

export function effectiveBuildVersion(
  node: GraphNode,
  ev: string,
  options?: BuildUnitOptions
): string {
  if (options?.library) {
    return `${ev}:lib:${createHash("sha256")
      .update(
        JSON.stringify({
          externals: options.externals ?? [],
          entry: options.libraryEntrySubpath ?? ".",
          // Distinct conditions ⇒ distinct bundle: a panel-target and a
          // worker-target build of the same package must NOT share a cache key.
          target: options.libraryTarget ?? null,
        })
      )
      .digest("hex")
      .slice(0, 12)}`;
  }
  if (node.kind === "extension") {
    return `${ev}:extension-runtime-abi:${EXTENSION_RUNTIME_ABI_VERSION}`;
  }
  return ev;
}

export function buildSourcemapForNode(node: GraphNode, options?: BuildUnitOptions): boolean {
  return options?.library
    ? false
    : node.kind === "extension"
      ? true
      : node.manifest.sourcemap !== false;
}

export function computeBuildUnitKey(
  node: GraphNode,
  ev: string,
  options?: BuildUnitOptions
): string {
  return computeBuildKey(
    node.name,
    effectiveBuildVersion(node, ev, options),
    buildSourcemapForNode(node, options)
  );
}

/**
 * Build a single unit (panel, about page, worker, or library).
 * Returns a BuildResult from the content-addressed store.
 *
 * @param stateRef - Immutable source coordinate (a workspace state or leased
 *   repository-set build view) the build's sources are materialized from — the
 *   same coordinate from which EVs were derived.
 * @param options - Optional build options (library mode, externals).
 */
export async function buildUnit(
  node: GraphNode,
  ev: string,
  graph: PackageGraph,
  workspaceRoot: string,
  stateRef: string,
  options?: BuildUnitOptions
): Promise<BuildResult> {
  const sourcemap = buildSourcemapForNode(node, options);
  const buildKey = computeBuildUnitKey(node, ev, options);

  // Check store first
  let cached = buildStore.get(buildKey);
  if (cached && cached.sourceStateHash !== stateRef && cached.sourceStateHash !== null) {
    cached = await buildStore.rebindSourceState(cached, stateRef);
  }
  if (cached) {
    if (node.kind === "extension") {
      await refreshCachedExtensionRuntimeDeps(cached);
    }
    return cached;
  }

  // Check for in-flight build (coalescing)
  const inFlight = inFlightBuilds.get(buildKey);
  if (inFlight) return inFlight;

  const buildPromise = doBuild(
    node,
    ev,
    buildKey,
    graph,
    workspaceRoot,
    sourcemap,
    stateRef,
    options
  );
  inFlightBuilds.set(buildKey, buildPromise);

  try {
    return await buildPromise;
  } finally {
    inFlightBuilds.delete(buildKey);
  }
}

const EMPTY_UNIT_AUTHORITY: UnitAuthorityManifest = Object.freeze({
  requests: Object.freeze([]),
  provides: Object.freeze([]),
});

/**
 * Seal the authority declaration from the same immutable source tree that is
 * compiled. Missing declarations are the fail-closed empty envelope.
 */
function authorityFromMaterializedSource(
  node: GraphNode,
  sourceRoot: string
): UnitAuthorityManifest {
  const packageJsonPath = path.join(sourceRoot, node.relativePath, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    vibestudio?: { authority?: unknown };
  };
  const authority = packageJson.vibestudio?.authority;
  return authority === undefined
    ? EMPTY_UNIT_AUTHORITY
    : parseUnitAuthorityManifest(authority, `${node.name} vibestudio.authority`);
}

async function doBuild(
  node: GraphNode,
  ev: string,
  buildKey: string,
  graph: PackageGraph,
  workspaceRoot: string,
  sourcemap: boolean,
  stateRef: string,
  options?: BuildUnitOptions
): Promise<BuildResult> {
  await acquireSemaphore();

  try {
    // Materialize sources for the unit + its transitive internal deps at the
    // immutable workspace state. The provider caches per-state checkouts; no
    // per-build temp dir, no cleanup.
    const extracted = await getBuildSourceProvider().materializeForBuild(
      collectTransitiveInternalDeps(node, graph),
      stateRef,
      workspaceRoot
    );
    const authority = authorityFromMaterializedSource(node, extracted.sourceRoot);

    if (options?.library) {
      if (!options.libraryTarget) {
        throw new Error(
          `library build for ${node.name} requires an explicit libraryTarget ('panel' or 'worker')`
        );
      }
      return await buildLibraryBundle(
        node,
        ev,
        buildKey,
        graph,
        workspaceRoot,
        extracted.sourceRoot,
        stateRef,
        options.libraryTarget === "worker"
          ? [...new Set([...(options.externals ?? []), "node:async_hooks"])]
          : (options.externals ?? []),
        options.libraryEntrySubpath ?? ".",
        conditionsForLibraryTarget(options.libraryTarget),
        authority,
        options.libraryTarget
      );
    } else if (node.kind === "worker") {
      return await buildWorker(
        node,
        ev,
        buildKey,
        graph,
        workspaceRoot,
        sourcemap,
        extracted.sourceRoot,
        stateRef,
        authority
      );
    } else if (node.kind === "extension") {
      return await buildExtension(
        node,
        ev,
        buildKey,
        graph,
        workspaceRoot,
        extracted.sourceRoot,
        stateRef,
        authority
      );
    } else if (node.kind === "app") {
      return await buildApp(
        node,
        ev,
        buildKey,
        graph,
        workspaceRoot,
        sourcemap,
        extracted.sourceRoot,
        stateRef,
        authority
      );
    } else if (node.kind === "template") {
      throw new Error(`Templates are not buildable: ${node.name}`);
    } else if (node.kind === "package") {
      // Packages have no standalone runtime artifact. They can be built
      // explicitly as library bundles for panel/worker targets, but never as a
      // panel. Falling through to buildPanel would produce a bogus artifact.
      throw new Error(
        `package ${node.name} cannot be built as a runtime unit; build it as a library (options.library + libraryTarget)`
      );
    } else {
      return await buildPanel(
        node,
        ev,
        buildKey,
        graph,
        workspaceRoot,
        sourcemap,
        extracted.sourceRoot,
        stateRef,
        authority
      );
    }
  } finally {
    releaseSemaphore();
  }
}

// ---------------------------------------------------------------------------
// Shared Build Environment
// ---------------------------------------------------------------------------

interface BuildEnv {
  outdir: string;
  sourcePath: string;
  nodePaths: string[];
  nodeModulesDir: string | null;
  externalDeps: Record<string, string>;
  /** Closure externals the composing realm provides; never bundled into this unit. */
  providedPeers: Record<string, string>;
  /** Provided peers no closure member requires an instance of. */
  optionalProvidedPeers: string[];
  /** Which closure members declared each provided peer. */
  peerOwners: Record<string, string[]>;
  /** Peers owned at a version their declared range does not admit. */
  peerConflicts: string[];
  dependencyOverrides: Record<string, string>;
  dependencyPatches: ExternalDependencyPatch[];
  resolveDir: string;
  cleanup: () => void;
}

/**
 * How the artifact under construction is composed, which decides who satisfies
 * the closure's peers.
 *
 * A `runtime-root` (panel, app, worker, extension) is loaded on its own, so
 * nothing exists above it to provide anything: every peer in its closure must
 * be owned by one of its own dependencies. A `library` (package, skill) is
 * always loaded *into* a realm, so its unsatisfied peers stay external and
 * resolve to that realm's live instances.
 */
type BuildComposition = "runtime-root" | "library";

/**
 * Prepare the common build environment shared by panel and worker builds.
 * Creates the temp output dir, collects external deps, and assembles nodePaths.
 * Entry resolution belongs to the concrete build operation: library builds may
 * target a package subpath, and preparing their environment must not require an
 * unrelated default export.
 */
async function prepareBuildEnv(
  node: GraphNode,
  buildKey: string,
  graph: PackageGraph,
  workspaceRoot: string,
  sourceRoot: string,
  composition: BuildComposition
): Promise<BuildEnv> {
  const outdir = createBuildScratchDir(`build-${buildKey}`);

  const sourcePath = sourcePathForNode(node, sourceRoot);

  const dependencyEnvironment = await prepareExternalDependencyEnvironment(
    node,
    graph,
    workspaceRoot,
    sourceRoot,
    _appRoot,
    _appNodeModules
  );
  const {
    externalDeps,
    providedPeers,
    optionalProvidedPeers,
    peerOwners,
    peerConflicts,
    dependencyOverrides,
    dependencyPatches,
    nodeModulesDir,
    nodePaths,
  } = dependencyEnvironment;

  if (peerConflicts.length > 0) {
    dependencyEnvironment.release();
    fs.rmSync(outdir, { recursive: true, force: true });
    throw new Error(
      `${node.name} resolves a dependency its own closure rejects: ${peerConflicts.join("; ")}.`
    );
  }

  const unownedPeers = Object.entries(providedPeers).filter(
    ([name]) => !optionalProvidedPeers.includes(name)
  );
  if (composition === "runtime-root" && unownedPeers.length > 0) {
    dependencyEnvironment.release();
    fs.rmSync(outdir, { recursive: true, force: true });
    const unmet = unownedPeers
      .map(([name, range]) => {
        const owners = peerOwners[name] ?? [];
        return `${name}@${range}${owners.length > 0 ? ` (required by ${owners.join(", ")})` : ""}`;
      })
      .sort();
    throw new Error(
      `${node.name} is loaded on its own, so nothing provides its closure's peers: ${unmet.join("; ")}. ` +
        `Declare each as a dependency of ${node.name} at the version it should own.`
    );
  }

  try {
    const resolveDir = pickResolveDir(nodePaths, workspaceRoot);
    return {
      outdir,
      sourcePath,
      nodePaths,
      nodeModulesDir,
      externalDeps,
      providedPeers,
      optionalProvidedPeers,
      peerOwners,
      peerConflicts,
      dependencyOverrides,
      dependencyPatches,
      resolveDir,
      cleanup: () => {
        dependencyEnvironment.release();
        try {
          fs.rmSync(outdir, { recursive: true, force: true });
        } catch {
          // Ignore
        }
      },
    };
  } catch (error) {
    dependencyEnvironment.release();
    fs.rmSync(outdir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Store a simple bundle-only build result (used by worker builds).
 */
async function storeSimpleBuild(
  buildKey: string,
  bundle: string,
  node: GraphNode,
  ev: string,
  sourcemap: boolean,
  sourceStateHash: string | null,
  authority: UnitAuthorityManifest,
  extraMetadata: Partial<BuildMetadata> = {},
  artifacts: BuildArtifacts = bundleArtifacts(bundle)
): Promise<BuildResult> {
  const metadata: BuildMetadata = {
    kind: node.kind as BuildMetadata["kind"],
    name: node.name,
    buildKey,
    sourcePath: sourceStateHash === null ? null : node.relativePath,
    ev,
    sourceStateHash,
    sourcemap,
    authority,
    details: { kind: "generic" },
    ...extraMetadata,
    builtAt: new Date().toISOString(),
  };
  return buildStore.put(buildKey, artifacts, metadata);
}

function bundleArtifacts(bundle: string): BuildArtifacts {
  return {
    entries: [
      {
        path: "bundle.js",
        role: "primary",
        contentType: "text/javascript; charset=utf-8",
        encoding: "utf8",
        content: bundle,
      },
    ],
  };
}

/**
 * Materialize a manifest image icon into the immutable build. Emoji icons have
 * no artifact; they remain presentation metadata. A missing or oversized image
 * is a broken unit declaration, so fail the build instead of silently showing a
 * different icon at different surfaces.
 */
function manifestIconArtifact(
  manifest: Record<string, unknown>,
  sourcePath: string
): BuildArtifactInput | null {
  const artifactPath = declaredUnitIconPath(manifest);
  if (!artifactPath) return null;
  const icon = assertPresent(manifest["icon"] as string | undefined);
  const sourceRoot = path.resolve(sourcePath);
  const iconPath = path.resolve(sourceRoot, artifactPath);
  if (!iconPath.startsWith(`${sourceRoot}${path.sep}`)) {
    throw new Error(`vibestudio.icon escapes the unit source: ${icon}`);
  }
  const stat = fs.statSync(iconPath);
  if (!stat.isFile()) throw new Error(`vibestudio.icon is not a file: ${icon}`);
  assertUnitIconSize(icon, stat.size);

  const bytes = fs.readFileSync(iconPath);
  const isSvg = path.extname(iconPath).toLowerCase() === ".svg";
  return {
    path: artifactPath,
    role: "asset",
    contentType: contentTypeForPath(artifactPath),
    encoding: isSvg ? "utf8" : "base64",
    content: isSvg ? bytes.toString("utf8") : bytes.toString("base64"),
  };
}

function manifestIconHref(
  manifest: Record<string, unknown>,
  artifact: BuildArtifactInput | null
): string | undefined {
  if (artifact) return relativeAssetHref(artifact.path);
  const icon = manifest["icon"];
  if (typeof icon !== "string" || !icon || icon.startsWith("./")) return undefined;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text x="32" y="50" font-size="52" text-anchor="middle">${escapeHtml(icon)}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function workerBundleArtifacts(
  outdir: string,
  outputFiles: readonly esbuild.OutputFile[]
): BuildArtifacts {
  const entries = outputFiles
    .map((file): BuildArtifactInput => {
      const artifactPath = path.relative(outdir, file.path).replaceAll(path.sep, "/");
      const primary = artifactPath === "bundle.js";
      return {
        path: artifactPath,
        role: primary ? "primary" : artifactPath.endsWith(".map") ? "map" : "asset",
        contentType: artifactPath.endsWith(".map")
          ? "application/json; charset=utf-8"
          : "text/javascript; charset=utf-8",
        encoding: "utf8",
        content: file.text,
      };
    })
    .sort((left, right) => {
      if (left.role === "primary") return -1;
      if (right.role === "primary") return 1;
      return left.path.localeCompare(right.path);
    });
  if (!entries.some((entry) => entry.role === "primary")) {
    throw new Error("Worker build did not emit bundle.js");
  }
  return { entries };
}

// ---------------------------------------------------------------------------
// Panel / About Build
// ---------------------------------------------------------------------------

function executableModulesFromMetafile(
  metafile: esbuild.Metafile | undefined,
  outdir: string,
  sourceRoot: string,
  node: GraphNode,
  graph: PackageGraph
): import("./buildStore.js").ExecutableModuleInput[] {
  if (!metafile) return [];
  const modules: import("./buildStore.js").ExecutableModuleInput[] = [];
  const unitRoots = graph.allNodes().map((candidate) => ({
    candidate,
    root: `${path.resolve(sourceRoot, candidate.relativePath)}${path.sep}`,
  }));
  const firstPartyRoot = `${path.resolve(sourceRoot, node.relativePath)}${path.sep}`;
  const packageRootFor = (fileName: string): { name: string; root: string } | null => {
    const marker = `${path.sep}node_modules${path.sep}`;
    const markerIndex = fileName.lastIndexOf(marker);
    if (markerIndex < 0) return null;
    const rest = fileName.slice(markerIndex + marker.length);
    const parts = rest.split(path.sep);
    const name = parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1] ?? ""}` : (parts[0] ?? "");
    if (!name) return null;
    return {
      name,
      root: path.join(fileName.slice(0, markerIndex + marker.length), ...name.split("/")),
    };
  };
  const formatFor = (
    fileName: string
  ): import("./buildStore.js").ExecutableModuleInput["format"] | null => {
    switch (path.extname(fileName).toLowerCase()) {
      case ".ts":
        return "ts";
      case ".tsx":
        return "tsx";
      case ".js":
        return "js";
      case ".jsx":
        return "jsx";
      case ".mjs":
        return "mjs";
      case ".cjs":
        return "cjs";
      default:
        return null;
    }
  };
  for (const inputPath of Object.keys(metafile.inputs).sort()) {
    const fileName = path.resolve(outdir, inputPath);
    if (fileName.startsWith(`${path.resolve(outdir)}${path.sep}`)) continue;
    const format = formatFor(fileName);
    if (!format || !fs.existsSync(fileName)) continue;
    const source = fs.readFileSync(fileName, "utf8");
    const contentDigest = createHash("sha256").update(source, "utf8").digest("hex");
    const unit = unitRoots
      .filter(({ root }) => fileName.startsWith(root))
      .sort((left, right) => right.root.length - left.root.length)[0]?.candidate;
    if (fileName.startsWith(firstPartyRoot)) {
      modules.push({
        moduleId: path.relative(sourceRoot, fileName).replace(/\\/gu, "/"),
        contentDigest,
        package: { kind: "first-party" },
        format,
        source,
      });
      continue;
    }
    if (unit) {
      const packageName = unit.name;
      modules.push({
        moduleId: path.relative(sourceRoot, fileName).replace(/\\/gu, "/"),
        contentDigest,
        package: {
          kind: "workspace",
          name: packageName,
          effectiveVersion: "unknown",
        },
        format,
        source,
      });
      continue;
    }
    const externalPackage = packageRootFor(fileName);
    if (!externalPackage) continue;
    const packageJsonPath = path.join(externalPackage.root, "package.json");
    let version = "unknown";
    let packageDigest = "unknown";
    try {
      const packageJson = fs.readFileSync(packageJsonPath, "utf8");
      const parsed = JSON.parse(packageJson) as { version?: unknown };
      if (typeof parsed.version === "string") version = parsed.version;
      packageDigest = createHash("sha256").update(packageJson, "utf8").digest("hex");
    } catch {
      // A source input without its package manifest is not enough provenance
      // for dependency endowment routing; omit it and let the fold remain
      // conservative about the missing executable closure.
      continue;
    }
    modules.push({
      moduleId: `external:${externalPackage.name}/${path.relative(externalPackage.root, fileName).replace(/\\/gu, "/")}`,
      contentDigest,
      package: { kind: "external", name: externalPackage.name, version, packageDigest },
      format,
      source,
    });
  }
  return modules;
}

async function buildPanel(
  node: GraphNode,
  ev: string,
  buildKey: string,
  graph: PackageGraph,
  workspaceRoot: string,
  sourcemap: boolean,
  sourceRoot: string,
  sourceStateHash: string,
  authority: UnitAuthorityManifest
): Promise<BuildResult> {
  const env = await prepareBuildEnv(
    node,
    buildKey,
    graph,
    workspaceRoot,
    sourceRoot,
    "runtime-root"
  );
  const { outdir, nodePaths } = env;
  const entryFile = resolveEntryPoint(node, env.sourcePath, {
    conditions: PANEL_CONDITIONS,
  });

  // Read extracted manifest for ref-correct build decisions
  const panelSourcePath = path.join(sourceRoot, node.relativePath);
  const extractedPkgPath = path.join(panelSourcePath, "package.json");
  const pkg = JSON.parse(fs.readFileSync(extractedPkgPath, "utf-8"));
  const extractedManifest = pkg.vibestudio ?? {};
  const extractedDeps = { ...pkg.peerDependencies, ...pkg.dependencies };

  // Resolve framework and HTML template from materialized source
  const resolved = resolveTemplate(extractedManifest, extractedDeps, panelSourcePath, sourceRoot);
  const adapter = getAdapter(resolved.framework);

  const manifestExternals = extractedManifest.externals ?? {};
  const externalSpecifiers = expandExternalSpecifiers(manifestExternals);
  const exposeModules = normalizeManifestSpecList(extractedManifest.exposeModules);
  const dedupePackages = normalizeManifestSpecList([
    ...adapter.dedupePackages,
    ...(extractedManifest.dedupeModules ?? []),
  ]);
  const { resolveDir } = env;

  // Generate expose/wrapper entries.
  const exposePath = path.join(outdir, "_expose.js");
  for (const [index, specifier] of exposeModules.entries()) {
    fs.writeFileSync(
      path.join(outdir, panelExposeEntryFilename(index)),
      generatePanelExposeEntryCode(specifier)
    );
  }
  fs.writeFileSync(
    exposePath,
    generateExposeModuleCode(exposeModules, "panel", externalSpecifiers)
  );

  const wrapperCode = generatePanelEntry(
    exposePath,
    entryFile,
    adapter,
    manifestFrameworkModule(extractedManifest)
  );
  const wrapperPath = path.join(outdir, "_entry.js");
  fs.writeFileSync(wrapperPath, wrapperCode);

  const sharedStyles =
    node.kind === "app" ? [] : normalizeManifestSpecList([...(adapter.sharedStyles ?? [])]);
  const sharedStyleEntryPath =
    sharedStyles.length > 0 ? path.join(outdir, "_shared-styles.css") : null;
  if (sharedStyleEntryPath) {
    fs.writeFileSync(
      sharedStyleEntryPath,
      `${sharedStyles.map((specifier) => `@import ${JSON.stringify(specifier)};`).join("\n")}\n`
    );
  }

  // Exposed namespaces are literal dynamic imports in this same graph, so
  // esbuild keeps barrel-only code lazy while sharing React, runtime
  // initialization, and every other singleton with the panel entry.
  const entryPoints: Record<string, string> = {
    bundle: wrapperPath,
    ...(sharedStyleEntryPath ? { "shared-styles": sharedStyleEntryPath } : {}),
  };

  // Build plugins: resolve plugin uses materialized source paths.
  const plugins: esbuild.Plugin[] = [
    ...(sharedStyleEntryPath ? [createSharedStyleDedupePlugin(sharedStyles)] : []),
    ...(node.kind === "app" ? [createAppRuntimeShimPlugin()] : []),
    createWorkspaceResolvePlugin(graph, sourceRoot),
    createTsExtensionPlugin(sourceRoot),
    createFsShimPlugin({ runtimeBacked: node.kind !== "app", resolveDir }),
    createPathShimPlugin(resolveDir),
    createCryptoShimPlugin({ resolveDir }),
  ];
  const dedupePlugin = createDedupePlugin(resolveDir, dedupePackages);
  if (dedupePlugin) {
    plugins.push(dedupePlugin);
  }
  // Add framework-specific plugins (e.g., esbuild-svelte)
  if (adapter.plugins) {
    plugins.push(...(await adapter.plugins()));
  }

  // Build esbuild options with adapter-driven JSX settings
  const esbuildOptions: esbuild.BuildOptions = {
    entryPoints,
    // Make every metafile path relative to this build's owned directory. Asset
    // collection and executable-provenance capture must not depend on the
    // server process launch directory.
    absWorkingDir: outdir,
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "esm",
    splitting: true,
    // Panels are runtime artifacts, not source modules consumed by a dev
    // server. Shipping React's development branches and readable-but-much-
    // larger output makes every webview parse megabytes of diagnostics before
    // it can mount. Linked sourcemaps preserve debuggability without putting
    // that cost on the startup path.
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    minify: true,
    outdir,
    // Keep development maps available without putting them on the startup
    // path. Inline maps made every panel download and parse several megabytes
    // of debugger-only data before its first render; external maps are fetched
    // only when developer tooling asks for them.
    sourcemap: sourcemap ? "linked" : false,
    metafile: true,
    logLevel: "warning",
    conditions: [...PANEL_CONDITIONS],
    plugins,
    nodePaths,
    loader: PANEL_ASSET_LOADERS,
    assetNames: "assets/[name]-[hash]",
    entryNames: "[name]-[hash]",
    chunkNames: "chunk-[hash]",
    external: externalSpecifiers,
  };
  if (adapter.jsx) {
    esbuildOptions.jsx = adapter.jsx;
  }
  if (adapter.tsconfigJsx) {
    esbuildOptions.tsconfigRaw = { compilerOptions: { jsx: adapter.tsconfigJsx } };
  }

  try {
    const result = await esbuild.build(esbuildOptions);
    const metafile = result.metafile;

    if (isVerboseBuildLogEnabled() && metafile) {
      const outputs = Object.entries(metafile.outputs);
      const jsChunks = outputs
        .filter(
          ([outputPath, meta]) =>
            outputPath.endsWith(".js") && !meta.entryPoint && Object.keys(meta.inputs).length > 0
        )
        .map(([, meta]) => meta);
      const largestChunkBytes = jsChunks.reduce((max, meta) => Math.max(max, meta.bytes), 0);
      const mainBundleEntry = outputs.find(([outputPath]) => isPanelEntryJsOutput(outputPath));
      const mainBundleBytes = mainBundleEntry?.[1].bytes;
      const bundleSizeText = formatBytes(mainBundleBytes ?? 0);
      const largestChunkText = jsChunks.length > 0 ? formatBytes(largestChunkBytes) : "0B";

      console.log(
        `[BuildV2] ${node.name}: main=${bundleSizeText}, chunks=${jsChunks.length}, largestChunk=${largestChunkText}`
      );
    }

    // Read outputs
    const outputPaths = Object.keys(metafile?.outputs ?? {});
    const bundleOutputPath =
      outputPaths.find((outputPath) => isPanelEntryJsOutput(outputPath)) ??
      path.join(outdir, "bundle.js");
    const cssOutputPath = outputPaths.find((outputPath) => isPanelEntryCssOutput(outputPath));
    const sharedStyleOutputPath = sharedStyleEntryPath
      ? outputPaths.find(
          (outputPath) =>
            outputPath.endsWith(".css") &&
            path.resolve(outdir, metafile?.outputs[outputPath]?.entryPoint ?? "") ===
              path.resolve(sharedStyleEntryPath)
        )
      : undefined;
    const bundleArtifactPath = relativeBuildOutputPath(outdir, bundleOutputPath);
    const cssArtifactPath = cssOutputPath ? relativeBuildOutputPath(outdir, cssOutputPath) : null;
    const bundlePath = path.join(outdir, ...bundleArtifactPath.split("/"));
    const cssPath = cssArtifactPath ? path.join(outdir, ...cssArtifactPath.split("/")) : null;

    const bundle = fs.existsSync(bundlePath) ? fs.readFileSync(bundlePath, "utf-8") : "";
    const css = cssPath && fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf-8") : undefined;
    const rawBundleReport = metafile
      ? createPanelBundleReport(
          metafile,
          bundleOutputPath,
          cssOutputPath,
          sharedStyleOutputPath ? [sharedStyleOutputPath] : []
        )
      : undefined;
    const bundleReport = rawBundleReport
      ? {
          ...rawBundleReport,
          entryOutput: bundleArtifactPath,
          initialArtifacts: rawBundleReport.initialArtifacts.map((outputPath) =>
            relativeBuildOutputPath(outdir, outputPath)
          ),
        }
      : undefined;
    if (bundleReport && isVerboseBuildLogEnabled()) {
      console.log(`[BuildV2] ${node.name}: panel bundle report`, bundleReport);
    }

    const artifactEntries: BuildArtifactInput[] = [
      {
        path: bundleArtifactPath,
        role: "primary",
        contentType: "text/javascript; charset=utf-8",
        encoding: "utf8",
        content: bundle,
      },
    ];
    let sharedStyleMetadata: BuildMetadata["sharedStyles"];
    if (sharedStyleOutputPath) {
      const sharedStyleContent = fs.readFileSync(
        path.resolve(outdir, sharedStyleOutputPath),
        "utf8"
      );
      const digest = createHash("sha256").update(sharedStyleContent).digest("hex");
      const sharedStyleArtifactPath = `shared-style-${digest}.css`;
      // Keep the shared URL relative to the two-segment panel source. An
      // origin-absolute URL escapes routed workspaces (`/_workspace/:id/...`)
      // and reaches the hub namespace instead of this workspace's panel server.
      // Resolving ../../ from /panels/name/ yields the same workspace-local URL
      // for every panel, preserving cross-panel browser caching.
      const url = `../../__vibestudio/shared-style/${digest}.css`;
      artifactEntries.push({
        path: sharedStyleArtifactPath,
        role: "shared-style",
        contentType: "text/css; charset=utf-8",
        encoding: "utf8",
        content: sharedStyleContent,
      });
      sharedStyleMetadata = [
        {
          digest,
          contentType: "text/css; charset=utf-8",
          url,
        },
      ];
    }
    if (css) {
      artifactEntries.push({
        path: cssArtifactPath ?? "bundle.css",
        role: "css",
        contentType: "text/css; charset=utf-8",
        encoding: "utf8",
        content: css,
      });
    }

    // Collect assets (chunks, images, etc.)
    if (metafile) {
      for (const outputPath of Object.keys(metafile.outputs)) {
        const absPath = path.resolve(outdir, outputPath);

        // Skip main bundle and CSS
        const relativeName = path.relative(outdir, absPath).replace(/\\/g, "/");
        if (
          relativeName === bundleArtifactPath ||
          relativeName === cssArtifactPath ||
          outputPath === sharedStyleOutputPath
        )
          continue;
        if (!fs.existsSync(absPath)) continue;

        const ext = path.extname(absPath).toLowerCase();
        const isText = TEXT_EXTENSIONS.has(ext);

        artifactEntries.push({
          path: relativeName,
          role: ext === ".map" ? "map" : "asset",
          contentType: contentTypeForPath(relativeName),
          encoding: isText ? "utf8" : "base64",
          content: isText
            ? fs.readFileSync(absPath, "utf-8")
            : fs.readFileSync(absPath).toString("base64"),
        });
      }
    }

    const iconArtifact = manifestIconArtifact(extractedManifest, panelSourcePath);
    if (iconArtifact && !artifactEntries.some((entry) => entry.path === iconArtifact.path)) {
      artifactEntries.push(iconArtifact);
    }

    // Generate HTML using template or adapter fallback
    const title = extractedManifest.title ?? node.name;
    const html = generatePanelHtml(title, resolved.htmlPath, adapter, {
      hasCss: !!css,
      externals: manifestExternals,
      usePanelLoader: node.kind !== "app",
      bundleSrc: relativeAssetHref(bundleArtifactPath),
      cssHref: cssArtifactPath ? relativeAssetHref(cssArtifactPath) : undefined,
      sharedStyleHrefs: sharedStyleMetadata?.map((style) => style.url),
      iconHref: manifestIconHref(extractedManifest, iconArtifact),
    });

    artifactEntries.push({
      path: "index.html",
      role: "html",
      contentType: "text/html; charset=utf-8",
      encoding: "utf8",
      content: html,
    });

    const metadata: BuildMetadata = {
      kind: node.kind,
      name: node.name,
      buildKey,
      sourcePath: node.relativePath,
      ev,
      sourceStateHash,
      sourcemap,
      authority,
      executableModules: executableModulesFromMetafile(metafile, outdir, sourceRoot, node, graph),
      ...(node.kind === "panel" && extractedManifest.stateArgs
        ? { stateArgsSchema: extractedManifest.stateArgs }
        : {}),
      framework: resolved.framework,
      ...(bundleReport ? { bundleReport } : {}),
      ...(sharedStyleMetadata ? { sharedStyles: sharedStyleMetadata } : {}),
      details:
        node.kind === "app"
          ? {
              kind: "app",
              target: "electron",
              platform: "electron",
              integrity: null,
              rnHostAbi: null,
              provider: null,
            }
          : { kind: "generic" },
      builtAt: new Date().toISOString(),
    };

    return buildStore.put(buildKey, { entries: artifactEntries }, metadata);
  } finally {
    env.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Worker Build
// ---------------------------------------------------------------------------

const WORKER_CONDITIONS = ["worker", "workerd", "import", "default"] as const;
const EXTENSION_CONDITIONS = ["import", "default"] as const;

/**
 * Map a library bundle's execution target to esbuild/package-export resolution
 * conditions. This is what lets a workerd-hosted import (incl. the eval sandbox)
 * pick up a package's worker entry instead of its panel entry — the panel entry
 * of `@workspace/runtime` runs `initRuntime()` at module load, which throws
 * outside a panel. No default: the caller MUST state the host.
 */
function conditionsForLibraryTarget(target: LibraryBuildTarget): readonly string[] {
  switch (target) {
    case "worker":
      return WORKER_CONDITIONS;
    case "panel":
      return PANEL_CONDITIONS;
  }
}

/**
 * Node built-ins that workerd does NOT provide via `nodejs_compat` and must
 * be stubbed out of worker bundles. Registry dependencies can import these at
 * module scope even when the relevant optional path is never invoked. Stubbing
 * to a throwing module keeps such bundles loadable while making any actual use
 * fail clearly at runtime.
 */
const WORKERD_UNAVAILABLE_NODE_MODULES: ReadonlySet<string> = new Set([
  "child_process",
  "node:child_process",
  "worker_threads",
  "node:worker_threads",
  "node:sqlite",
  "node:wasi",
  "node:vm",
  "vm",
  "node:v8",
  "v8",
  "node:repl",
  "repl",
  "node:readline",
  "readline",
  "node:perf_hooks",
  "perf_hooks",
  "node:module",
  "module",
  "node:dns",
  "dns",
  "node:tls",
  "tls",
  "node:net",
  "net",
  "node:http2",
  "http2",
  "node:tty",
  "tty",
  "node:os",
  "os",
  "node:diagnostics_channel",
  "diagnostics_channel",
]);

/**
 * Plugin: intercept imports of Node built-ins that workerd's nodejs_compat
 * does not implement, and replace them with a throwing stub module. Keeps
 * the worker bundle valid without shipping unused (and unimplementable)
 * Node APIs.
 */
function createWorkerNodeStubPlugin(): esbuild.Plugin {
  return {
    name: "worker-node-stub",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (WORKERD_UNAVAILABLE_NODE_MODULES.has(args.path)) {
          return { path: args.path, namespace: "worker-node-stub" };
        }
        return undefined;
      });
      build.onLoad({ filter: /.*/, namespace: "worker-node-stub" }, (args) => {
        // Emit every named export an aws-sdk / proxy-agent / undici
        // transitive dep might reach for at module scope. Each export
        // is a throwing stub — if runtime actually hits one of these
        // the worker gets a clear error. The list only needs to cover
        // names referenced in ES `import { name } from` at bundle
        // time; additional names resolved through default/namespace
        // imports get picked up by the Proxy default export.
        const msg = `Node built-in "${args.path}" is not available in the workerd agent worker runtime`;
        const contents = `
const err = () => { throw new Error(${JSON.stringify(msg)}); };
const stubFn = new Proxy(function () { return err(); }, {
  get(_, prop) {
    if (prop === Symbol.toPrimitive || prop === "then") return undefined;
    if (prop === "default") return stubFn;
    return stubFn;
  },
  apply() { return err(); },
  construct() { return err(); },
});
export default stubFn;
export const promises = stubFn;
export const constants = {};
// os
export const homedir = () => "/";
export const platform = () => "linux";
export const release = () => "0.0.0";
export const arch = () => "x64";
export const type = () => "Linux";
export const hostname = () => "workerd";
export const tmpdir = () => "/tmp";
export const cpus = () => [];
export const totalmem = () => 0;
export const freemem = () => 0;
export const uptime = () => 0;
export const loadavg = () => [0, 0, 0];
export const networkInterfaces = () => ({});
export const userInfo = () => ({ username: "worker", homedir: "/", shell: null, uid: -1, gid: -1 });
export const EOL = "\\n";
// child_process
export const exec = stubFn;
export const execFile = stubFn;
export const execSync = stubFn;
export const execFileSync = stubFn;
export const spawn = stubFn;
export const spawnSync = stubFn;
export const fork = stubFn;
// worker_threads
export const Worker = class Worker { constructor() { err(); } };
export const parentPort = null;
export const workerData = null;
export const threadId = 0;
export const isMainThread = true;
export const MessageChannel = class MessageChannel { constructor() { err(); } };
export const MessagePort = class MessagePort { constructor() { err(); } };
export const BroadcastChannel = class BroadcastChannel { constructor() { err(); } };
// module
export const createRequire = () => stubFn;
export const builtinModules = [];
export const Module = class Module { constructor() { err(); } };
// tls / net / dns / http2
export const connect = stubFn;
export const createConnection = stubFn;
export const createServer = stubFn;
export const Socket = class Socket { constructor() { err(); } };
export const Server = class Server { constructor() { err(); } };
export const TLSSocket = class TLSSocket { constructor() { err(); } };
export const resolve = stubFn;
export const resolve4 = stubFn;
export const resolve6 = stubFn;
export const lookup = stubFn;
// diagnostics_channel
export const channel = () => ({ publish: () => {}, subscribe: () => {}, unsubscribe: () => {}, hasSubscribers: false });
export const hasSubscribers = () => false;
export const subscribe = () => {};
export const unsubscribe = () => {};
// async_hooks
export const AsyncLocalStorage = class AsyncLocalStorage { constructor() {} getStore() { return undefined; } run(_s, fn) { return fn(); } exit(fn) { return fn(); } disable() {} enable() {} enterWith() {} };
export const AsyncResource = class AsyncResource { constructor() {} runInAsyncScope(fn) { return fn(); } bind(fn) { return fn; } asyncId() { return 0; } triggerAsyncId() { return 0; } emitDestroy() { return this; } };
export const executionAsyncId = () => 0;
export const executionAsyncResource = () => ({});
export const triggerAsyncId = () => 0;
export const createHook = () => ({ enable: () => {}, disable: () => {} });
// perf_hooks
export const performance = { now: () => Date.now() };
export const PerformanceObserver = class PerformanceObserver { constructor() {} observe() {} disconnect() {} };
// v8
export const getHeapStatistics = () => ({});
export const getHeapSpaceStatistics = () => [];
// vm
export const runInNewContext = stubFn;
export const runInThisContext = stubFn;
export const createContext = stubFn;
// readline
export const createInterface = stubFn;
`;
        return { contents, loader: "js" };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Terminal-worker (Ink) build support
// ---------------------------------------------------------------------------

interface YogaPaths {
  wasmEsm: string;
  wrapAssembly: string;
  enums: string;
}

/**
 * Locate yoga-layout's internal files from the worker's resolve dir. yoga's
 * `exports` map blocks deep imports, so we resolve the package main and derive
 * the sibling paths (`<root>/dist/src/index.js` → `<root>/dist/...`).
 */
function resolveYogaPaths(resolveDir: string): YogaPaths {
  const req = createRequire(path.join(resolveDir, "__terminal_resolve__.js"));
  const main = req.resolve("yoga-layout"); // <root>/dist/src/index.js
  const root = path.resolve(path.dirname(main), "../..");
  return {
    wasmEsm: path.join(root, "dist", "binaries", "yoga-wasm-base64-esm.js"),
    wrapAssembly: path.join(root, "dist", "src", "wrapAssembly.js"),
    enums: path.join(root, "dist", "src", "generated", "YGEnums.js"),
  };
}

/**
 * Build plugin for Ink terminal workers. Routes Ink's `import Yoga from
 * 'yoga-layout'` to the terminal-shim sync loader, resolves that loader's deep
 * yoga imports (which yoga's exports map blocks), shims the two npm packages
 * that break in workerd, and marks `yoga.wasm` external (workerd supplies it as
 * a module binding). Register BEFORE the workspace plugin so these intercepts win.
 */
function createTerminalWorkerAliasPlugin(resolveDir: string): esbuild.Plugin {
  const yoga = resolveYogaPaths(resolveDir);
  return {
    name: "terminal-worker-alias",
    setup(build) {
      // Ink's `yoga-layout` default import → the terminal-shim sync loader.
      build.onResolve({ filter: /^yoga-layout$/ }, async (args) => {
        const r = await build.resolve(TERMINAL_SHIM_YOGA, {
          kind: args.kind,
          resolveDir,
        });
        if (r.errors.length > 0) return r;
        return { path: r.path, external: r.external };
      });
      // The loader's deep yoga imports (blocked by yoga's exports map).
      build.onResolve({ filter: /^yoga-layout\/dist\// }, (args) => {
        if (args.path.endsWith("yoga-wasm-base64-esm.js")) return { path: yoga.wasmEsm };
        if (args.path.endsWith("wrapAssembly.js")) return { path: yoga.wrapAssembly };
        if (args.path.endsWith("YGEnums.js")) return { path: yoga.enums };
        return null;
      });
      // npm packages that break in workerd → terminal-shim replacements.
      build.onResolve({ filter: /^signal-exit$/ }, async (args) => {
        const r = await build.resolve(TERMINAL_SHIM_SIGNAL_EXIT, {
          kind: args.kind,
          resolveDir,
        });
        return r.errors.length > 0 ? r : { path: r.path, external: r.external };
      });
      build.onResolve({ filter: /^terminal-size$/ }, async (args) => {
        const r = await build.resolve(TERMINAL_SHIM_TERMINAL_SIZE, {
          kind: args.kind,
          resolveDir,
        });
        return r.errors.length > 0 ? r : { path: r.path, external: r.external };
      });
      // Provided by workerd as a pre-compiled wasm module binding.
      build.onResolve({ filter: /^yoga\.wasm$/ }, () => ({ path: "yoga.wasm", external: true }));
    },
  };
}

// yoga.wasm is identical for a given yoga-layout install; extract once per path.
const yogaWasmCache = new Map<string, Promise<Buffer>>();

/**
 * Extract yoga's raw wasm bytes from its base64-inlined emscripten module by
 * importing the factory and capturing the binary it hands to
 * `WebAssembly.instantiate`. Format-independent. The global patch is held only
 * for our single `factory()` call (workers don't instantiate wasm at build time).
 */
async function extractYogaWasm(resolveDir: string): Promise<Buffer> {
  const { wasmEsm } = resolveYogaPaths(resolveDir);
  let cached = yogaWasmCache.get(wasmEsm);
  if (cached) return cached;
  cached = (async () => {
    const mod = await import(pathToFileURL(wasmEsm).href);
    const factory = mod.default as (opts?: unknown) => Promise<unknown>;
    const orig = WebAssembly.instantiate;
    let captured: Buffer | null = null;
    (WebAssembly as { instantiate: unknown }).instantiate = function (
      src: BufferSource,
      imports?: WebAssembly.Imports
    ) {
      if (src instanceof ArrayBuffer) captured = Buffer.from(new Uint8Array(src));
      else if (ArrayBuffer.isView(src)) {
        captured = Buffer.from(new Uint8Array(src.buffer, src.byteOffset, src.byteLength));
      }
      return (orig as typeof WebAssembly.instantiate).call(
        WebAssembly,
        src as BufferSource,
        imports as WebAssembly.Imports
      );
    };
    try {
      await factory();
    } finally {
      (WebAssembly as { instantiate: unknown }).instantiate = orig;
    }
    if (!captured) throw new Error("terminal worker build: failed to extract yoga.wasm bytes");
    return captured;
  })();
  yogaWasmCache.set(wasmEsm, cached);
  return cached;
}

/**
 * Node built-in modules that must stay external in the worker bundle so that
 * workerd's `nodejs_compat` compat flag satisfies them at runtime. Registry
 * dependency closures commonly pull these in through SDKs and transports.
 *
 * Filesystem modules are included in this list too — the code paths that
 * actually call `fs.readFile` from inside aws-sdk / openai SDKs are ones
 * we never hit at runtime (credential providers, file-based config
 * loaders). Leaving them as externals keeps the bundle building; workerd
 * will either satisfy them via nodejs_compat or throw at the first
 * actual call (which we never reach).
 */
/**
 * Node built-in modules that workerd's `nodejs_compat` compatibility flag
 * DOES implement (or at least provides a working subset of). These stay
 * external in the worker bundle; workerd satisfies them at runtime.
 */
const WORKER_NODE_BUILTIN_EXTERNALS: readonly string[] = [
  "node:assert",
  "node:async_hooks",
  "node:console",
  "node:crypto",
  "node:events",
  "node:fs",
  "node:fs/promises",
  "node:http",
  "node:https",
  "node:path",
  "node:process",
  "node:punycode",
  "node:querystring",
  "node:stream",
  "node:stream/web",
  "node:string_decoder",
  "node:timers",
  "node:timers/promises",
  "node:url",
  "node:util",
  "node:util/types",
  "node:zlib",
  // Bare (non-prefixed) builtins — same deal, stay external so workerd
  // can satisfy them via nodejs_compat. `crypto` is intentionally omitted:
  // CommonJS dependencies such as isomorphic-git use require("crypto"), and
  // workerd rejects dynamic require at module startup.
  "assert",
  "async_hooks",
  "console",
  "events",
  "fs",
  "fs/promises",
  "http",
  "https",
  "path",
  "process",
  "punycode",
  "querystring",
  "stream",
  "string_decoder",
  "timers",
  "url",
  "util",
  "zlib",
];

async function buildWorker(
  node: GraphNode,
  ev: string,
  buildKey: string,
  graph: PackageGraph,
  workspaceRoot: string,
  sourcemap: boolean,
  sourceRoot: string,
  sourceStateHash: string,
  authority: UnitAuthorityManifest
): Promise<BuildResult> {
  const env = await prepareBuildEnv(
    node,
    buildKey,
    graph,
    workspaceRoot,
    sourceRoot,
    "runtime-root"
  );
  const { outdir, nodePaths, resolveDir } = env;
  const entryFile = resolveEntryPoint(node, env.sourcePath, {
    conditions: WORKER_CONDITIONS,
  });

  // Workers run from an immutable in-memory module map supplied to workerd's
  // workerLoader. Package resolution is unavailable there, so dependencies are
  // bundled, but native ESM chunks remain separate: dynamic imports must not be
  // collapsed into the startup module.

  // Read the manifest from the materialized source state rather than
  // `node.manifest`, so exact-state builds never observe mutable source directories.
  const workerSourcePath = path.join(sourceRoot, node.relativePath);
  const extractedPkgPath = path.join(workerSourcePath, "package.json");
  const extractedPkg = JSON.parse(fs.readFileSync(extractedPkgPath, "utf-8"));
  const extractedManifest = extractedPkg.vibestudio ?? {};
  const rpcSchemas = Object.fromEntries(
    (extractedManifest.durable?.classes ?? [])
      .filter((entry: { rpcSchema?: unknown }) => typeof entry.rpcSchema === "string")
      .map((entry: { className: string; rpcSchema: string }) => {
        const schema = workspaceRpcSchema(entry.rpcSchema);
        if (!schema) {
          throw new Error(
            unknownWorkspaceRpcSchemaMessage({
              repoPath: node.relativePath,
              className: entry.className,
              rpcSchema: entry.rpcSchema,
            })
          );
        }
        return [entry.className, schema];
      })
  );
  const workspaceRpcCatalog = await collectWorkspaceRpcCatalog(workerSourcePath, {
    provider: node.relativePath,
    authority,
    rpcSchemas,
  });
  const exposeModules = normalizeManifestSpecList(extractedManifest.exposeModules);
  const dedupePackages = normalizeManifestSpecList(extractedManifest.dedupeModules);
  const terminalWorker = isTerminalWorker(extractedManifest);

  // Generate the expose entry (always — even with empty exposeModules, this
  // sets up __vibestudioRequire__/__vibestudioModuleMap__ so eval has a working
  // require() in the worker context). Then wrap the user entry so the
  // bootstrap runs before user code, and re-export the user module's surface
  // (default fetch handler + named DO classes) for workerd.
  const exposePath = path.join(outdir, "_expose.js");
  fs.writeFileSync(exposePath, generateExposeModuleCode(exposeModules, "worker"));

  // Keep generated module specifiers independent of the unique scratch
  // directory suffix. The suffix exists for cross-process build isolation and
  // must not leak into artifact bytes or their inline source map: rebuilding
  // the same exact semantic state after a cold restart must reproduce the same
  // execution identity.
  const wrapperCode = generateWorkerEntry(
    relativeModuleSpecifier(outdir, exposePath),
    relativeModuleSpecifier(outdir, entryFile)
  );
  const wrapperPath = path.join(outdir, "_entry.js");
  fs.writeFileSync(wrapperPath, wrapperCode);

  const plugins: esbuild.Plugin[] = [
    // Terminal (Ink) workers: intercept yoga-layout / signal-exit / terminal-size
    // BEFORE the workspace resolver so these aliases win. No-op for other workers.
    ...(terminalWorker ? [createTerminalWorkerAliasPlugin(resolveDir)] : []),
    createWorkspaceResolvePlugin(graph, sourceRoot, WORKER_CONDITIONS),
    createTsExtensionPlugin(sourceRoot),
    createWorkerBufferShimPlugin(resolveDir),
    // CommonJS dependencies such as isomorphic-git use require("crypto").
    // workerd's nodejs_compat can satisfy ESM imports of node:crypto, but
    // dynamic CommonJS require is rejected at module startup, so bundle the
    // bare specifier through the same small sync shim used by panel builds.
    createCryptoShimPlugin({ includeNodePrefix: false, resolveDir }),
    // Stub Node built-ins that workerd's nodejs_compat does NOT provide
    // (e.g. child_process, worker_threads) so the bundle links even when
    // transitive SDK deps import them for dead code paths.
    createWorkerNodeStubPlugin(),
  ];
  const dedupePlugin = createDedupePlugin(resolveDir, dedupePackages);
  if (dedupePlugin) {
    plugins.push(dedupePlugin);
  }

  try {
    const buildResult = await esbuild.build({
      entryPoints: [relativeModuleSpecifier(outdir, wrapperPath)],
      absWorkingDir: outdir,
      bundle: true,
      platform: "neutral",
      target: "es2022",
      format: "esm",
      splitting: true,
      outdir,
      entryNames: "bundle",
      chunkNames: "chunks/[name]-[hash]",
      write: false,
      // Keep debugger provenance in the immutable build without making
      // workerd parse and retain it as part of every runtime module. The
      // runtime loader mounts only the primary artifact; the linked map stays
      // available to diagnostics from the same content-addressed build.
      sourcemap: sourcemap ? "linked" : false,
      metafile: true,
      logLevel: "warning",
      conditions: [...WORKER_CONDITIONS],
      // Fall back to the `main` field for registry packages that ship without
      // `exports` or `module`. Without this, esbuild refuses to resolve a
      // `main`-only package in "neutral" platform mode.
      mainFields: ["module", "main"],
      // Node built-ins that workerd's nodejs_compat flag provides at
      // runtime stay external. Modules workerd does NOT implement
      // (child_process, worker_threads, etc.) are intercepted by the
      // createWorkerNodeStubPlugin plugin and replaced with throwing
      // stubs — transitively imported by aws-sdk/proxy-agent/etc. from
      // dead code paths we never reach at runtime.
      // Terminal workers import "yoga.wasm" — workerd provides it as a
      // pre-compiled wasm module binding, so it stays external.
      external: [...WORKER_NODE_BUILTIN_EXTERNALS, ...(terminalWorker ? ["yoga.wasm"] : [])],
      plugins,
      nodePaths,
      tsconfigRaw: { compilerOptions: {} },
    });
    const executableModules = executableModulesFromMetafile(
      buildResult.metafile,
      outdir,
      sourceRoot,
      node,
      graph
    );

    const workerArtifacts = workerBundleArtifacts(outdir, buildResult.outputFiles ?? []);
    const bundle = workerArtifacts.entries.find((artifact) => artifact.role === "primary")!.content;
    const iconArtifact = manifestIconArtifact(extractedManifest, workerSourcePath);
    if (iconArtifact) workerArtifacts.entries.push(iconArtifact);

    if (terminalWorker) {
      // Emit the JS bundle plus the extracted yoga.wasm so workerdManager can
      // attach it as a module binding for this DO. Mirrors buildPanel's
      // multi-artifact pattern.
      const yogaWasm = await extractYogaWasm(resolveDir);
      const artifacts: BuildArtifacts = {
        entries: [
          ...workerArtifacts.entries,
          {
            path: "yoga.wasm",
            role: "wasm",
            contentType: "application/wasm",
            encoding: "base64",
            content: yogaWasm.toString("base64"),
          },
        ],
      };
      const metadata: BuildMetadata = {
        kind: node.kind as BuildMetadata["kind"],
        name: node.name,
        buildKey,
        sourcePath: node.relativePath,
        ev,
        sourceStateHash,
        sourcemap,
        authority,
        workspaceRpcCatalog,
        executableModules,
        details: { kind: "generic" },
        builtAt: new Date().toISOString(),
      };
      return buildStore.put(buildKey, artifacts, metadata);
    }

    return storeSimpleBuild(
      buildKey,
      bundle,
      node,
      ev,
      sourcemap,
      sourceStateHash,
      authority,
      {
        workspaceRpcCatalog,
        executableModules,
      },
      workerArtifacts
    );
  } finally {
    env.cleanup();
  }
}

// ---------------------------------------------------------------------------
// App Build
// ---------------------------------------------------------------------------

async function buildApp(
  node: GraphNode,
  ev: string,
  buildKey: string,
  graph: PackageGraph,
  workspaceRoot: string,
  sourcemap: boolean,
  sourceRoot: string,
  sourceStateHash: string,
  authority: UnitAuthorityManifest
): Promise<BuildResult> {
  const appSourcePath = path.join(sourceRoot, node.relativePath);
  const extractedPkgPath = path.join(appSourcePath, "package.json");
  const extractedPkg = JSON.parse(fs.readFileSync(extractedPkgPath, "utf-8")) as {
    vibestudio?: Record<string, unknown>;
  };
  const extractedManifest = extractedPkg.vibestudio ?? {};
  validateUnitManifest(appUnitManifestDescriptor, extractedManifest, { unitName: node.name });

  const appManifest = extractedManifest["app"] as Record<string, unknown>;
  if (appManifest["target"] === "terminal") {
    return buildTerminalApp(
      node,
      ev,
      buildKey,
      graph,
      workspaceRoot,
      sourcemap,
      sourceRoot,
      appManifest,
      sourceStateHash,
      authority
    );
  }
  if (appManifest["target"] === "react-native") {
    const provider = resolveBuildProvider("react-native");
    const providerBuildKey = computeBuildKey(
      node.name,
      [
        ev,
        `provider:${provider.name}`,
        `provider-ev:${provider.activeEv ?? ""}`,
        `provider-build:${provider.activeBuildKey ?? ""}`,
        `provider-contract:${provider.contractVersion}`,
      ].join(":"),
      sourcemap
    );
    const env = await prepareBuildEnv(
      node,
      providerBuildKey,
      graph,
      workspaceRoot,
      sourceRoot,
      "runtime-root"
    );
    try {
      const providerInput: BuildProviderInput = {
        target: "react-native",
        unitName: node.name,
        sourcePath: appSourcePath,
        dependencyProjection: {
          nodeModulesPath: env.nodeModulesDir || null,
          modules: collectBuildProviderModules(node, graph, sourceRoot, env.outdir),
        },
        effectiveVersion: ev,
        manifest: extractedManifest,
      };
      const output = await provider.build(providerInput);
      const entries = await materializeBuildProviderArtifacts(
        provider,
        providerInput,
        output.artifacts
      );
      const metadata: BuildMetadata = {
        kind: "app",
        name: node.name,
        buildKey: providerBuildKey,
        sourcePath: node.relativePath,
        ev,
        sourceStateHash,
        sourcemap,
        authority,
        details: {
          kind: "app",
          target: "react-native",
          platform: output.metadata?.platform,
          integrity: null,
          rnHostAbi: output.metadata?.rnHostAbi ?? null,
          provider: {
            name: provider.name,
            activeEv: provider.activeEv,
            activeBuildKey: provider.activeBuildKey,
            contractVersion: provider.contractVersion,
          },
        },
        builtAt: new Date().toISOString(),
      };
      return buildStore.put(providerBuildKey, { entries }, metadata);
    } finally {
      env.cleanup();
    }
  }

  return buildPanel(
    node,
    ev,
    buildKey,
    graph,
    workspaceRoot,
    sourcemap,
    sourceRoot,
    sourceStateHash,
    authority
  );
}

function collectBuildProviderModules(
  node: GraphNode,
  graph: PackageGraph,
  sourceRoot: string,
  projectionRoot: string
): Record<string, string> {
  const modules: Record<string, string> = {};
  const externalWorkspacePackages: string[] = [];
  const visitedExternal = new Set<string>();
  const closure = collectTransitiveInternalDeps(node, graph);
  for (const sourceUnit of closure) {
    modules[sourceUnit.name] = path.join(sourceRoot, sourceUnit.relativePath);
    for (const [dependency, specifier] of Object.entries(sourceUnit.dependencies)) {
      if (specifier.startsWith("workspace:") && !graph.isInternal(dependency)) {
        externalWorkspacePackages.push(dependency);
      }
    }
  }

  while (externalWorkspacePackages.length > 0) {
    const packageName = externalWorkspacePackages.shift()!;
    if (visitedExternal.has(packageName)) continue;
    visitedExternal.add(packageName);
    const packageJsonPath = _appNodeModules
      .map((nodeModulesPath) =>
        path.join(nodeModulesPath, ...packageName.split("/"), "package.json")
      )
      .find((candidate) => fs.existsSync(candidate));
    if (!packageJsonPath) {
      throw new Error(`Build dependency projection cannot locate workspace package ${packageName}`);
    }
    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      name?: string;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    if (manifest.name !== packageName) {
      throw new Error(`Build dependency projection resolved the wrong package for ${packageName}`);
    }
    const packageRoot = fs.realpathSync(path.dirname(packageJsonPath));
    const projectedPackageRoot = path.join(
      projectionRoot,
      "workspace-modules",
      Buffer.from(packageName).toString("base64url")
    );
    fs.cpSync(packageRoot, projectedPackageRoot, {
      recursive: true,
      dereference: true,
      filter(source) {
        const relative = path.relative(packageRoot, source);
        const firstSegment = relative.split(path.sep)[0];
        return !["node_modules", ".git", ".cache"].includes(firstSegment ?? "");
      },
    });
    modules[packageName] = projectedPackageRoot;
    for (const [dependency, specifier] of Object.entries({
      ...manifest.peerDependencies,
      ...manifest.dependencies,
    })) {
      if (specifier.startsWith("workspace:") && !graph.isInternal(dependency)) {
        externalWorkspacePackages.push(dependency);
      }
    }
  }

  return Object.fromEntries(
    Object.entries(modules).sort(([left], [right]) => left.localeCompare(right))
  );
}

async function buildTerminalApp(
  node: GraphNode,
  ev: string,
  buildKey: string,
  graph: PackageGraph,
  workspaceRoot: string,
  sourcemap: boolean,
  sourceRoot: string,
  appManifest: Record<string, unknown>,
  sourceStateHash: string,
  authority: UnitAuthorityManifest
): Promise<BuildResult> {
  const env = await prepareBuildEnv(
    node,
    buildKey,
    graph,
    workspaceRoot,
    sourceRoot,
    "runtime-root"
  );
  const { outdir, nodePaths, resolveDir, sourcePath } = env;
  const entry = appManifest["entry"];
  if (typeof entry !== "string" || entry.trim().length === 0) {
    throw new Error(`Terminal app ${node.name} requires vibestudio.app.entry`);
  }
  const entryFile = path.join(sourcePath, entry);
  if (!fs.existsSync(entryFile)) {
    throw new Error(`Terminal app ${node.name} entry does not exist: ${entry}`);
  }
  try {
    await esbuild.build({
      entryPoints: [entryFile],
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
      outfile: path.join(outdir, "index.mjs"),
      banner: {
        js:
          'import { createRequire as __vibestudioCreateRequire } from "node:module";\n' +
          "const require = __vibestudioCreateRequire(import.meta.url);",
      },
      sourcemap: sourcemap ? "inline" : false,
      metafile: true,
      logLevel: "warning",
      conditions: ["node", "import"],
      external: [...WORKER_NODE_BUILTIN_EXTERNALS],
      plugins: [
        createWorkspaceResolvePlugin(graph, sourceRoot),
        createTsExtensionPlugin(sourceRoot),
      ],
      nodePaths,
      absWorkingDir: resolveDir,
      tsconfigRaw: { compilerOptions: {} },
    });
    const bundle = fs.readFileSync(path.join(outdir, "index.mjs"), "utf8");
    return buildStore.put(
      buildKey,
      {
        entries: [
          {
            path: "index.mjs",
            role: "primary",
            contentType: "text/javascript; charset=utf-8",
            encoding: "utf8",
            content: bundle,
          },
        ],
      },
      {
        kind: "app",
        name: node.name,
        buildKey,
        sourcePath: node.relativePath,
        ev,
        sourceStateHash,
        sourcemap,
        authority,
        details: {
          kind: "app",
          target: "terminal",
          platform: "terminal",
          integrity: null,
          rnHostAbi: null,
          provider: null,
        },
        builtAt: new Date().toISOString(),
      }
    );
  } finally {
    env.cleanup();
  }
}

async function materializeBuildProviderArtifacts(
  provider: BuildProvider,
  input: BuildProviderInput,
  artifacts: BuildProviderArtifact[]
): Promise<BuildArtifactInput[]> {
  return Promise.all(
    artifacts.map(async (artifact) => {
      const encoding = artifact.encoding ?? "utf8";
      let content: string;
      if (typeof artifact.content === "string") {
        content = artifact.content;
      } else if (artifact.stream) {
        if (!provider.streamArtifact) {
          throw new Error(
            `Build provider ${provider.name} returned stream-backed artifact ${artifact.path} but does not expose streamArtifact`
          );
        }
        const response = await provider.streamArtifact(artifact, input);
        if (!response.ok) {
          throw new Error(
            `Build provider ${provider.name} failed streaming artifact ${artifact.path}: ${response.status} ${response.statusText}`
          );
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        content =
          encoding === "base64"
            ? Buffer.from(bytes).toString("base64")
            : new TextDecoder().decode(bytes);
      } else {
        throw new Error(
          `Build provider ${provider.name} returned artifact ${artifact.path} without content or stream`
        );
      }
      return {
        path: artifact.path,
        role: artifact.role,
        contentType: artifact.contentType,
        encoding,
        ...(artifact.platform ? { platform: artifact.platform } : {}),
        content,
      };
    })
  );
}

// ---------------------------------------------------------------------------
// Extension Build
// ---------------------------------------------------------------------------

function validateExtensionManifest(node: GraphNode, manifest: Record<string, unknown>): void {
  validateUnitManifest(extensionUnitManifestDescriptor, manifest, { unitName: node.name });
}

function extensionProviderContracts(
  extensionManifest: Record<string, unknown> | undefined
): Record<string, { methods: string[] }> {
  const declared =
    (extensionManifest?.["providerContracts"] as
      | Record<string, { methods: string[] }>
      | undefined) ?? {};
  return Object.fromEntries(
    Object.entries(declared).map(([provider, contract]) => [
      provider,
      { methods: [...contract.methods] },
    ])
  );
}

function sealedExtensionMethodAuthority(
  extensionManifest: Record<string, unknown> | undefined,
  provider: string,
  authority: UnitAuthorityManifest
): import("./buildStore.js").ExtensionMethodAuthority {
  const declarations = parseExtensionMethodAuthority(
    extensionManifest?.["methodAuthority"],
    `Extension ${provider} methodAuthority`
  );
  const definitions = new Map(
    authority.provides.map((definition) => [definition.name, definition])
  );
  const bound = new Map<string, string[]>();
  const result: import("./buildStore.js").ExtensionMethodAuthority = {};
  for (const [method, declaration] of Object.entries(declarations)) {
    if (declaration.effect.kind === "open") {
      result[method] = { effect: { kind: "open" } };
      continue;
    }
    const definition = definitions.get(declaration.effect.capability);
    if (!definition) {
      throw new Error(
        `${provider}.${method} references undeclared userland capability ${declaration.effect.capability}`
      );
    }
    const methods = bound.get(definition.name) ?? [];
    methods.push(method);
    bound.set(definition.name, methods);
  }
  for (const definition of authority.provides) {
    const methods = bound.get(definition.name)?.sort();
    if (!methods?.length) {
      throw new Error(
        `${provider} provides ${definition.name}, but no public extension method binds it`
      );
    }
    const definitionDigest = sha256Canonical({
      definition,
      bindings: methods.map((method) => ({
        method,
        resource: { kind: "receiver" },
        inputContractDigest: sha256Canonical({
          service: "extensions",
          method,
          args: "unknown[]",
        }),
      })),
    });
    const canonicalCapability = `userland:${provider}/${definition.name}#${definitionDigest}`;
    for (const method of methods) {
      const declaration = declarations[method]!;
      if (declaration.effect.kind !== "userland-capability") {
        throw new Error(`${provider}.${method} lost its userland capability binding`);
      }
      result[method] = {
        effect: {
          kind: "userland-capability",
          capability: declaration.effect.capability,
          resource: { kind: "receiver" },
        },
        userlandCapability: {
          canonicalCapability,
          definitionDigest,
          resourceType: definition.resourceType,
          grantScopes: definition.grantScopes,
          title: definition.title,
          action: definition.action,
          ...(definition.description ? { description: definition.description } : {}),
        },
      };
    }
  }
  return result;
}

async function buildExtension(
  node: GraphNode,
  ev: string,
  buildKey: string,
  graph: PackageGraph,
  workspaceRoot: string,
  sourceRoot: string,
  sourceStateHash: string,
  authority: UnitAuthorityManifest
): Promise<BuildResult> {
  const env = await prepareBuildEnv(
    node,
    buildKey,
    graph,
    workspaceRoot,
    sourceRoot,
    "runtime-root"
  );
  const { outdir, nodePaths, resolveDir } = env;
  const entryFile = resolveEntryPoint(node, env.sourcePath, {
    conditions: EXTENSION_CONDITIONS,
  });

  const extensionSourcePath = path.join(sourceRoot, node.relativePath);
  const extractedPkgPath = path.join(extensionSourcePath, "package.json");
  const extractedPkg = JSON.parse(fs.readFileSync(extractedPkgPath, "utf-8")) as {
    vibestudio?: Record<string, unknown>;
  };
  const extractedManifest = extractedPkg.vibestudio ?? {};
  validateExtensionManifest(node, extractedManifest);
  const extensionManifest = extractedManifest["extension"] as Record<string, unknown> | undefined;
  const providerContracts = extensionProviderContracts(extensionManifest);
  const methodAuthority = sealedExtensionMethodAuthority(
    extensionManifest,
    node.relativePath,
    authority
  );
  const dependencyMode = normalizeExtensionDependencyMode(extensionManifest?.["dependencyMode"]);
  const dependencyDiagnostics = analyzeExtensionDependencies(
    env.externalDeps,
    nodePaths,
    dependencyMode
  );
  const { classifiedDeps, runtimeExternalDeps } = dependencyDiagnostics;
  const runtimeDependencyPatches = dependencyPatchesForExternalRoots(
    env.dependencyPatches,
    runtimeExternalDeps
  );
  const dedupePackages = normalizeManifestSpecList(
    extractedManifest["dedupeModules"] as string[] | undefined
  );

  const plugins: esbuild.Plugin[] = [
    createWorkspaceResolvePlugin(graph, sourceRoot, EXTENSION_CONDITIONS),
    createTsExtensionPlugin(sourceRoot),
  ];
  const cjsShimPlugin = createExtensionCjsShimPlugin(outdir, classifiedDeps);
  if (cjsShimPlugin) {
    plugins.push(cjsShimPlugin);
  }
  const dedupePlugin = createDedupePlugin(resolveDir, dedupePackages);
  if (dedupePlugin) {
    plugins.push(dedupePlugin);
  }

  try {
    await esbuild.build({
      entryPoints: [entryFile],
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
      splitting: false,
      outfile: path.join(outdir, "bundle.js"),
      banner: {
        js: [
          "import { createRequire as __vibestudioCreateRequire } from 'node:module';",
          "import { fileURLToPath as __vibestudioFileURLToPath } from 'node:url';",
          "import { dirname as __vibestudioDirname } from 'node:path';",
          "const require = __vibestudioCreateRequire(import.meta.url);",
          "const __filename = __vibestudioFileURLToPath(import.meta.url);",
          "const __dirname = __vibestudioDirname(__filename);",
        ].join("\n"),
      },
      sourcemap: "inline",
      metafile: true,
      logLevel: "warning",
      conditions: [...EXTENSION_CONDITIONS],
      mainFields: ["module", "main"],
      external: [...KNOWN_NATIVE_EXTERNALS, ...expandExternalSpecifiers(runtimeExternalDeps)],
      plugins,
      nodePaths,
      tsconfigRaw: { compilerOptions: {} },
    });

    const runtimeDeps = await ensureExtensionRuntimeDeps(
      _appRoot,
      runtimeExternalDeps,
      env.dependencyOverrides,
      runtimeDependencyPatches
    );
    try {
      if (runtimeDeps.nodeModulesDir) {
        materializeExtensionRuntimeDeps(outdir, runtimeDeps.nodeModulesDir, node.name);
      }

      const bundlePath = path.join(outdir, "bundle.js");
      const bundle = fs.readFileSync(bundlePath, "utf-8");
      const extensionArtifacts = bundleArtifacts(bundle);
      const iconArtifact = manifestIconArtifact(extractedManifest, extensionSourcePath);
      if (iconArtifact) extensionArtifacts.entries.push(iconArtifact);
      const smokeArtifacts: BuildArtifactWithContent[] = extensionArtifacts.entries.map(
        (entry) => ({
          ...entry,
          encoding: entry.encoding ?? "utf8",
        })
      );
      fs.writeFileSync(path.join(outdir, "package.json"), '{"type":"module"}');
      const smokeResult: BuildResult = {
        dir: outdir,
        buildKey,
        sourceStateHash,
        metadata: {
          kind: "extension",
          name: node.name,
          buildKey,
          sourcePath: node.relativePath,
          ev,
          sourceStateHash,
          sourcemap: true,
          authority,
          details: {
            kind: "extension",
            runtimeDepsKey: runtimeDeps.key,
            runtimeAbi: EXTENSION_RUNTIME_ABI_VERSION,
            providerContracts,
            methodAuthority,
            dependencyMode,
            externalDeps: runtimeExternalDeps,
            dependencyOverrides: env.dependencyOverrides,
            dependencyPatches: runtimeDependencyPatches,
            classifiedDeps,
          },
          builtAt: new Date().toISOString(),
        },
        artifacts: smokeArtifacts,
      };
      await smokeTestExtensionBuild(smokeResult, node, {
        dependencyDiagnostics,
      });

      const result = await storeSimpleBuild(
        buildKey,
        bundle,
        node,
        ev,
        true,
        sourceStateHash,
        authority,
        {
          details: {
            kind: "extension",
            runtimeDepsKey: runtimeDeps.key,
            runtimeAbi: EXTENSION_RUNTIME_ABI_VERSION,
            providerContracts,
            methodAuthority,
            dependencyMode,
            externalDeps: runtimeExternalDeps,
            dependencyOverrides: env.dependencyOverrides,
            dependencyPatches: runtimeDependencyPatches,
            classifiedDeps,
            smokeTest: { mode: "child-process", passed: true },
          },
        },
        extensionArtifacts
      );
      if (runtimeDeps.nodeModulesDir) {
        materializeExtensionRuntimeDeps(result.dir, runtimeDeps.nodeModulesDir, node.name);
      }

      return result;
    } finally {
      runtimeDeps.release();
    }
  } finally {
    env.cleanup();
  }
}

async function smokeTestExtensionBuild(
  result: BuildResult,
  node: GraphNode,
  details: {
    dependencyDiagnostics: ExtensionDependencyDiagnostics;
  }
): Promise<void> {
  const smokeDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-extension-smoke-"));
  const smokeScript = path.join(smokeDir, "smoke.mjs");
  try {
    fs.writeFileSync(
      smokeScript,
      generateExtensionSmokeScript(
        primaryArtifactFilePath(result),
        Object.keys(details.dependencyDiagnostics.runtimeExternalDeps)
      )
    );
    const bundlePath = primaryArtifactFilePath(result);
    await execFileAsync(process.execPath, [smokeScript], {
      cwd: result.dir,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        VIBESTUDIO_EXTENSION_SMOKE: "1",
        VIBESTUDIO_EXTENSION_SMOKE_BUNDLE: bundlePath,
      },
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    const diagnostics = details.dependencyDiagnostics;
    const depSummary = diagnostics.classifiedDeps.map(
      (dep) =>
        `${dep.name}@${dep.version}:${dep.external ? "external" : "bundled"}:${dep.format}` +
        (dep.reasons.length ? `(${dep.reasons.join(",")})` : "")
    );
    const stderr =
      typeof (err as { stderr?: unknown }).stderr === "string"
        ? `\nstderr=${(err as { stderr: string }).stderr.trim()}`
        : "";
    const smokeError = new Error(
      [
        `Extension smoke test failed for ${node.name}: ${err instanceof Error ? err.message : String(err)}`,
        `bundle=${primaryArtifactFilePath(result)}`,
        `dependencyMode=${diagnostics.dependencyMode}`,
        `runtimeDeps=${Object.keys(diagnostics.runtimeExternalDeps).join(",") || "none"}`,
        `classifiedDeps=${depSummary.join(";") || "none"}`,
        `diagnostics=${diagnostics.notes.join(" | ")}`,
        stderr,
      ].join("\n")
    );
    if (err instanceof Error) {
      (smokeError as Error & { cause?: unknown }).cause = err;
    }
    throw smokeError;
  } finally {
    fs.rmSync(smokeDir, { recursive: true, force: true });
  }
}

function generateExtensionSmokeScript(bundlePath: string, runtimeExternalDeps: string[]): string {
  return `
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const bundlePath = ${JSON.stringify(bundlePath)};
const runtimeExternalDeps = ${JSON.stringify(runtimeExternalDeps)};
const require = createRequire(pathToFileURL(bundlePath).href);
for (const dep of runtimeExternalDeps) {
  require.resolve(dep);
}
function createAsyncNullProxy() {
  return new Proxy(Object.create(null), {
    get(_target, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      return async () => null;
    },
  });
}
function createExtensionSmokeContext() {
  const asyncNull = createAsyncNullProxy();
  const storage = new Proxy(Object.create(null), {
    get(_target, prop) {
      if (prop === "readdir") return async () => [];
      if (prop === "readFile") {
        return async () => {
          const error = new Error("Smoke storage entry does not exist");
          error.code = "ENOENT";
          throw error;
        };
      }
      if (typeof prop !== "string" || prop === "then") return undefined;
      return async () => undefined;
    },
  });
  return {
    name: "smoke-test",
    version: "0.0.0",
    storage,
    fs: asyncNull,
    git: asyncNull,
    panel: asyncNull,
    workspace: {
      async getInfo() {
        return {
          id: "smoke",
          name: "smoke",
          path: process.cwd(),
          contextProjectionsPath: process.cwd(),
        };
      },
    },
    rpc: {
      async call(_target, method) {
        if (method === "workspace.getConfig") return { id: "smoke" };
        return null;
      },
    },
    workers: {
      listServices: asyncNull,
      resolveService: asyncNull,
      resolveDurableObject: asyncNull,
    },
    credentials: asyncNull,
    db: asyncNull,
    webhooks: asyncNull,
    approvals: {
      async request() {
        return { kind: "dismissed" };
      },
      async revoke() {
        return false;
      },
      async list() {
        return [];
      },
    },
    notifications: asyncNull,
    extensions: {
      use: () => createAsyncNullProxy(),
      on: () => ({ dispose() {} }),
      list: async () => [],
    },
    invocation: { current: () => null },
    subscriptions: [],
    log: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    health: {
      report() {},
      healthy() {},
      degraded() {},
      unhealthy() {},
    },
    emit() {},
  };
}
const mod = await import(pathToFileURL(bundlePath).href);
const activate = mod["activate"];
if (typeof activate === "function") {
  const api = await activate(createExtensionSmokeContext());
  if (api !== undefined && (api === null || typeof api !== "object")) {
    throw new Error("activate() must return an object or undefined");
  }
}
`;
}

async function refreshCachedExtensionRuntimeDeps(result: BuildResult): Promise<void> {
  const extensionDetails =
    result.metadata.details.kind === "extension" ? result.metadata.details : null;
  const deps = extensionDetails?.externalDeps ?? {};
  if (Object.keys(deps).length === 0) return;
  if (extensionRuntimeDepsResolvable(primaryArtifactFilePath(result), Object.keys(deps))) return;

  const runtimeDeps = await ensureExtensionRuntimeDeps(
    _appRoot,
    deps,
    extensionDetails?.dependencyOverrides ?? {},
    extensionDetails?.dependencyPatches ?? []
  );
  try {
    if (runtimeDeps.nodeModulesDir) {
      materializeExtensionRuntimeDeps(result.dir, runtimeDeps.nodeModulesDir, result.metadata.name);
    }
    if (extensionDetails && extensionDetails.runtimeDepsKey !== runtimeDeps.key) {
      extensionDetails.runtimeDepsKey = runtimeDeps.key;
      fs.writeFileSync(
        path.join(result.dir, "metadata.json"),
        JSON.stringify(result.metadata, null, 2)
      );
    }
  } finally {
    runtimeDeps.release();
  }
}

function extensionRuntimeDepsResolvable(bundlePath: string, deps: string[]): boolean {
  if (deps.length === 0) return true;
  const runtimeRequire = createRequire(pathToFileURL(bundlePath).href);
  try {
    for (const dep of deps) {
      runtimeRequire.resolve(dep);
    }
    return true;
  } catch {
    return false;
  }
}

function materializeExtensionRuntimeDeps(
  buildDir: string,
  nodeModulesDir: string,
  extensionName: string
): void {
  if (!fs.existsSync(nodeModulesDir)) {
    throw new Error(
      `Extension runtime dependencies for ${extensionName} are missing: ${nodeModulesDir}`
    );
  }
  const link = path.join(buildDir, "node_modules");
  try {
    fs.rmSync(link, { recursive: true, force: true });
    materializeImmutableTree(nodeModulesDir, link);
  } catch (err) {
    throw new Error(
      `Failed to materialize extension runtime dependencies for ${extensionName}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

function materializeImmutableTree(source: string, target: string): void {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), target);
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true, mode: stat.mode });
    for (const child of fs.readdirSync(source)) {
      materializeImmutableTree(path.join(source, child), path.join(target, child));
    }
    return;
  }
  if (!stat.isFile()) throw new Error(`Unsupported runtime dependency entry: ${source}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.linkSync(source, target);
  } catch (error) {
    if (
      !["EXDEV", "EPERM", "EACCES", "EMLINK"].includes((error as NodeJS.ErrnoException).code ?? "")
    ) {
      throw error;
    }
    fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
  }
}

// ---------------------------------------------------------------------------
// Library Build
// ---------------------------------------------------------------------------

async function buildLibraryBundle(
  node: GraphNode,
  ev: string,
  buildKey: string,
  graph: PackageGraph,
  workspaceRoot: string,
  sourceRoot: string,
  sourceStateHash: string,
  externals: string[],
  entrySubpath = ".",
  conditions: readonly string[],
  authority: UnitAuthorityManifest,
  target: LibraryBuildTarget
): Promise<BuildResult> {
  const env = await prepareBuildEnv(node, buildKey, graph, workspaceRoot, sourceRoot, "library");

  try {
    // A library's provided peers belong to the realm that loads it, so they are
    // external here whether or not this caller named them. `externals` is what
    // the loading realm already has (a panel's module map, EvalDO's private
    // map) and is empty when the build is only verifying the unit -- so absence
    // from it says nothing. What matters is that the bundle never carries its
    // own copy: a package the realm also has would become a second live
    // instance, and two Reacts in one realm is where hooks stop working. Left
    // external, an import the realm cannot satisfy fails at load naming the
    // module, instead of silently resolving to a private duplicate.
    const libraryExternals = [...new Set([...externals, ...Object.keys(env.providedPeers)])];
    const moduleUrl = `vibestudio-module://build/${buildKey}/${encodeURIComponent(node.name)}`;
    const outfile = path.join(env.outdir, "bundle.mjs");
    const entryFile = resolveEntryPoint(node, env.sourcePath, {
      conditions,
      subpath: entrySubpath,
    });
    await esbuild.build({
      entryPoints: [entryFile],
      bundle: true,
      // Preserve async-module semantics across the complete dependency graph.
      // A second syntax-only pass lowers imports/exports to require/exports
      // without touching top-level await; the eval linker executes that output
      // inside an async module factory.
      format: "esm",
      platform: "browser",
      target: "es2022",
      outfile,
      write: true,
      external:
        target === "worker"
          ? [...new Set([...libraryExternals, ...WORKER_NODE_BUILTIN_EXTERNALS])]
          : libraryExternals,
      // Apply the execution target to third-party dependencies too. The
      // workspace resolver below already uses these conditions for local
      // packages, but without esbuild's top-level conditions npm dependencies
      // silently fall back to the browser condition because this bundle uses
      // the browser platform for its safe fs/path/buffer shims. A worker/eval
      // bundle must prefer `worker`/`workerd` exports throughout the graph.
      conditions: [...conditions],
      plugins: [
        // `conditions` selects each workspace package's export entry by execution
        // target (panel vs worker/eval). Pass `externals` to the resolve plugin
        // too: esbuild's `external` option alone is bypassed because this plugin's
        // onResolve handles `@workspace/*` first. The host (EvalDO) provides those
        // externals at runtime via its module map.
        createWorkspaceResolvePlugin(graph, sourceRoot, conditions, libraryExternals),
        createTsExtensionPlugin(sourceRoot),
        createFsShimPlugin({ runtimeBacked: true, resolveDir: env.resolveDir }),
        createPathShimPlugin(env.resolveDir),
        createWorkerBufferShimPlugin(env.resolveDir),
        ...(target === "worker" ? [createWorkerNodeStubPlugin()] : []),
      ],
      nodePaths: env.nodePaths,
      loader: LIBRARY_ASSET_LOADERS,
      logLevel: "warning",
      tsconfigRaw: { compilerOptions: { jsx: "react-jsx" } },
      // The async-CJS linker has no ambient ESM loader and must never expose a
      // host checkout path. Preserve import.meta.url semantics with an exact,
      // content-addressed synthetic module coordinate embedded in the artifact.
      define: { "import.meta": JSON.stringify({ url: moduleUrl }) },
    });

    const esmBundle = fs.readFileSync(outfile, "utf-8");
    const bundleContent = transformBabel(esmBundle, {
      babelrc: false,
      configFile: false,
      sourceType: "module",
      plugins: [
        controlledDynamicImportPlugin,
        [getTransformModulesCommonJs(), { strictMode: true }],
      ],
      compact: false,
      comments: true,
      ast: false,
      code: true,
    })?.code;
    if (!bundleContent) {
      throw new Error(`library module lowering produced no output for ${node.name}`);
    }
    return storeSimpleBuild(buildKey, bundleContent, node, ev, false, sourceStateHash, authority, {
      details: { kind: "library", format: "async-cjs" },
    });
  } finally {
    env.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Npm Library Build
// ---------------------------------------------------------------------------

/**
 * Validate that a specifier looks like a legitimate npm package name.
 * Rejects path traversals, URLs, and git specifiers that could cause
 * npm to fetch from unexpected sources.
 */
function validateNpmSpecifier(specifier: string): void {
  // npm package names: optional @scope/name, alphanumeric + hyphens + dots
  const NPM_NAME_RE = /^(@[a-z0-9\-~][a-z0-9\-._~]*\/)?[a-z0-9\-~][a-z0-9\-._~]*$/;
  if (!NPM_NAME_RE.test(specifier)) {
    throw new BuildRequestError(
      "invalid_package_specifier",
      `Invalid npm package specifier: ${specifier}`,
      { specifier }
    );
  }
}

function validateSandboxNpmLibrarySpecifier(specifier: string): void {
  if (
    specifier === "vitest" ||
    specifier === "vite" ||
    specifier === "vite-node" ||
    specifier === "esbuild" ||
    specifier.startsWith("@vitest/")
  ) {
    throw new BuildRequestError(
      "unsupported_package",
      `Unsupported npm package for panel eval: ${specifier}. ` +
        "Test/build toolchains must run through a server-side test runner or extension, not the browser sandbox package loader.",
      { specifier }
    );
  }
}

/**
 * Validate that a version string is a registry semver/range
 * specifier. Rejects everything that npm would otherwise interpret as a
 * non-registry source (`file:`, `git+ssh://`, `https://`, `github:`,
 * `npm:`, local paths, tarball URLs). Without this check, a worker /
 * panel that reaches `getBuildNpm` can pass arbitrary `version` values
 * straight into `npm install`, letting it fetch from attacker-controlled
 * URLs or copy local filesystem paths into the build cache.
 *
 * Allowed shapes:
 *   1 / 1.2 / 1.2.3      major / minor / exact
 *   ^1.2.3 / ~1.2.3      caret / tilde
 *   >=1.2.3 etc.         comparator
 *   1.2.3-rc.1+build.5   pre-release / build metadata
 *   latest / *           dist-tag / wildcard (registry only)
 *
 * TODO: if a legitimate use case for non-registry installs ever surfaces,
 * route it through a separate, shell-only RPC that takes a strongly-typed
 * `{ kind: "git" | "file"; …}` argument rather than a free-form string.
 */
const SEMVER_RE = /^(\^|~|>=|<=|=|>|<)?(?:\d+|\d+\.\d+|\d+\.\d+\.\d+(-[\w.+-]+)?(\+[\w.+-]+)?)$/;
function validateNpmVersion(version: string): void {
  if (typeof version !== "string" || version.length === 0 || version.length > 64) {
    throw new BuildRequestError("invalid_package_version", `Invalid npm version: ${version}`, {
      version,
    });
  }
  if (version === "latest" || version === "*") return;
  if (SEMVER_RE.test(version)) return;
  throw new BuildRequestError(
    "invalid_package_version",
    `Invalid npm version "${version}". Only registry semver/range values, "latest", or "*" are allowed; ` +
      `file:, git+, http(s)://, github:, npm:, and local-path specifiers are rejected.`,
    { version }
  );
}

/** Cache key for npm library builds */
function npmBuildKey(specifier: string, version: string, externals: string[]): string {
  const hash = createHash("sha256")
    .update(JSON.stringify({ specifier, version, externals: externals.slice().sort() }))
    .digest("hex")
    .slice(0, 16);
  return `npm:${specifier}@${version}:${hash}`;
}

/**
 * Build an npm package as a CJS library bundle for sandbox consumption.
 *
 * Unlike buildLibraryBundle (which builds workspace packages from GAD state), this
 * installs an arbitrary npm package and bundles it with esbuild. The result
 * is a self-contained CJS string that can be loaded into __vibestudioModuleMap__.
 *
 * Flow: validate → npm install → esbuild bundle → cache → return CJS string.
 *
 * Security:
 * - Specifier validated against npm naming rules (no URLs, paths, or git refs)
 * - npm install runs with --ignore-scripts (no postinstall)
 * - Native addons (.node files) will fail to bundle (natural guardrail)
 * - Bundle size is bounded by esbuild timeout / memory limits
 */
export async function buildNpmLibrary(
  specifier: string,
  version: string,
  externals: string[]
): Promise<string> {
  validateNpmSpecifier(specifier);
  validateSandboxNpmLibrarySpecifier(specifier);
  validateNpmVersion(version);

  const buildKey = npmBuildKey(specifier, version, externals);

  // Check store cache
  const cached = buildStore.get(buildKey);
  if (cached) return primaryTextArtifactContent(cached);

  // Check in-flight builds (coalescing)
  const inFlight = inFlightBuilds.get(buildKey);
  if (inFlight) return primaryTextArtifactContent(await inFlight);

  const buildPromise = doNpmBuild(specifier, version, externals, buildKey);
  inFlightBuilds.set(buildKey, buildPromise);

  try {
    return primaryTextArtifactContent(await buildPromise);
  } finally {
    inFlightBuilds.delete(buildKey);
  }
}

async function doNpmBuild(
  specifier: string,
  version: string,
  externals: string[],
  buildKey: string
): Promise<BuildResult> {
  await acquireSemaphore();

  try {
    const deps: Record<string, string> = { [specifier]: version };
    const borrowedDeps = await acquireExternalDeps(deps, {}, { appRoot: _appRoot });
    const nodeModulesDir = borrowedDeps.nodeModulesDir;

    if (!nodeModulesDir) {
      throw new Error(`Failed to install npm package: ${specifier}@${version}`);
    }

    const outdir = createBuildScratchDir(`npm-${specifier.replace(/[/@]/g, "_")}`);

    const nodePaths = [nodeModulesDir];
    if (_appNodeModules.length > 0) {
      nodePaths.push(..._appNodeModules);
    }

    // Use a virtual entry file instead of string interpolation to avoid injection
    const entryFile = path.join(outdir, "_entry.js");
    fs.writeFileSync(entryFile, `module.exports = require(${JSON.stringify(specifier)});\n`);

    try {
      await esbuild.build({
        entryPoints: [entryFile],
        bundle: true,
        format: "cjs",
        platform: "browser",
        outfile: path.join(outdir, "bundle.js"),
        write: true,
        // esbuild's "browser" platform does NOT auto-externalize Node built-ins
        // (unlike "node"), so packages such as shelljs/glob that import
        // path/util/assert/child_process would otherwise hard-fail with
        // "Could not resolve". Mirror the worker bundle: builtins the sandbox
        // runtime can satisfy stay external; the rest (child_process, os, …)
        // are intercepted by createWorkerNodeStubPlugin and replaced with a
        // throwing stub, so the bundle links and only throws if actually used.
        external: [...externals, ...WORKER_NODE_BUILTIN_EXTERNALS],
        plugins: [
          createCryptoShimPlugin({ includeNodePrefix: false, resolveDir: nodeModulesDir }),
          createWorkerNodeStubPlugin(),
        ],
        nodePaths,
        logLevel: "warning",
        tsconfigRaw: { compilerOptions: {} },
      });

      const bundleContent = fs.readFileSync(path.join(outdir, "bundle.js"), "utf-8");

      // Store in build cache (same as workspace library builds)
      const metadata: BuildMetadata = {
        kind: "panel",
        name: specifier,
        buildKey,
        sourcePath: null,
        ev: `npm:${version}`,
        sourceStateHash: null,
        sourcemap: false,
        details: { kind: "generic" },
        builtAt: new Date().toISOString(),
      };
      return buildStore.put(buildKey, bundleArtifacts(bundleContent), metadata);
    } finally {
      borrowedDeps.release();
      try {
        fs.rmSync(outdir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
  } finally {
    releaseSemaphore();
  }
}

// ---------------------------------------------------------------------------
// Platform Library Build (@vibestudio/* packages)
// ---------------------------------------------------------------------------

/**
 * Build a @vibestudio/* platform package as a CJS library bundle for eval.
 *
 * These packages live in the app's node_modules (installed via pnpm workspace
 * protocol), not in the workspace build graph. We bundle them the same way
 * as npm packages — esbuild with a virtual entry file.
 */
export async function buildPlatformLibrary(
  specifier: string,
  externals: string[]
): Promise<string> {
  if (_appNodeModules.length === 0) {
    throw new Error("App node_modules not configured — cannot build @vibestudio/* packages");
  }

  const buildKey = `platform:${specifier}:${externals.sort().join(",")}`;

  // Check cache
  const cached = buildStore.get(buildKey);
  if (cached) return primaryTextArtifactContent(cached);

  // Check in-flight
  const inFlight = inFlightLibraryBuilds.get(buildKey);
  if (inFlight) return primaryTextArtifactContent(await inFlight);

  const buildPromise = doPlatformBuild(specifier, externals, buildKey);
  inFlightLibraryBuilds.set(buildKey, buildPromise);

  try {
    return primaryTextArtifactContent(await buildPromise);
  } finally {
    inFlightLibraryBuilds.delete(buildKey);
  }
}

async function doPlatformBuild(
  specifier: string,
  externals: string[],
  buildKey: string
): Promise<BuildResult> {
  await acquireSemaphore();

  try {
    const outdir = createBuildScratchDir(`platform-${specifier.replace(/[/@]/g, "_")}`);

    const nodePaths = [..._appNodeModules];

    // Virtual entry file
    const entryFile = path.join(outdir, "_entry.js");
    fs.writeFileSync(entryFile, `module.exports = require(${JSON.stringify(specifier)});\n`);

    try {
      await esbuild.build({
        entryPoints: [entryFile],
        bundle: true,
        format: "cjs",
        // Use "neutral" not "browser" — @vibestudio/* packages (like git wrapping
        // isomorphic-git) work with injected fs, not Node.js builtins.
        platform: "neutral",
        // Neutral defaults ignore package.json `main`. Platform libraries may
        // legitimately depend on CommonJS/main-only packages (isomorphic-git's
        // crc-32, clean-git-ref, diff3, sha.js -> inherits, and many others).
        // Match worker/extension resolution instead of maintaining a brittle
        // package allowlist.
        mainFields: ["module", "main"],
        outfile: path.join(outdir, "bundle.js"),
        write: true,
        external: externals,
        nodePaths,
        logLevel: "warning",
        tsconfigRaw: { compilerOptions: {} },
      });

      const bundleContent = fs.readFileSync(path.join(outdir, "bundle.js"), "utf-8");

      const metadata: BuildMetadata = {
        kind: "package",
        name: specifier,
        buildKey,
        sourcePath: null,
        ev: buildKey,
        sourceStateHash: null,
        sourcemap: false,
        details: { kind: "generic" },
        builtAt: new Date().toISOString(),
      };
      return buildStore.put(buildKey, bundleArtifacts(bundleContent), metadata);
    } finally {
      try {
        fs.rmSync(outdir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  } finally {
    releaseSemaphore();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the entry point for a node.
 * Uses sourcePath from the materialized source state instead of node.path.
 */
export function resolveEntryPoint(
  node: GraphNode,
  sourcePath: string,
  options: {
    conditions?: readonly string[];
    subpath?: string;
  } = {}
): string {
  const conditions = options.conditions ?? PANEL_CONDITIONS;
  const subpath = options.subpath ?? ".";
  if (subpath !== ".") {
    return resolvePackageExportEntryPoint(node, sourcePath, subpath, conditions);
  }

  const explicit = node.manifest.entry;
  if (explicit) {
    const full = path.join(sourcePath, explicit);
    if (fs.existsSync(full)) return full;
  }

  const pkgJsonPath = path.join(sourcePath, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
      main?: string;
      exports?: Record<string, unknown>;
    };
    let target: string | null = null;
    if (pkgJson.exports) {
      target = resolveExportSubpath(pkgJson.exports, ".", conditions);
      if (!target) {
        throw new BuildRequestError(
          "package_export_not_found",
          `No export . found for ${node.name}`,
          { packageName: node.name, subpath: ".", conditions: [...conditions] }
        );
      }
    }
    if (!target && pkgJson.main) {
      target = pkgJson.main;
    }
    if (target) {
      const resolved = path.resolve(sourcePath, target);
      if (fs.existsSync(resolved)) return resolved;
      const srcFallback = resolveSourceFallback(sourcePath, target);
      if (srcFallback) return srcFallback;
    }
  }

  // Try common entry points
  for (const candidate of [
    "src/index.tsx",
    "src/index.ts",
    "src/index.jsx",
    "src/index.js",
    "index.tsx",
    "index.ts",
    "index.jsx",
    "index.js",
  ]) {
    const full = path.join(sourcePath, candidate);
    if (fs.existsSync(full)) return full;
  }

  throw new Error(`No entry point found for ${node.name} at ${sourcePath}`);
}

function resolvePackageExportEntryPoint(
  node: GraphNode,
  sourcePath: string,
  subpath: string,
  conditions: readonly string[] = PANEL_CONDITIONS
): string {
  const normalized = subpath === "." ? "." : subpath.startsWith("./") ? subpath : `./${subpath}`;
  const pkgJsonPath = path.join(sourcePath, "package.json");
  if (!fs.existsSync(pkgJsonPath)) {
    throw new BuildRequestError(
      "package_manifest_missing",
      `No package.json found for ${node.name}`,
      { packageName: node.name, subpath: normalized, conditions: [...conditions] }
    );
  }

  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
    exports?: Record<string, unknown>;
  };
  const target = pkgJson.exports
    ? resolveExportSubpath(pkgJson.exports, normalized, conditions)
    : null;
  if (!target) {
    throw new BuildRequestError(
      "package_export_not_found",
      `No export ${normalized} found for ${node.name}`,
      { packageName: node.name, subpath: normalized, conditions: [...conditions] }
    );
  }

  const resolved = path.resolve(sourcePath, target);
  if (fs.existsSync(resolved)) return resolved;
  const srcFallback = resolveSourceFallback(sourcePath, target);
  if (srcFallback) return srcFallback;

  throw new BuildRequestError(
    "package_export_target_missing",
    `Export ${normalized} for ${node.name} resolves to missing file: ${target}`,
    {
      packageName: node.name,
      subpath: normalized,
      conditions: [...conditions],
      target,
    }
  );
}
