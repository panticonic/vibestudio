import { RpcBoundaryError, rpcErrorDataOf } from "@vibestudio/rpc";

export const PANEL_OPERATION_ERROR_CODE = "PANEL_OPERATION_FAILED";

export type AttemptPhase = "pending" | "loading" | "booting" | "ready" | "failed" | "stopped";
export type PanelRuntimePhase = AttemptPhase;

export type AttemptReporter = "coordinator" | "build" | "materialization" | "renderer" | "host";
export type AttemptFailureStage =
  | "build"
  | "bundle-load"
  | "config"
  | "entry"
  | "navigation"
  | "renderer-crash"
  | "boot-stall"
  | "materialization";

/** Renderer-side failure taxonomy carried in the boot record: the loader can
 *  distinguish an incomplete host config, a bundle that failed to load, and
 *  entry code that threw — the coordinator must not flatten these. */
export type PanelBootFailureStage = "config" | "bundle-load" | "entry";
export type StopReason = "superseded" | "retired" | "unloaded" | "host-lost";

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
  | "navigation_failed"
  | "asset_unavailable"
  | "entry_threw"
  | "boot_stalled"
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

export interface PanelOperationRecovery {
  sameInputRetry: "not-useful" | "reobserve-first";
  nextAction: "repair-and-rebuild" | "observe-and-reacquire";
}

export type PanelOperationFailureData = PanelRuntimeFailure & {
  failureKind: "user-code" | "infrastructure";
  recovery: PanelOperationRecovery;
};

export interface PanelBootObservation {
  phase: "loading" | "booting" | "ready" | "failed";
  runtimeEntityId?: string | null;
  source?: string | null;
  contextId?: string | null;
  effectiveVersion?: string | null;
  buildKey?: string | null;
  message?: string;
  errorName?: string;
  stack?: string;
  failureStage?: PanelBootFailureStage;
  updatedAt?: number;
}

/** Result of attempting to inspect a panel document's boot record. Probe
 * unavailability is transport/inspection state, not a boot lifecycle phase. */
export type PanelBootProbeResult =
  | { kind: "observed"; observation: PanelBootObservation }
  | { kind: "unavailable" };

/** Opaque coordinator identity. Attributes such as entity/build are deliberately not identity. */
export interface PanelAttemptRef {
  epoch: string;
  attemptId: string;
}

export interface PanelAttemptFailure {
  stage: AttemptFailureStage;
  code: PanelFailureCode;
  message?: string;
  stack?: string;
  detail?: "no-progress" | "unobservable";
  diagnostics?: Record<string, unknown>;
}

export interface PanelAttempt extends PanelAttemptRef {
  slotId: string;
  runtimeEntityId: string;
  buildKey?: string;
  effectiveVersion?: string;
  hostConnectionId?: string;
  phase: AttemptPhase;
  revision: number;
  failure?: PanelAttemptFailure;
  stopReason?: StopReason;
  reporter: AttemptReporter;
  updatedAt: number;
}

export type AwaitPanelAttemptResult =
  | { kind: "report"; attempt: PanelAttempt }
  | { kind: "unknown-attempt"; ref: PanelAttemptRef };

export interface PanelSlotObservation {
  attempt: PanelAttempt | null;
  route: {
    reachable: boolean;
    connectionId?: string;
    holderLabel?: string;
    platform?: "desktop" | "headless" | "mobile";
    supportsCdp?: boolean;
    view?: { url: string; loading: boolean };
  };
  build?: { state: "building" | "ready" | "failed"; buildKey?: string };
  version: { epoch: string; counter: number };
}

export interface PanelPageObservation {
  view: {
    url: string;
    loading: boolean;
  };
  boot: PanelBootProbeResult;
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
      : null;
  return {
    view: {
      url: typeof globalThis.location?.href === "string" ? globalThis.location.href : "",
      loading: globalThis.document?.readyState === "loading",
    },
    boot: phase === null ? { kind: "unavailable" } : { kind: "observed", observation: {
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
      failureStage:
        boot?.failureStage === "config" ||
        boot?.failureStage === "bundle-load" ||
        boot?.failureStage === "entry"
          ? boot.failureStage
          : undefined,
    }},
  };
})()`;

export function parsePanelPageObservation(value: unknown): PanelPageObservation {
  if (!isRecord(value)) {
    throw new Error("Panel page observation is missing view or boot state");
  }
  const view = value["view"];
  const bootProbe = value["boot"];
  if (!isRecord(view) || !isRecord(bootProbe)) {
    throw new Error("Panel page observation is missing view or boot state");
  }
  if (typeof view["url"] !== "string" || typeof view["loading"] !== "boolean") {
    throw new Error("Panel page observation has invalid view state");
  }
  if (bootProbe["kind"] === "unavailable") {
    return { view: { url: view["url"], loading: view["loading"] }, boot: { kind: "unavailable" } };
  }
  const boot = bootProbe["observation"];
  if (bootProbe["kind"] !== "observed" || !isRecord(boot)) {
    throw new Error("Panel page observation has invalid boot probe result");
  }
  const phase = boot["phase"];
  if (phase !== "loading" && phase !== "booting" && phase !== "ready" && phase !== "failed") {
    throw new Error("Panel page observation has invalid boot phase");
  }
  return {
    view: {
      url: view["url"],
      loading: view["loading"],
    },
    boot: {
      kind: "observed",
      observation: {
        phase,
        ...optionalNullableString(boot, "runtimeEntityId"),
        ...optionalNullableString(boot, "source"),
        ...optionalNullableString(boot, "contextId"),
        ...optionalNullableString(boot, "effectiveVersion"),
        ...optionalNullableString(boot, "buildKey"),
        ...optionalString(boot, "message"),
        ...optionalString(boot, "errorName"),
        ...optionalString(boot, "stack"),
        ...(boot["failureStage"] === "config" ||
        boot["failureStage"] === "bundle-load" ||
        boot["failureStage"] === "entry"
          ? { failureStage: boot["failureStage"] }
          : {}),
        ...(typeof boot["updatedAt"] === "number" ? { updatedAt: boot["updatedAt"] } : {}),
      },
    },
  };
}

export interface PanelHostObservation {
  holderLabel?: string;
  platform?: "desktop" | "headless" | "mobile";
  supportsInspection?: boolean;
  reachable?: boolean;
  /** Monotonic host-local revision bumped whenever native panel views mutate. */
  viewRevision?: number;
  view: {
    exists: boolean;
    url?: string;
    loading?: boolean;
  };
  boot: PanelBootProbeResult;
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
  attemptRef: PanelAttemptRef;
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
  readonly errorKind = "application";
  readonly errorData: PanelOperationFailureData;

  constructor(
    public readonly failure: PanelRuntimeFailure,
    cause?: unknown
  ) {
    super(`${failure.stage}: ${failure.message}`);
    this.name = "PanelOperationError";
    const repairRequired = new Set<PanelFailureCode>([
      "unit_not_found",
      "ref_not_found",
      "manifest_invalid",
      "dependency_resolution_failed",
      "compile_failed",
      "build_identity_invalid",
      "asset_unavailable",
      "entry_threw",
    ]).has(failure.code);
    this.errorData = {
      ...failure,
      failureKind: repairRequired ? "user-code" : "infrastructure",
      recovery: repairRequired
        ? { sameInputRetry: "not-useful", nextAction: "repair-and-rebuild" }
        : { sameInputRetry: "reobserve-first", nextAction: "observe-and-reacquire" },
    };
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
