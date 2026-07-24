import { RpcBoundaryError, rpcErrorDataOf } from "@vibestudio/rpc";

export const PANEL_OPERATION_ERROR_CODE = "PANEL_OPERATION_FAILED";

export type PanelRuntimePhase =
  | "resolving"
  | "building"
  | "assigning-host"
  | "loading"
  | "booting"
  | "ready"
  | "failed"
  | "stopped";

export type PanelFailureStage = "resolve" | "build" | "host" | "load" | "boot" | "runtime";

export type PanelFailureCode =
  | "unit_not_found"
  | "ref_not_found"
  | "manifest_invalid"
  | "dependency_resolution_failed"
  | "compile_failed"
  | "build_identity_invalid"
  | "host_unavailable"
  | "lease_conflict"
  | "parent_resolution_timeout"
  | "navigation_failed"
  | "asset_unavailable"
  | "entry_threw"
  | "runtime_handshake_timeout"
  | "render_crashed"
  | "panel_not_found"
  | "unknown_failure";

export interface PanelFailureProvenance {
  panelId?: string;
  runtimeEntityId?: string | null;
  attemptId?: string;
  source: string;
  contextId: string;
  requestedRef: string;
  stateHash?: string;
  effectiveVersion?: string | null;
  buildKey?: string | null;
}

export interface PanelRuntimeFailure {
  code: PanelFailureCode;
  stage: PanelFailureStage;
  message: string;
  provenance: PanelFailureProvenance;
  diagnosticId: string;
  occurredAt: number;
  details?: Record<string, unknown>;
}

export interface PanelBootObservation {
  phase: "unavailable" | "loading" | "booting" | "ready" | "failed";
  runtimeEntityId?: string | null;
  source?: string | null;
  contextId?: string | null;
  effectiveVersion?: string | null;
  buildKey?: string | null;
  message?: string;
  errorName?: string;
  stack?: string;
  updatedAt?: number;
}

export interface PanelPageObservation {
  view: {
    url: string;
    loading: boolean;
  };
  boot: PanelBootObservation;
}

/**
 * The one browser-side probe used by every inspecting panel host.
 *
 * Readiness must not vary by shell: Electron and the standalone headless host
 * execute this exact expression and parse its result through
 * `parsePanelPageObservation`.
 */
export const PANEL_PAGE_OBSERVATION_EXPRESSION = `(() => {
  const candidate = globalThis.__vibestudioPanelBoot;
  const boot = candidate && typeof candidate === "object" ? candidate : null;
  const phase =
    boot?.phase === "loading" ||
    boot?.phase === "booting" ||
    boot?.phase === "ready" ||
    boot?.phase === "failed"
      ? boot.phase
      : "unavailable";
  return {
    view: {
      url: typeof globalThis.location?.href === "string" ? globalThis.location.href : "",
      loading: globalThis.document?.readyState === "loading",
    },
    boot: {
      phase,
      runtimeEntityId:
        typeof boot?.runtimeEntityId === "string" ? boot.runtimeEntityId : null,
      source: typeof boot?.source === "string" ? boot.source : null,
      contextId: typeof boot?.contextId === "string" ? boot.contextId : null,
      effectiveVersion:
        typeof boot?.effectiveVersion === "string" ? boot.effectiveVersion : null,
      buildKey: typeof boot?.buildKey === "string" ? boot.buildKey : null,
      updatedAt: typeof boot?.updatedAt === "number" ? boot.updatedAt : undefined,
      message: typeof boot?.error?.message === "string" ? boot.error.message : undefined,
      errorName: typeof boot?.error?.name === "string" ? boot.error.name : undefined,
      stack: typeof boot?.error?.stack === "string" ? boot.error.stack : undefined,
    },
  };
})()`;

export function parsePanelPageObservation(value: unknown): PanelPageObservation {
  if (!isRecord(value)) {
    throw new Error("Panel page observation is missing view or boot state");
  }
  const view = value["view"];
  const boot = value["boot"];
  if (!isRecord(view) || !isRecord(boot)) {
    throw new Error("Panel page observation is missing view or boot state");
  }
  if (typeof view["url"] !== "string" || typeof view["loading"] !== "boolean") {
    throw new Error("Panel page observation has invalid view state");
  }
  const phase = boot["phase"];
  if (
    phase !== "unavailable" &&
    phase !== "loading" &&
    phase !== "booting" &&
    phase !== "ready" &&
    phase !== "failed"
  ) {
    throw new Error("Panel page observation has invalid boot phase");
  }
  return {
    view: {
      url: view["url"],
      loading: view["loading"],
    },
    boot: {
      phase,
      ...optionalNullableString(boot, "runtimeEntityId"),
      ...optionalNullableString(boot, "source"),
      ...optionalNullableString(boot, "contextId"),
      ...optionalNullableString(boot, "effectiveVersion"),
      ...optionalNullableString(boot, "buildKey"),
      ...optionalString(boot, "message"),
      ...optionalString(boot, "errorName"),
      ...optionalString(boot, "stack"),
      ...(typeof boot["updatedAt"] === "number" ? { updatedAt: boot["updatedAt"] } : {}),
    },
  };
}

export interface PanelHostObservation {
  holderLabel?: string;
  platform?: "desktop" | "headless" | "mobile";
  supportsInspection?: boolean;
  view: {
    exists: boolean;
    url?: string;
    loading?: boolean;
  };
  boot: PanelBootObservation;
  failure?: {
    code: PanelFailureCode;
    stage: PanelFailureStage;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface PanelObservation {
  panelId: string;
  title: string;
  source: string;
  kind: "workspace" | "browser";
  parentId: string | null;
  contextId: string;
  requestedRef: string;
  runtimeEntityId: string | null;
  attemptId: string;
  effectiveVersion: string | null;
  buildKey: string | null;
  phase: PanelRuntimePhase;
  failure?: PanelRuntimeFailure;
  host?: PanelHostObservation;
  updatedAt: number;
}

export interface PanelCapturedDocument {
  kind: "synth";
  text: string;
  structure: Record<string, unknown>;
}

export interface PanelSnapshotObservation {
  panelId: string;
  attemptId: string;
  runtimeEntityId: string;
  buildKey: string | null;
  capturedAt: number;
  document: PanelCapturedDocument;
}

export type PanelConsoleHistoryLevel = "debug" | "info" | "warning" | "error" | "unknown";

export interface PanelConsoleHistoryEntry {
  timestamp: number;
  level: PanelConsoleHistoryLevel;
  message: string;
  line: number;
  sourceId: string;
  url: string;
  source?: "console" | "lifecycle";
  fields?: Record<string, unknown>;
}

export interface PanelConsoleHistoryResult {
  entries: PanelConsoleHistoryEntry[];
  errors: PanelConsoleHistoryEntry[];
  dropped: { entries: number; errors: number };
  capacity: { entries: number; errors: number };
}

export type PanelConsoleHistoryObservation =
  | ({ available: true } & PanelConsoleHistoryResult)
  | { available: false; error: string };

export interface PanelDiagnosticPacket {
  observation: PanelObservation;
  consoleHistory: PanelConsoleHistoryObservation;
  document?: PanelSnapshotObservation;
}

export function panelAttemptId(
  runtimeEntityId: string | null | undefined,
  buildKey: string | null | undefined
): string {
  return `${runtimeEntityId ?? "unassigned"}@${buildKey ?? "unbuilt"}`;
}

export function panelDiagnosticId(
  provenance: Pick<PanelFailureProvenance, "panelId" | "runtimeEntityId" | "buildKey">,
  stage: PanelFailureStage
): string {
  const identity =
    provenance.panelId ?? provenance.runtimeEntityId ?? provenance.buildKey ?? "unknown-panel";
  return `panel:${identity}:${stage}`;
}

export function panelFailure(input: {
  code: PanelFailureCode;
  stage: PanelFailureStage;
  message: string;
  provenance: PanelFailureProvenance;
  details?: Record<string, unknown>;
  occurredAt?: number;
}): PanelRuntimeFailure {
  return {
    code: input.code,
    stage: input.stage,
    message: input.message,
    provenance: input.provenance,
    diagnosticId: panelDiagnosticId(input.provenance, input.stage),
    occurredAt: input.occurredAt ?? Date.now(),
    ...(input.details ? { details: input.details } : {}),
  };
}

export function panelFailureBoundaryError(
  failure: PanelRuntimeFailure,
  cause?: unknown
): RpcBoundaryError {
  return new RpcBoundaryError(
    `${failure.stage}: ${failure.message}`,
    "application",
    PANEL_OPERATION_ERROR_CODE,
    cause,
    failure
  );
}

export function panelFailureFromError(error: unknown): PanelRuntimeFailure | null {
  const data = rpcErrorDataOf(error);
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const candidate = data as Partial<PanelRuntimeFailure>;
  if (
    typeof candidate.code !== "string" ||
    typeof candidate.stage !== "string" ||
    typeof candidate.message !== "string" ||
    !candidate.provenance ||
    typeof candidate.provenance !== "object"
  ) {
    return null;
  }
  return candidate as PanelRuntimeFailure;
}

export class PanelOperationError extends Error {
  readonly code = PANEL_OPERATION_ERROR_CODE;

  constructor(
    public readonly failure: PanelRuntimeFailure,
    cause?: unknown
  ) {
    super(`${failure.stage}: ${failure.message}`);
    this.name = "PanelOperationError";
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: cause,
        writable: true,
        configurable: true,
      });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString<K extends string>(
  record: Record<string, unknown>,
  key: K
): { [P in K]?: string } {
  const value = record[key];
  return typeof value === "string" ? ({ [key]: value } as { [P in K]?: string }) : {};
}

function optionalNullableString<K extends string>(
  record: Record<string, unknown>,
  key: K
): { [P in K]?: string | null } {
  const value = record[key];
  return typeof value === "string" || value === null
    ? ({ [key]: value } as { [P in K]?: string | null })
    : {};
}

export function rethrowPanelOperationError(error: unknown): never {
  const failure = panelFailureFromError(error);
  if (failure) throw new PanelOperationError(failure, error);
  throw error;
}
