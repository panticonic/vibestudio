/**
 * Typecheck fold-in for exact-state unit build reports.
 *
 * esbuild bundles, but it does not type-check. The report path runs the TypeScript
 * language service (via `@vibestudio/typecheck`, the same engine the typecheck
 * service extension wraps) over the unit's materialized source and merges its
 * diagnostics (`source:"tsc"`) into the build report, surfacing compile and type
 * errors in one actionable list.
 *
 * The unit is type-checked against the materialized build source root (the same
 * immutable GAD state the build was produced from), so type diagnostics line up
 * with the bytes that were built.
 */

import * as path from "path";
import * as fsp from "fs/promises";
import {
  TypeCheckService,
  createDiskFileSource,
  loadSourceFiles,
  type TypeCheckDiagnostic,
  type WorkspaceContext,
  type WorkspacePackageInfo,
} from "@vibestudio/typecheck";
import { workspaceDiagnosticPath, type BuildDiagnostic } from "./diagnostics.js";

/** A materialized internal-dep unit — package name + workspace-relative path,
 *  both taken from the build package graph. */
export interface TypecheckUnitDep {
  name: string;
  relativePath: string;
}

async function readPackageJson(dir: string): Promise<WorkspacePackageInfo["packageJson"] | null> {
  try {
    const raw = await fsp.readFile(path.join(dir, "package.json"), "utf8");
    return JSON.parse(raw) as WorkspacePackageInfo["packageJson"];
  } catch {
    return null;
  }
}

function toBuildDiagnostic(
  d: TypeCheckDiagnostic,
  sourceRoot: string,
  unitRelativePath: string
): BuildDiagnostic {
  return {
    source: "tsc",
    // The typecheck engine emits "error" | "warning" | "info"; collapse info→warning.
    severity: d.severity === "error" ? "error" : "warning",
    file: workspaceDiagnosticPath(d.file, { sourceRoot, unitRelativePath }),
    line: d.line,
    column: d.column,
    endLine: d.endLine,
    endColumn: d.endColumn,
    message: d.message,
  };
}

/**
 * Type-check a single unit's materialized sources and return BuildDiagnostics.
 * Best-effort: on any internal failure returns [] so a typecheck-engine failure
 * does not hide the esbuild result.
 *
 * The materialized build source root is a BARE partial checkout — the unit plus
 * its workspace-dependency source subtrees, with NO `node_modules` and NO
 * `pnpm-workspace.yaml`. So module resolution must be provisioned explicitly
 * (mirroring esbuild), NOT left to `discoverWorkspaceContext` + TS's node_modules
 * walk, which would find nothing and report "Cannot find module" for EVERY
 * import (`react`, `@workspace/*`, `@radix-ui/*` …):
 *   • `workspaceContext` is built from the materialized internal-dep subtrees so
 *     `@workspace/*` resolves to their source (their `exports` point at `./src/*.ts`);
 *   • `nodeModulesPaths` is the app's node_modules (the same roots esbuild uses)
 *     so external deps + their `@types/*` resolve.
 *
 * @param internalDeps the unit + its transitive internal deps (from the graph).
 * @param nodeModulesPaths the app node_modules roots (external dep types).
 */
export async function typecheckUnit(
  unitRelativePath: string,
  sourceRoot: string,
  internalDeps: TypecheckUnitDep[],
  nodeModulesPaths: string[]
): Promise<BuildDiagnostic[]> {
  const unitDir = path.join(sourceRoot, unitRelativePath);
  try {
    const packages = new Map<string, WorkspacePackageInfo>();
    for (const dep of internalDeps) {
      const dir = path.join(sourceRoot, dep.relativePath);
      const packageJson = await readPackageJson(dir);
      const name = packageJson?.name ?? dep.name;
      if (!name) continue;
      packages.set(name, {
        name,
        dir,
        packageJson: packageJson ?? ({ name } as WorkspacePackageInfo["packageJson"]),
      });
    }
    const workspaceContext: WorkspaceContext = { monorepoRoot: sourceRoot, packages };
    const service = new TypeCheckService({
      panelPath: unitDir,
      workspaceContext,
      nodeModulesPaths,
      // Repository-view builds are hermetic at the unit/dependency closure.
      // A unit without its own config uses deterministic defaults; it must not
      // walk into a broader checkout and inherit unrelated workspace settings.
      tsconfigSearchBoundary: unitDir,
    });
    const files = await loadSourceFiles(createDiskFileSource(unitDir), ".");
    for (const [relPath, content] of files) {
      service.updateFile(path.resolve(unitDir, relPath), content);
    }
    const result = service.check();
    return result.diagnostics
      .filter((d) => d.severity === "error" || d.severity === "warning")
      .map((d) => toBuildDiagnostic(d, sourceRoot, unitRelativePath));
  } catch (err) {
    console.warn(
      `[BuildV2] typecheck fold-in failed for ${unitRelativePath}:`,
      err instanceof Error ? err.message : String(err)
    );
    return [];
  }
}
