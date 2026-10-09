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
import * as fs from "node:fs";
import * as path from "path";
import { RpcBoundaryError } from "@vibestudio/rpc";
import type {
  AgentDiagnosticRepairWire,
  WorkspaceTestPlan,
} from "@vibestudio/service-schemas/build";

/**
 * A caller-correctable build request failure. The structured payload survives
 * every RPC relay so eval and other callers never parse display text to decide
 * whether a package name/subpath was invalid.
 */
export class BuildRequestError extends RpcBoundaryError {
  constructor(code: string, message: string, details: Record<string, unknown>) {
    super(message, "application", code, undefined, {
      ...details,
      code,
      failureKind: "invalid-input",
      retry: { policy: "correct-input", commandIdPolicy: "not-applicable" },
      recovery: {
        action: "correct-request",
        instruction:
          "Inspect the structured request details and the unit's declarations, correct the request or source, then verify again.",
      },
    });
    this.name = "BuildRequestError";
  }
}

/**
 * Machine-readable repair attached by the canonical analyzer that decided the
 * failure (structural twin of the wire `agentDiagnosticRepairSchema`). Edit
 * DATA for the author — nothing downstream applies it, grants the request, or
 * reruns verification.
 */
export type AgentDiagnosticRepair = AgentDiagnosticRepairWire;

export interface BuildDiagnostic {
  source: "esbuild" | "tsc" | "authority" | "schema" | "infrastructure";
  severity: "error" | "warning";
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  /** Preserve the producer's diagnostic identity instead of parsing prose. */
  compilerCode?: number;
  lineText?: string;
  suggestion?: string;
  repair?: AgentDiagnosticRepair;
}

export interface DiagnosticPathContext {
  workspaceRoot?: string;
  sourceRoot?: string | null;
  unitRelativePath?: string;
  /** The compiler's declared base for relative physical file locations. */
  workingDirectory?: string;
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

/** The compiler owns this refusal; no test artifact or execution was produced. */
export class TestCompilationFailedError extends RpcBoundaryError {
  constructor(error: BuildDiagnosticsError, plan: Omit<WorkspaceTestPlan, "protocol">) {
    super(error.message, "application", "TestCompilationFailed", error, {
      code: "TestCompilationFailed",
      ...plan,
      diagnostics: error.diagnostics,
    });
    this.name = "TestCompilationFailedError";
  }
}

/** Structured refusal raised when publication's exact candidate build gate fails. */
export class BuildGateFailedError extends RpcBoundaryError {
  constructor(diagnostics: BuildDiagnostic[], affectedUnits: string[], candidateState: string) {
    const errorDiagnostics = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    const firstError = errorDiagnostics[0];
    const summary = firstError
      ? `${firstError.file || firstError.source}${firstError.line > 0 ? `:${firstError.line}` : ""}: ${firstError.message}`
      : "";
    const boundedSummary = summary.length > 600 ? `${summary.slice(0, 600)}…` : summary;
    const message =
      `Protected main push rejected: build/typecheck gate failed for candidate ${candidateState}` +
      (boundedSummary ? `\n${boundedSummary}` : "") +
      (errorDiagnostics.length > 1
        ? `\n${errorDiagnostics.length - 1} more ${errorDiagnostics.length === 2 ? "error" : "errors"}; see the structured diagnostics.`
        : "");
    const hasInfrastructureFailure = errorDiagnostics.some(
      (diagnostic) => diagnostic.source === "infrastructure"
    );
    const hasSourceFailure = errorDiagnostics.some(
      (diagnostic) => diagnostic.source !== "infrastructure"
    );
    const failureClass =
      hasInfrastructureFailure && hasSourceFailure
        ? "mixed"
        : hasInfrastructureFailure
          ? "infrastructure"
          : "source";
    const sourceRecovery =
      "Repair the reported source or authority diagnostics, rebuild the candidate, then push the new candidate.";
    const infrastructureRecovery =
      "Re-run build verification after the infrastructure failure is resolved, then push with a new command identity.";
    super(message, "application", "BuildGateFailed", undefined, {
      code: "BuildGateFailed",
      message,
      candidateState,
      affectedUnits,
      diagnostics,
      failureClass,
      failureKind: failureClass === "infrastructure" ? "infrastructure" : "domain",
      retry:
        failureClass === "infrastructure"
          ? { policy: "reobserve", commandIdPolicy: "use-new-after-reobserve" }
          : { policy: "none", commandIdPolicy: "not-applicable" },
      recovery: {
        action: failureClass === "infrastructure" ? "reobserve" : "repair-source",
        instruction:
          failureClass === "mixed"
            ? `${infrastructureRecovery} ${sourceRecovery}`
            : failureClass === "infrastructure"
              ? infrastructureRecovery
              : sourceRecovery,
      },
    });
    this.name = "BuildGateFailedError";
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
  const physical = (value: string): string => {
    try {
      return fs.realpathSync.native(value);
    } catch {
      return path.resolve(value);
    }
  };
  const rel = path.relative(physical(root), physical(file));
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
  if (!path.isAbsolute(file) && context.workingDirectory) {
    file = path.resolve(context.workingDirectory, file);
  }
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
