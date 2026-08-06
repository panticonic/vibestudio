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
import type {
  TypeCheckDiagnostic,
  WorkspaceContext,
  WorkspacePackageInfo,
} from "@vibestudio/typecheck";
import type { PackageManifest } from "@vibestudio/shared/types";
import { workspaceDiagnosticPath, type BuildDiagnostic } from "./diagnostics.js";
import { authorityDiagnosticsForProgram } from "./authorityFold.js";
import type { ExactWorkspaceAuthorityEnvironment } from "./userlandAuthority.js";

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

/** Create the exact TypeScript program used by the report fold. */
export async function typecheckProgramForUnit(
  unitRelativePath: string,
  sourceRoot: string,
  internalDeps: TypecheckUnitDep[],
  nodeModulesPaths: string[]
): Promise<import("typescript").Program> {
  const { TypeCheckService, createDiskFileSource, loadSourceFiles } =
    await import("@vibestudio/typecheck");
  const unitDir = path.join(sourceRoot, unitRelativePath);
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
  const service = new TypeCheckService({
    panelPath: unitDir,
    workspaceContext: { monorepoRoot: sourceRoot, packages },
    nodeModulesPaths,
    tsconfigSearchBoundary: unitDir,
  });
  const files = await loadSourceFiles(createDiskFileSource(unitDir), ".");
  for (const [relPath, content] of files) {
    service.updateFile(path.resolve(unitDir, relPath), content);
  }
  const program = service.getProgram();
  if (!program) throw new Error("Typecheck could not obtain the exact TypeScript program");
  return program;
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
 * Typecheck failures are build failures. A broken typecheck engine or an
 * unavailable materialized source is represented as an error diagnostic rather
 * than being silently treated as a clean build; protected-main publication
 * relies on this fail-closed behavior.
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
  nodeModulesPaths: string[],
  authority?: {
    manifest: PackageManifest;
    environment?: ExactWorkspaceAuthorityEnvironment;
    workspaceId?: string;
    executableModules?: readonly {
      moduleId: string;
      contentDigest: string;
      package:
        | { kind: "first-party" }
        | { kind: "workspace"; name: string; effectiveVersion: string }
        | { kind: "external"; name: string; version: string; packageDigest: string };
      format: "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs";
      source: string;
    }[];
  }
): Promise<BuildDiagnostic[]> {
  const unitDir = path.join(sourceRoot, unitRelativePath);
  try {
    const { TypeCheckService, createDiskFileSource, loadSourceFiles } =
      await import("@vibestudio/typecheck");
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
    const diagnostics = result.diagnostics
      .filter((d) => d.severity === "error" || d.severity === "warning")
      .map((d) => toBuildDiagnostic(d, sourceRoot, unitRelativePath));
    if (authority) {
      const program = service.getProgram();
      if (!program) {
        diagnostics.push({
          source: "authority",
          severity: "error",
          file: `${unitRelativePath}/package.json`,
          line: 1,
          column: 1,
          message: "Authority analysis could not obtain the exact TypeScript program.",
        });
      } else {
        try {
          diagnostics.push(
            ...(await authorityDiagnosticsForProgram({
              program,
              sourceRoot,
              unitRelativePath,
              units: internalDeps,
              manifest: authority.manifest,
              environment: authority.environment,
              workspaceId: authority.workspaceId,
              executableModules: authority.executableModules,
            }))
          );
        } catch (error) {
          diagnostics.push({
            source: "authority",
            severity: "error",
            file: `${unitRelativePath}/package.json`,
            line: 1,
            column: 1,
            message: `Authority analysis could not resolve the exact provider catalog: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    }
    return diagnostics;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[BuildV2] typecheck fold-in failed for ${unitRelativePath}:`, message);
    return [
      {
        source: "tsc",
        severity: "error",
        file: unitRelativePath,
        line: 1,
        column: 1,
        message: `Typecheck could not complete: ${message}`,
      },
    ];
  }
}
