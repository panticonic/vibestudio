import { z } from "zod";
import { PanelEntityIdSchema, PanelSlotIdSchema } from "./panel/ids.js";
import type { PanelRuntimeLease } from "./panel/panelLease.js";
import type {
  PanelBootObservation,
  PanelBootProbeResult,
  PanelAttempt,
  PanelAttemptFailure,
  PanelAttemptRef,
  AwaitPanelAttemptResult,
  PanelSlotObservation,
  PanelConsoleHistoryObservation,
  PanelDiagnosticPacket,
  PanelHostObservation,
  PanelObservation,
  PanelPageObservation,
  PanelRuntimeFailure,
  PanelSnapshotObservation,
} from "./panel/observation.js";
import type {
  AppInfo,
  Panel,
  PanelArtifacts,
  PanelBuildStatus,
  PanelFocusResult,
  PanelLifecycleResult,
  PanelNavigationState,
  PanelRuntimeStatus,
  PanelSnapshot,
  PanelSnapshotHistory,
  PanelTreeSnapshot,
  PanelViewFailure,
  PanelViewStatus,
} from "./types.js";
import {
  THEME_ACCENT_COLORS,
  THEME_GRAY_COLORS,
  THEME_PANEL_BACKGROUNDS,
  THEME_RADII,
  THEME_SCALINGS,
  type ThemeConfig,
} from "./theme.js";

export const ThemeConfigSchema: z.ZodType<ThemeConfig> = z.object({
  accentColor: z.enum(THEME_ACCENT_COLORS),
  grayColor: z.enum(THEME_GRAY_COLORS),
  radius: z.enum(THEME_RADII),
  scaling: z.enum(THEME_SCALINGS),
  panelBackground: z.enum(THEME_PANEL_BACKGROUNDS),
});

export const AppInfoSchema: z.ZodType<AppInfo> = z.object({
  version: z.string(),
  connectionMode: z.enum(["local", "remote"]),
  remoteHost: z.string().optional(),
  connectionStatus: z.enum(["connected", "connecting", "disconnected"]),
  connectionCandidateType: z.enum(["host", "srflx", "prflx", "relay"]).nullable().optional(),
});

export const PanelFocusResultSchema: z.ZodType<PanelFocusResult> = z.object({
  panelId: z.string(),
  status: z.enum([
    "missing",
    "focused",
    "preparing",
    "loaded",
    "leased_elsewhere",
    "build_failed",
    "view_creation_failed",
  ]),
  focused: z.boolean(),
  loaded: z.boolean(),
  message: z.string().optional(),
  holderLabel: z.string().optional(),
});

export const PanelLifecycleResultSchema: z.ZodType<PanelLifecycleResult> = z.object({
  panelId: z.string(),
  operation: z.enum(["reload", "rebuild", "unload", "close"]),
  status: z.string(),
  loaded: z.boolean(),
  rebuilt: z.boolean(),
  reloaded: z.boolean(),
  buildRevision: z.number().optional(),
  effectiveVersion: z.string().nullable().optional(),
  closedCount: z.number().int().nonnegative().optional(),
});

export const PanelFailureCodeSchema = z.enum([
  "unit_not_found",
  "ref_not_found",
  "manifest_invalid",
  "dependency_resolution_failed",
  "compile_failed",
  "build_identity_invalid",
  "host_unavailable",
  "lease_conflict",
  "navigation_failed",
  "asset_unavailable",
  "entry_threw",
  "boot_stalled",
  "render_crashed",
  "panel_not_found",
  "unknown_failure",
]);
export const PanelFailureStageSchema = z.enum([
  "resolve",
  "build",
  "host",
  "load",
  "boot",
  "runtime",
]);

export const PanelRuntimeFailureSchema: z.ZodType<PanelRuntimeFailure> = z.object({
  code: PanelFailureCodeSchema,
  stage: PanelFailureStageSchema,
  message: z.string(),
  provenance: z.object({
    panelId: z.string().optional(),
    runtimeEntityId: z.string().nullable().optional(),
    attemptId: z.string().optional(),
    source: z.string(),
    contextId: z.string(),
    requestedRef: z.string(),
    stateHash: z.string().optional(),
    effectiveVersion: z.string().nullable().optional(),
    buildKey: z.string().nullable().optional(),
  }),
  diagnosticId: z.string(),
  occurredAt: z.number(),
  details: z.record(z.unknown()).optional(),
});

export const PanelBootObservationSchema: z.ZodType<PanelBootObservation> = z.object({
  phase: z.enum(["loading", "booting", "ready", "failed"]),
  runtimeEntityId: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  contextId: z.string().nullable().optional(),
  effectiveVersion: z.string().nullable().optional(),
  buildKey: z.string().nullable().optional(),
  message: z.string().optional(),
  errorName: z.string().optional(),
  stack: z.string().optional(),
  failureStage: z.enum(["config", "bundle-load", "entry"]).optional(),
  updatedAt: z.number().optional(),
});

export const PanelBootProbeResultSchema: z.ZodType<PanelBootProbeResult> = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("observed"), observation: PanelBootObservationSchema }).strict(),
    z.object({ kind: z.literal("unavailable") }).strict(),
  ]
);

export const PanelPageObservationSchema: z.ZodType<PanelPageObservation> = z
  .object({
    view: z
      .object({
        url: z.string(),
        loading: z.boolean(),
      })
      .strict(),
    boot: PanelBootProbeResultSchema,
  })
  .strict();

export const PanelAttemptRefSchema: z.ZodType<PanelAttemptRef> = z
  .object({ epoch: z.string().min(1), attemptId: z.string().min(1) })
  .strict();

export const PanelAttemptFailureSchema: z.ZodType<PanelAttemptFailure> = z
  .object({
    stage: z.enum([
      "build",
      "bundle-load",
      "config",
      "entry",
      "navigation",
      "renderer-crash",
      "boot-stall",
      "materialization",
    ]),
    code: PanelFailureCodeSchema,
    message: z.string().optional(),
    stack: z.string().optional(),
    detail: z.enum(["no-progress", "unobservable"]).optional(),
    diagnostics: z.record(z.unknown()).optional(),
  })
  .strict();

export const PanelAttemptSchema: z.ZodType<PanelAttempt> = z
  .object({
    epoch: z.string().min(1),
    attemptId: z.string().min(1),
    slotId: PanelSlotIdSchema,
    runtimeEntityId: PanelEntityIdSchema,
    buildKey: z.string().optional(),
    effectiveVersion: z.string().optional(),
    hostConnectionId: z.string().optional(),
    phase: z.enum(["pending", "loading", "booting", "ready", "failed", "stopped"]),
    revision: z.number().int().nonnegative(),
    failure: PanelAttemptFailureSchema.optional(),
    stopReason: z.enum(["superseded", "retired", "unloaded", "host-lost"]).optional(),
    reporter: z.enum(["coordinator", "build", "materialization", "renderer", "host"]),
    updatedAt: z.number(),
  })
  .strict();

export const AwaitPanelAttemptResultSchema: z.ZodType<AwaitPanelAttemptResult> =
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("report"), attempt: PanelAttemptSchema }).strict(),
    z.object({ kind: z.literal("unknown-attempt"), ref: PanelAttemptRefSchema }).strict(),
  ]);

export const PanelSlotObservationSchema: z.ZodType<PanelSlotObservation> = z
  .object({
    attempt: PanelAttemptSchema.nullable(),
    route: z
      .object({
        reachable: z.boolean(),
        connectionId: z.string().optional(),
        holderLabel: z.string().optional(),
        platform: z.enum(["desktop", "headless", "mobile"]).optional(),
        supportsCdp: z.boolean().optional(),
        view: z.object({ url: z.string(), loading: z.boolean() }).strict().optional(),
      })
      .strict(),
    build: z
      .object({
        state: z.enum(["building", "ready", "failed"]),
        buildKey: z.string().optional(),
      })
      .strict()
      .optional(),
    version: z
      .object({ epoch: z.string().min(1), counter: z.number().int().nonnegative() })
      .strict(),
  })
  .strict();

export const PanelHostObservationSchema: z.ZodType<PanelHostObservation> = z.object({
  holderLabel: z.string().optional(),
  platform: z.enum(["desktop", "headless", "mobile"]).optional(),
  supportsInspection: z.boolean().optional(),
  reachable: z.boolean().optional(),
  viewRevision: z.number().optional(),
  view: z.object({
    exists: z.boolean(),
    url: z.string().optional(),
    loading: z.boolean().optional(),
  }),
  boot: PanelBootProbeResultSchema,
  failure: z
    .object({
      code: PanelFailureCodeSchema,
      stage: PanelFailureStageSchema,
      message: z.string(),
      details: z.record(z.unknown()).optional(),
    })
    .optional(),
});

export const PanelObservationSchema: z.ZodType<PanelObservation> = z.object({
  panelId: z.string(),
  title: z.string(),
  source: z.string(),
  kind: z.enum(["workspace", "browser"]),
  parentId: z.string().nullable(),
  contextId: z.string(),
  requestedRef: z.string(),
  runtimeEntityId: z.string().nullable(),
  attemptId: z.string(),
  attemptRef: PanelAttemptRefSchema,
  effectiveVersion: z.string().nullable(),
  buildKey: z.string().nullable(),
  phase: z.enum(["pending", "loading", "booting", "ready", "failed", "stopped"]),
  failure: PanelRuntimeFailureSchema.optional(),
  host: PanelHostObservationSchema.optional(),
  updatedAt: z.number(),
});

export const PanelSnapshotObservationSchema: z.ZodType<PanelSnapshotObservation> = z.object({
  panelId: z.string(),
  attemptId: z.string(),
  runtimeEntityId: z.string(),
  buildKey: z.string().nullable(),
  capturedAt: z.number(),
  document: z.object({
    kind: z.literal("synth"),
    text: z.string(),
    structure: z.record(z.unknown()),
  }),
});

const PanelConsoleHistoryEntrySchema = z.object({
  timestamp: z.number(),
  level: z.enum(["debug", "info", "warning", "error", "unknown"]),
  message: z.string(),
  line: z.number(),
  sourceId: z.string(),
  url: z.string(),
  source: z.enum(["console", "lifecycle"]).optional(),
  fields: z.record(z.unknown()).optional(),
});

export const PanelConsoleHistoryObservationSchema: z.ZodType<PanelConsoleHistoryObservation> =
  z.discriminatedUnion("available", [
    z.object({
      available: z.literal(true),
      entries: z.array(PanelConsoleHistoryEntrySchema),
      errors: z.array(PanelConsoleHistoryEntrySchema),
      dropped: z.object({ entries: z.number(), errors: z.number() }),
      capacity: z.object({ entries: z.number(), errors: z.number() }),
    }),
    z.object({
      available: z.literal(false),
      error: z.string(),
    }),
  ]);

export const PanelDiagnosticPacketSchema: z.ZodType<PanelDiagnosticPacket> = z.object({
  observation: PanelObservationSchema,
  consoleHistory: PanelConsoleHistoryObservationSchema,
  document: PanelSnapshotObservationSchema.optional(),
});

export const PanelNavigationStateSchema: z.ZodType<PanelNavigationState> = z.object({
  url: z.string().optional(),
  pageTitle: z.string().optional(),
  favicon: z
    .object({
      pageUrl: z.string(),
      updatedAt: z.number(),
    })
    .optional(),
  isLoading: z.boolean().optional(),
  canGoBack: z.boolean().optional(),
  canGoForward: z.boolean().optional(),
  mediaPlaying: z.boolean().optional(),
});

export const MovePanelRequestSchema = z.object({
  panelId: z.string(),
  newParentId: z.string().nullable(),
  beforePanelId: z.string().nullable().optional(),
  afterPanelId: z.string().nullable().optional(),
});

export const PanelRuntimeLeaseSchema = z.object({
  slotId: PanelSlotIdSchema,
  runtimeEntityId: PanelEntityIdSchema,
  clientSessionId: z.string(),
  hostConnectionId: z.string(),
  connectionId: z.string(),
  holderLabel: z.string(),
  platform: z.enum(["desktop", "mobile", "headless"]),
  supportsCdp: z.boolean(),
  loadOnLeaseAssignment: z.boolean(),
  keepLoaded: z.boolean().optional(),
  acquiredAt: z.number(),
  expiresAt: z.number().optional(),
});

type Assert<T extends true> = T;
type _PanelRuntimeLeaseSchemaMatchesContract = Assert<
  z.output<typeof PanelRuntimeLeaseSchema> extends PanelRuntimeLease
    ? PanelRuntimeLease extends z.output<typeof PanelRuntimeLeaseSchema>
      ? true
      : false
    : false
>;

const PanelViewFailureSchema: z.ZodType<PanelViewFailure> = z.object({
  code: z.literal("navigation_failed"),
  message: z.string(),
});

const PanelArtifactsSchema: z.ZodType<PanelArtifacts> = z.object({
  htmlPath: z.string().optional(),
  hostedRuntimeEntityId: z.string().optional(),
  bundlePath: z.string().optional(),
  error: z.string().optional(),
  viewFailure: PanelViewFailureSchema.optional(),
  buildRevision: z.number().optional(),
  buildState: z.enum(["pending", "cloning", "building", "ready", "error"]).optional(),
  buildProgress: z.string().optional(),
  buildLog: z.string().optional(),
});

const PanelBuildStatusSchema: z.ZodType<PanelBuildStatus> = z.object({
  state: z.enum(["pending", "cloning", "building", "ready", "error"]).optional(),
  revision: z.number().optional(),
  artifactUrl: z.string().optional(),
  bundlePath: z.string().optional(),
  error: z.string().optional(),
  progress: z.string().optional(),
  log: z.string().optional(),
});

const PanelViewStatusSchema: z.ZodType<PanelViewStatus> = z.object({
  exists: z.boolean(),
  url: z.string().optional(),
  runtimeEntityId: z.string().optional(),
  visible: z.boolean().optional(),
  failure: PanelViewFailureSchema.optional(),
});

const PanelRuntimeStatusSchema: z.ZodType<PanelRuntimeStatus> = z.object({
  leased: z.boolean(),
  holderLabel: z.string().optional(),
  platform: z.enum(["desktop", "headless", "mobile"]).optional(),
  hostConnectionId: z.string().optional(),
  supportsCdp: z.boolean().optional(),
  clientSessionId: z.string().optional(),
  connectionId: z.string().optional(),
});

const PanelSnapshotSchema: z.ZodType<PanelSnapshot> = z.object({
  source: z.string(),
  contextId: z.string(),
  options: z.object({
    name: z.string().optional(),
    env: z.record(z.string()).optional(),
    ref: z.string().optional(),
    contextId: z.string().optional(),
  }),
  stateArgs: z.record(z.unknown()).optional(),
  resolvedUrl: z.string().optional(),
  autoArchiveWhenEmpty: z.boolean().optional(),
  privileged: z.boolean().optional(),
});

const PanelSnapshotHistorySchema: z.ZodType<PanelSnapshotHistory> = z.object({
  entries: z.array(PanelSnapshotSchema),
  index: z.number(),
});

export const PanelSchema: z.ZodType<Panel> = z.lazy(() =>
  z.object({
    id: z.string(),
    title: z.string(),
    icon: z.string().max(256).optional(),
    runtimeEntityId: z.string().nullable().optional(),
    effectiveVersion: z.string().nullable().optional(),
    buildKey: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable()
      .optional(),
    executionDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable()
      .optional(),
    authorityRequests: z
      .array(z.custom<import("./authorityManifest.js").UnitAuthorityRequest>())
      .optional(),
    owner: z.string().optional(),
    children: z.array(PanelSchema),
    selectedChildId: z.string().nullable().optional(),
    snapshot: PanelSnapshotSchema,
    history: PanelSnapshotHistorySchema.optional(),
    artifacts: PanelArtifactsSchema,
    state: z
      .object({
        build: PanelBuildStatusSchema,
        view: PanelViewStatusSchema,
        runtime: PanelRuntimeStatusSchema.optional(),
      })
      .optional(),
    navigation: PanelNavigationStateSchema.optional(),
  })
);

export const PanelTreeSnapshotSchema: z.ZodType<PanelTreeSnapshot> = z.object({
  revision: z.number(),
  forest: z.array(z.object({ owner: z.string(), rootPanels: z.array(PanelSchema) })),
});
