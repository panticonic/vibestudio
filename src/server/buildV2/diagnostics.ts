/**
 * Structured build diagnostics — agent-actionable error contract.
 *
 * Today the build catch path reduced every esbuild failure to `error.message`,
 * throwing away the rich `BuildFailure.errors[]`/`.warnings[]` esbuild already
 * produces (each carrying `text` + `location:{ file, line, column, lineText,
 * suggestion }`). This module captures those into `BuildDiagnostic[]` so the
 * explicit reports, the async state-trigger path, and the typecheck fold-in all
 * speak one type the agent parses uniformly.
 *
 * `BuildDiagnostic` mirrors the typecheck service's `BaseDiagnostic` shape
 * (position + severity) plus a `source` discriminator.
 */

import type * as esbuild from "esbuild";
import * as path from "path";
import { RpcBoundaryError } from "@vibestudio/rpc";

/**
 * A caller-correctable build request failure. The structured payload survives
 * every RPC relay so eval and other callers never parse display text to decide
 * whether a package name/subpath was invalid.
 */
export class BuildRequestError extends RpcBoundaryError {
  constructor(code: string, message: string, details: Record<string, unknown>) {
    super(message, "application", code, undefined, { code, ...details });
    this.name = "BuildRequestError";
  }
}

export interface BuildDiagnostic {
  source: "esbuild" | "tsc";
  severity: "error" | "warning";
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  lineText?: string;
  suggestion?: string;
}

export interface DiagnosticPathContext {
  workspaceRoot?: string;
  sourceRoot?: string | null;
  unitRelativePath?: string;
}

/**
 * A build error that carries structured diagnostics alongside its summary
 * message. Thrown from build paths so callers and the state trigger can recover
 * per-line diagnostics instead of only `error.message`.
 */
export class BuildDiagnosticsError extends Error {
  readonly diagnostics: BuildDiagnostic[];
  constructor(message: string, diagnostics: BuildDiagnostic[]) {
    super(message);
    this.name = "BuildDiagnosticsError";
    this.diagnostics = diagnostics;
  }
}

function normalizePathContext(
  contextOrWorkspaceRoot?: string | DiagnosticPathContext
): DiagnosticPathContext {
  if (typeof contextOrWorkspaceRoot === "string") {
    return { workspaceRoot: contextOrWorkspaceRoot };
  }
  return contextOrWorkspaceRoot ?? {};
}

function slashPath(file: string): string {
  return file.replace(/\\/g, "/");
}

function relUnderRoot(file: string, root?: string | null): string | null {
  if (!root || !path.isAbsolute(file)) return null;
  const rel = path.relative(root, file);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return slashPath(rel);
  }
  return null;
}

/**
 * Convert diagnostic file paths to the workspace coordinate system callers can
 * edit. Build failures often originate in an immutable materialized source
 * root rather than the live workspace, so both roots are accepted.
 */
export function workspaceDiagnosticPath(
  file: string,
  contextOrWorkspaceRoot?: string | DiagnosticPathContext
): string {
  if (!file) return file;
  const context = normalizePathContext(contextOrWorkspaceRoot);
  if (path.isAbsolute(file)) {
    return (
      relUnderRoot(file, context.sourceRoot) ??
      relUnderRoot(file, context.workspaceRoot) ??
      slashPath(file)
    );
  }

  const rel = slashPath(file).replace(/^\.\//, "");
  const unitRelativePath = context.unitRelativePath
    ? slashPath(context.unitRelativePath).replace(/^\/+|\/+$/g, "")
    : "";
  if (
    unitRelativePath &&
    rel &&
    !rel.startsWith("../") &&
    rel !== unitRelativePath &&
    !rel.startsWith(`${unitRelativePath}/`)
  ) {
    return `${unitRelativePath}/${rel}`;
  }
  return rel;
}

/** Map a single esbuild Message → BuildDiagnostic. */
function esbuildMessageToDiagnostic(
  msg: esbuild.Message,
  severity: "error" | "warning",
  contextOrWorkspaceRoot?: string | DiagnosticPathContext
): BuildDiagnostic {
  const loc = msg.location;
  const suggestion =
    loc?.suggestion && loc.suggestion.length > 0
      ? loc.suggestion
      : (msg.notes ?? [])
          .map((n) => n.text)
          .filter(Boolean)
          .join("; ") || undefined;
  return {
    source: "esbuild",
    severity,
    file: workspaceDiagnosticPath(loc?.file ?? "", contextOrWorkspaceRoot),
    // esbuild line is 1-based; column is 0-based byte offset on the line.
    line: loc?.line ?? 0,
    column: loc?.column ?? 0,
    endColumn:
      loc && typeof loc.length === "number" && loc.length > 0 ? loc.column + loc.length : undefined,
    message: msg.text,
    lineText: loc?.lineText || undefined,
    suggestion,
  };
}

/**
 * Extract structured diagnostics from an unknown error thrown by an esbuild
 * build. Recognizes esbuild's `BuildFailure` (with `.errors`/`.warnings`),
 * our own `BuildDiagnosticsError`, and falls back to a single synthetic
 * diagnostic carrying `error.message`.
 */
export function diagnosticsFromError(
  error: unknown,
  contextOrWorkspaceRoot?: string | DiagnosticPathContext
): BuildDiagnostic[] {
  if (error instanceof BuildDiagnosticsError) {
    return error.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      file: workspaceDiagnosticPath(diagnostic.file, contextOrWorkspaceRoot),
    }));
  }

  const failure = error as Partial<esbuild.BuildFailure> | undefined;
  const out: BuildDiagnostic[] = [];
  if (failure && Array.isArray(failure.errors)) {
    for (const msg of failure.errors) {
      out.push(esbuildMessageToDiagnostic(msg, "error", contextOrWorkspaceRoot));
    }
  }
  if (failure && Array.isArray(failure.warnings)) {
    for (const msg of failure.warnings) {
      out.push(esbuildMessageToDiagnostic(msg, "warning", contextOrWorkspaceRoot));
    }
  }
  if (out.length > 0) return out;

  const message = error instanceof Error ? error.message : String(error);
  return [
    {
      source: "esbuild",
      severity: "error",
      file: "",
      line: 0,
      column: 0,
      message,
    },
  ];
}

/** Map an esbuild build result's `warnings` into BuildDiagnostic warnings. */
export function warningsFromResult(
  result: { warnings?: readonly esbuild.Message[] } | undefined,
  contextOrWorkspaceRoot?: string | DiagnosticPathContext
): BuildDiagnostic[] {
  if (!result?.warnings || result.warnings.length === 0) return [];
  return result.warnings.map((w) =>
    esbuildMessageToDiagnostic(w, "warning", contextOrWorkspaceRoot)
  );
}

/** Whether a diagnostics list contains any errors. */
export function hasErrors(diagnostics: readonly BuildDiagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}
