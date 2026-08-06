/**
 * Public runtime GAD contract.
 *
 * This table is the source of truth for the typed runtime client and the
 * portable runtime member list. The owning Durable Object still implements
 * persistence, authorization, and transactions; this file owns only the
 * serializable RPC boundary.
 */

import { z } from "zod";
import {
  channelEnvelopePageSchema,
  ChannelEnvelopePageRequestSchema,
} from "@vibestudio/shared/channelEnvelopePaging";
import type { GadRuntimeMethodName } from "@vibestudio/shared/gadRuntimeMethods";
import {
  defineServiceMethods,
  type MethodSchema,
  type ServiceMethodSchemas,
} from "@vibestudio/shared/typedServiceClient";
import { vcsMethods, vcsStateNodeRefSchema } from "./vcs.js";

const readAccess = { sensitivity: "read" as const };
const writeAccess = { sensitivity: "write" as const };
const adminAccess = { sensitivity: "admin" as const };

export type GadJsonValue =
  | null
  | string
  | number
  | boolean
  | GadJsonValue[]
  | { [key: string]: GadJsonValue };
export const GadJsonValueSchema: z.ZodType<GadJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.number(),
    z.boolean(),
    z.array(GadJsonValueSchema),
    z.record(GadJsonValueSchema),
  ])
);
export const GadJsonRecordSchema = z.record(GadJsonValueSchema);
export type GadJsonRecord = z.infer<typeof GadJsonRecordSchema>;
// Event and envelope payloads are deliberately polymorphic at this narrow
// host/workspace ABI. They are still recursively validated as JSON here; the
// workspace-owned agentic protocol performs the event-kind-specific parse.
const PolymorphicJsonPayloadSchema: z.ZodType<unknown> = GadJsonValueSchema;
const PolymorphicJsonRecordSchema: z.ZodType<Record<string, unknown>> = GadJsonRecordSchema;
const PolymorphicJsonArraySchema: z.ZodType<unknown[]> = z.array(GadJsonValueSchema);

const ActorRefWireSchema = z
  .object({
    kind: z.enum([
      "user",
      "agent",
      "system",
      "external",
      "panel",
      "app",
      "worker",
      "do",
      "shell",
      "server",
      "extension",
    ]),
    id: z.string().min(1),
    displayName: z.string().optional(),
    metadata: PolymorphicJsonRecordSchema.optional(),
    participantId: z.string().min(1).optional(),
  })
  .strict();
const ParticipantRefWireSchema = ActorRefWireSchema.extend({
  kind: z.enum(["user", "agent", "system", "external", "panel"]),
});
const ParticipantSelectorWireSchema = z
  .object({
    kind: z.enum(["all", "role", "participant"]),
    role: z.string().min(1).optional(),
    participantId: z.string().min(1).optional(),
  })
  .strict();
const EventCausalityWireSchema = z
  .object({
    parentEventId: z.string().min(1).optional(),
    messageId: z.string().min(1).optional(),
    blockId: z.string().min(1).optional(),
    invocationId: z.string().min(1).optional(),
    transportCallId: z.string().optional(),
    approvalId: z.string().min(1).optional(),
    modelToolCallId: z.string().optional(),
    agentHops: z.number().int().nonnegative().optional(),
    attemptId: z.string().optional(),
  })
  .strict();
const channelEnvelopeSchema = z
  .object({
    envelopeId: z.string().min(1),
    channelId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    from: ActorRefWireSchema,
    to: z.union([z.array(ParticipantRefWireSchema), ParticipantSelectorWireSchema]).optional(),
    payload: PolymorphicJsonPayloadSchema,
    payloadKind: z.string().optional(),
    metadata: PolymorphicJsonRecordSchema.optional(),
    attachments: PolymorphicJsonArraySchema.optional(),
    contentClass: z.enum(["internal", "external"]),
    externalKeys: z.array(z.string()),
    annotations: PolymorphicJsonRecordSchema.optional(),
    publishedAt: z.string().datetime({ offset: true }),
  })
  .strict();
const LogEventCausalityWireSchema = EventCausalityWireSchema.extend({
  originLogId: z.string().optional(),
  originHead: z.string().optional(),
  originEnvelopeId: z.string().optional(),
  turnId: z.string().optional(),
}).strict();
const logEnvelopeSchema = z
  .object({
    logId: z.string().min(1),
    head: z.string().min(1),
    seq: z.number().int().nonnegative(),
    envelopeId: z.string().min(1),
    actor: ActorRefWireSchema,
    to: z.union([z.array(ParticipantRefWireSchema), ParticipantSelectorWireSchema]).optional(),
    payloadKind: z.string().min(1),
    payload: PolymorphicJsonPayloadSchema,
    annotations: PolymorphicJsonRecordSchema.optional(),
    causality: LogEventCausalityWireSchema.optional(),
    appendedAt: z.string().datetime({ offset: true }),
    prevHash: z.string().min(1),
    hash: z.string().min(1),
  })
  .strict();

export const GadStatusMetricSchema = z.object({ metric: z.string(), value: z.number() }).strict();
export type GadStatusMetric = z.infer<typeof GadStatusMetricSchema>;

const SqlTextSchema = z.string();
const SqlNullableTextSchema = z.string().nullable();
const SqlCountSchema = z.number().int().nonnegative();

const TrajectoryBranchSchema = z
  .object({
    trajectory_id: SqlTextSchema,
    branch_id: SqlTextSchema,
    owner_json: SqlNullableTextSchema,
    seq: SqlCountSchema,
    head_event_hash: SqlTextSchema,
    head_event_id: SqlTextSchema,
    parent_branch_id: SqlNullableTextSchema,
    created_at: SqlTextSchema,
    updated_at: SqlTextSchema,
  })
  .strict();
const TrajectoryBranchHeadSchema = TrajectoryBranchSchema.omit({ seq: true }).extend({
  head_event_hash: SqlNullableTextSchema,
  fork_event_id: SqlNullableTextSchema,
});
const TrajectoryInvocationSchema = z
  .object({
    log_id: SqlTextSchema,
    head: SqlTextSchema,
    invocation_id: SqlTextSchema,
    turn_id: SqlNullableTextSchema,
    transport_call_id: SqlNullableTextSchema,
    kind: SqlNullableTextSchema,
    status: SqlTextSchema,
    terminal_outcome: SqlNullableTextSchema,
    terminal_reason_code: SqlNullableTextSchema,
    request_ref_json: SqlNullableTextSchema,
    result_ref_json: SqlNullableTextSchema,
    started_event_id: SqlNullableTextSchema,
    completed_event_id: SqlNullableTextSchema,
    updated_at: SqlTextSchema,
  })
  .strict();
const TrajectoryApprovalSchema = z
  .object({
    approval_id: SqlTextSchema,
    invocation_id: SqlNullableTextSchema,
    status: SqlTextSchema,
    requested_by_json: SqlNullableTextSchema,
    resolved_by_json: SqlNullableTextSchema,
    log_id: SqlTextSchema,
    head: SqlTextSchema,
    requested_event_id: SqlNullableTextSchema,
    resolved_event_id: SqlNullableTextSchema,
    updated_at: SqlTextSchema,
  })
  .strict();
const CompactChannelEnvelopeSchema = z
  .object({
    channel_id: SqlTextSchema,
    head: SqlTextSchema,
    seq: SqlCountSchema,
    envelope_id: SqlTextSchema,
    actor_json: SqlTextSchema,
    to_json: SqlNullableTextSchema,
    payload_kind: SqlTextSchema,
    payload_ref_json: SqlTextSchema,
    annotations_json: SqlNullableTextSchema,
    created_at: SqlTextSchema,
  })
  .strict();
const StoredValueRefSchema = z
  .object({
    ref_scope: z.enum(["channel", "trajectory"]),
    owner_id: SqlTextSchema,
    field_path: SqlTextSchema,
    digest: SqlTextSchema,
    purpose: SqlTextSchema,
    size: SqlCountSchema,
    created_at: SqlTextSchema,
  })
  .strict();
const StorageDiagnosticSchema = z
  .object({
    scope: z.enum(["log_events", "trajectory_invocations", "missing_gad_blob_index"]),
    id: SqlTextSchema,
    bytes: SqlCountSchema,
  })
  .strict();
const logIntegrityErrorSchema = z
  .object({
    type: z.enum(["log-chain", "log-hash", "log-head-pointer"]),
    message: z.string(),
    logId: SqlTextSchema,
    head: SqlTextSchema,
    envelopeId: SqlTextSchema.optional(),
  })
  .strict();
const gadIntegrityErrorSchema = z.discriminatedUnion("type", [
  logIntegrityErrorSchema,
  z
    .object({
      type: z.literal("semantic-vcs"),
      message: z.string(),
      code: z.string().optional(),
      detail: GadJsonValueSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("publication"),
      issue: z.literal("orphan-mapping"),
      message: z.string(),
      envelopeId: SqlTextSchema,
      channelId: SqlTextSchema,
      originLogId: SqlTextSchema,
      originEnvelopeId: SqlTextSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("log-event-shape"),
      message: z.string(),
      envelopeId: SqlTextSchema,
      field: z.enum(["actor_json", "to_json", "payload_ref_json", "annotations_json"]),
      path: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("storage-diagnostic"),
      message: z.string(),
      scope: StorageDiagnosticSchema.shape.scope,
      id: SqlTextSchema,
      bytes: SqlCountSchema,
    })
    .strict(),
]);
const PublicationIntegrityIssueSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("orphan-mapping"),
      envelopeId: SqlTextSchema,
      channelId: SqlTextSchema,
      originLogId: SqlTextSchema,
      originEnvelopeId: SqlTextSchema,
    })
    .strict(),
]);
const TurnStateRowSchema = z
  .object({
    log_id: SqlTextSchema,
    head: SqlTextSchema,
    turn_id: SqlTextSchema,
    trigger_message_id: SqlNullableTextSchema,
    opened_at: SqlNullableTextSchema,
    closed_at: SqlNullableTextSchema,
    streaming_messages: SqlCountSchema,
    nonterminal_invocations: SqlCountSchema,
    duplicate_open_events: SqlCountSchema,
  })
  .strict();
const InvocationStateRowSchema = TrajectoryInvocationSchema.pick({
  log_id: true,
  head: true,
  invocation_id: true,
  turn_id: true,
  transport_call_id: true,
  kind: true,
  status: true,
  terminal_outcome: true,
  terminal_reason_code: true,
  started_event_id: true,
  completed_event_id: true,
  updated_at: true,
}).extend({
  started_events: SqlCountSchema,
  terminal_events: SqlCountSchema,
});
const ChannelRosterRowSchema = z
  .object({
    channel_id: SqlTextSchema,
    participant_id: SqlTextSchema,
    joined_at: SqlTextSchema,
    left_at: SqlNullableTextSchema,
    roles: GadJsonRecordSchema,
  })
  .strict();
const TrajectoryTurnSchema = z
  .object({
    log_id: SqlTextSchema,
    head: SqlTextSchema,
    turn_id: SqlTextSchema,
    opened_at: SqlNullableTextSchema,
    closed_at: SqlNullableTextSchema,
    summary: SqlNullableTextSchema,
    ordinal: z.number().int().nonnegative().nullable(),
    trigger_message_id: SqlNullableTextSchema,
  })
  .strict();
const DiagnosticInvocationSchema = TrajectoryInvocationSchema.omit({
  request_ref_json: true,
  result_ref_json: true,
}).extend({
  request_ref_json: SqlNullableTextSchema,
  result_ref_json: SqlNullableTextSchema,
});
const DiagnosticCommandSchema = z
  .object({
    command_id: SqlTextSchema,
    scope_kind: z.enum(["context", "workspace"]),
    scope_id: SqlTextSchema,
    method: SqlTextSchema,
    request_digest: SqlTextSchema,
    status: z.enum(["pending", "effect-pending", "complete"]),
    created_at: SqlTextSchema,
    completed_at: SqlNullableTextSchema,
    result: GadJsonValueSchema.nullable(),
  })
  .strict();
const DiagnosticEffectSchema = z
  .object({
    effect_id: SqlTextSchema,
    scope_kind: z.enum(["context", "workspace"]),
    scope_id: SqlTextSchema,
    command_id: SqlTextSchema,
    kind: z.enum(["observe-content", "materialize-context", "publish-main"]),
    payload_digest: SqlTextSchema,
    status: z.enum(["pending", "applied"]),
    receipt_digest: SqlNullableTextSchema,
    created_at: SqlTextSchema,
    applied_at: SqlNullableTextSchema,
    payload: GadJsonValueSchema,
    receipt: GadJsonValueSchema.nullable(),
  })
  .strict();

export const ChannelPublicationSchema = z
  .object({
    eventId: z.string(),
    trajectoryId: z.string(),
    branchId: z.string(),
    channelId: z.string(),
    channelSeq: z.number().int().nonnegative(),
    envelopeId: z.string(),
    publishedAt: z.string(),
  })
  .strict();
export type ChannelPublication = z.infer<typeof ChannelPublicationSchema>;

const TrajectoryEventWireSchema = z
  .object({
    eventId: z.string().min(1),
    trajectoryId: z.string().min(1),
    branchId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    prevEventHash: z.string().min(1),
    eventHash: z.string().min(1),
    kind: z.string().min(1),
    actor: ActorRefWireSchema,
    turnId: z.string().min(1).optional(),
    causality: z
      .object({
        parentEventId: z.string().min(1).optional(),
        messageId: z.string().min(1).optional(),
        blockId: z.string().min(1).optional(),
        invocationId: z.string().min(1).optional(),
        transportCallId: z.string().optional(),
        approvalId: z.string().min(1).optional(),
        modelToolCallId: z.string().min(1).optional(),
        agentHops: z.number().int().nonnegative().optional(),
        attemptId: z.string().optional(),
      })
      .strict()
      .optional(),
    payload: PolymorphicJsonPayloadSchema,
    createdAt: z.string(),
  })
  .strict();
const LogOwnerWireSchema = z
  .object({
    kind: z.string().min(1),
    id: z.string().min(1),
    displayName: z.string().optional(),
    metadata: GadJsonRecordSchema.optional(),
    participantId: z.string().min(1).optional(),
  })
  .strict();

export const EnvelopeLineageSchema = z
  .object({
    publication: ChannelPublicationSchema,
    envelope: channelEnvelopeSchema,
    trajectoryEvent: TrajectoryEventWireSchema,
  })
  .strict();
export type EnvelopeLineage = z.infer<typeof EnvelopeLineageSchema>;

export const PublishedArtifactSchema = z.object({ lineage: EnvelopeLineageSchema }).strict();
export type PublishedArtifact = z.infer<typeof PublishedArtifactSchema>;

export const PrivateLineageForPublishedEnvelopeSchema = z
  .object({
    lineage: EnvelopeLineageSchema,
    branchEvents: z.array(TrajectoryEventWireSchema),
  })
  .strict();
export type PrivateLineageForPublishedEnvelope = z.infer<
  typeof PrivateLineageForPublishedEnvelopeSchema
>;

export const ChannelEnvelopeInspectionSchema = z
  .object({
    envelopeId: z.string(),
    channelId: z.string(),
    seq: z.number().int().nonnegative(),
    payloadKind: z.string().optional(),
    from: GadJsonRecordSchema,
    metadata: GadJsonRecordSchema.optional(),
    bytes: z
      .object({
        from: z.number().int().nonnegative(),
        to: z.number().int().nonnegative(),
        payload: z.number().int().nonnegative(),
        metadata: z.number().int().nonnegative(),
        attachments: z.number().int().nonnegative(),
      })
      .strict(),
    payloadSummary: PolymorphicJsonPayloadSchema,
    storedRefs: z.array(
      z
        .object({
          field_path: SqlTextSchema,
          digest: SqlTextSchema,
          purpose: SqlTextSchema,
          size: SqlCountSchema,
          created_at: SqlTextSchema,
        })
        .strict()
    ),
    publishedAt: z.string(),
  })
  .strict();
export type ChannelEnvelopeInspection = z.infer<typeof ChannelEnvelopeInspectionSchema>;

export const PublicationIntegrityInspectionSchema = z
  .object({
    summary: z
      .object({
        expectedMappings: z.number().int().nonnegative(),
        missingMappings: z.number().int().nonnegative(),
        orphanMappings: z.number().int().nonnegative(),
        missingPublicationEvents: z.number().int().nonnegative(),
        missingPublicationEnvelopes: z.number().int().nonnegative(),
        sequenceMismatches: z.number().int().nonnegative(),
        channelOriginAgenticEnvelopes: z.number().int().nonnegative(),
      })
      .strict(),
    rows: z.array(PublicationIntegrityIssueSchema),
  })
  .strict();
export type PublicationIntegrityInspection = z.infer<typeof PublicationIntegrityInspectionSchema>;

export const TurnStateInspectionSchema = z
  .object({
    summary: z
      .object({
        branches: z.number().int().nonnegative(),
        openTurns: z.number().int().nonnegative(),
        streamingMessages: z.number().int().nonnegative(),
        nonterminalInvocations: z.number().int().nonnegative(),
        duplicateOpenedTurns: z.number().int().nonnegative(),
      })
      .strict(),
    rows: z.array(TurnStateRowSchema),
  })
  .strict();
export type TurnStateInspection = z.infer<typeof TurnStateInspectionSchema>;

export const InvocationStateInspectionSchema = z
  .object({
    summary: z
      .object({
        projected: z.number().int().nonnegative(),
        startedEvents: z.number().int().nonnegative(),
        terminalEvents: z.number().int().nonnegative(),
        openProjectedInvocations: z.number().int().nonnegative(),
      })
      .strict(),
    rows: z.array(InvocationStateRowSchema),
  })
  .strict();
export type InvocationStateInspection = z.infer<typeof InvocationStateInspectionSchema>;

export const InvocationDiagnosticPacketSchema = z
  .object({
    generatedAt: z.string(),
    coordinate: z
      .object({
        trajectoryId: z.string(),
        branchId: z.string(),
        invocationId: z.string(),
      })
      .strict(),
    invocation: DiagnosticInvocationSchema.nullable(),
    turn: TrajectoryTurnSchema.nullable(),
    // Inspection summaries deliberately truncate arbitrary event payloads, but
    // remain recursively JSON validated at this narrow ABI.
    events: z.array(GadJsonRecordSchema),
    commands: z.array(
      z
        .object({
          command: DiagnosticCommandSchema,
          effects: z.array(DiagnosticEffectSchema),
        })
        .strict()
    ),
    summary: z
      .object({
        terminal: z.boolean(),
        eventCount: z.number().int().nonnegative(),
        commandCount: z.number().int().nonnegative(),
        pendingEffectCount: z.number().int().nonnegative(),
        cleanupFailureCount: z.number().int().nonnegative(),
        truncated: z
          .object({
            events: z.boolean(),
            commands: z.boolean(),
            effects: z.boolean(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export type InvocationDiagnosticPacket = z.infer<typeof InvocationDiagnosticPacketSchema>;

export const ChannelRosterInspectionSchema = z
  .object({
    summary: z
      .object({
        rows: z.number().int().nonnegative(),
        activeParticipants: z.number().int().nonnegative(),
        inactiveParticipants: z.number().int().nonnegative(),
      })
      .strict(),
    rows: z.array(ChannelRosterRowSchema),
  })
  .strict();
export type ChannelRosterInspection = z.infer<typeof ChannelRosterInspectionSchema>;

export const AgentHealthInspectionSchema = z
  .object({
    channelId: z.string(),
    branchId: z.string(),
    generatedAt: z.string(),
    summary: z
      .object({
        ok: z.boolean(),
        durableIntegrityOk: z.boolean(),
        inFlightOnly: z.boolean(),
        activity: z.enum(["idle", "in-flight"]),
        publicationIssues: z.number().int().nonnegative(),
        turnIntegrityIssues: z.number().int().nonnegative(),
        openTurns: z.number().int().nonnegative(),
        streamingMessages: z.number().int().nonnegative(),
        nonterminalInvocations: z.number().int().nonnegative(),
        activeParticipants: z.number().int().nonnegative(),
        storageIssues: z.number().int().nonnegative(),
      })
      .strict(),
    publicationIntegrity: PublicationIntegrityInspectionSchema,
    turnState: TurnStateInspectionSchema,
    invocationState: InvocationStateInspectionSchema,
    roster: ChannelRosterInspectionSchema,
    envelopes: channelEnvelopePageSchema(ChannelEnvelopeInspectionSchema),
    storage: z.object({ rows: z.array(StorageDiagnosticSchema) }).strict(),
  })
  .strict();
export type AgentHealthInspection = z.infer<typeof AgentHealthInspectionSchema>;

const AgenticStoredValueRefSchema = z
  .object({
    protocol: z.literal("vibestudio.blob-ref.v1"),
    digest: z.string().min(1),
    size: z.number().int().nonnegative(),
    encoding: z.enum(["json", "text"]),
    originalBytes: z.number().int().nonnegative(),
  })
  .strict();

/**
 * GAD's durable message-type projection is storage-form data. Reference-class
 * event fields stay as blob refs inside the append transaction; PubSub owns
 * hydration and semantic validation before callers can observe a definition.
 */
export const StoredChannelMessageTypeDefinitionSchema = z
  .object({
    typeId: z.string(),
    displayMode: z.enum(["inline", "row"]),
    source: AgenticStoredValueRefSchema,
    imports: AgenticStoredValueRefSchema.optional(),
    stateSchema: GadJsonRecordSchema.optional(),
    updateSchema: GadJsonRecordSchema.optional(),
    registeredBy: GadJsonRecordSchema.optional(),
    updatedAtSeq: z.number().int().nonnegative(),
    clearedAtSeq: z.number().int().nonnegative().optional(),
  })
  .strict();
export type StoredChannelMessageTypeDefinition = z.infer<
  typeof StoredChannelMessageTypeDefinitionSchema
>;

export const StoredRegistryMutationInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("upsertMessageType"),
      typeId: z.string(),
      row: StoredChannelMessageTypeDefinitionSchema.omit({
        typeId: true,
        updatedAtSeq: true,
        clearedAtSeq: true,
      }),
    })
    .strict(),
  z.object({ kind: z.literal("clearMessageType"), typeId: z.string() }).strict(),
]);
export type StoredRegistryMutationInput = z.infer<typeof StoredRegistryMutationInputSchema>;

const ChannelEnvelopeAppendInputSchema = channelEnvelopeSchema
  .omit({
    seq: true,
    envelopeId: true,
    publishedAt: true,
    contentClass: true,
    externalKeys: true,
  })
  .extend({
    envelopeId: z.string().nullish(),
    publishedAt: z.string().nullish(),
  });

const UserNotificationSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    kind: z.string(),
    title: z.string(),
    message: z.string().optional(),
    data: PolymorphicJsonPayloadSchema.optional(),
    createdAt: z.number(),
    revision: z.number().int().nonnegative(),
  })
  .strict();

const optionalLimit = z.number().int().nonnegative().nullable().optional();
const optionalString = z.string().nullable().optional();

export const InspectStoredValueRefsInputSchema = z
  .object({
    eventId: optionalString,
    envelopeId: optionalString,
    digest: optionalString,
    limit: optionalLimit,
  })
  .strict();
export type InspectStoredValueRefsInput = z.infer<typeof InspectStoredValueRefsInputSchema>;

export const InspectStorageDiagnosticsInputSchema = z
  .object({
    rowByteLimit: optionalLimit,
    limit: optionalLimit,
    branchId: optionalString,
    channelId: optionalString,
  })
  .strict();
export type InspectStorageDiagnosticsInput = z.infer<typeof InspectStorageDiagnosticsInputSchema>;

export const InspectPublicationIntegrityInputSchema = z
  .object({ channelId: optionalString, branchId: optionalString, limit: optionalLimit })
  .strict();
export type InspectPublicationIntegrityInput = z.infer<
  typeof InspectPublicationIntegrityInputSchema
>;

export const InspectTurnStateInputSchema = z
  .object({
    trajectoryId: optionalString,
    branchId: optionalString,
    channelId: optionalString,
    limit: optionalLimit,
  })
  .strict();
export type InspectTurnStateInput = z.infer<typeof InspectTurnStateInputSchema>;

export const InspectInvocationStateInputSchema = z
  .object({
    trajectoryId: optionalString,
    branchId: optionalString,
    invocationId: optionalString,
    transportCallId: optionalString,
    limit: optionalLimit,
  })
  .strict();
export type InspectInvocationStateInput = z.infer<typeof InspectInvocationStateInputSchema>;

export const DiagnoseInvocationInputSchema = z
  .object({
    trajectoryId: z.string().min(1),
    branchId: z.string().min(1),
    invocationId: z.string().min(1),
    eventLimit: z.number().int().min(1).max(50).optional(),
    commandLimit: z.number().int().min(1).max(50).optional(),
    effectLimit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type DiagnoseInvocationInput = z.infer<typeof DiagnoseInvocationInputSchema>;

export const InspectChannelRosterInputSchema = z
  .object({ channelId: z.string(), limit: optionalLimit })
  .strict();
export type InspectChannelRosterInput = z.infer<typeof InspectChannelRosterInputSchema>;

export const InspectAgentHealthInputSchema = z
  .object({
    channelId: z.string(),
    branchId: optionalString,
    limit: optionalLimit,
    envelopeLimit: optionalLimit,
    storageLimit: optionalLimit,
    rowByteLimit: optionalLimit,
  })
  .strict();
export type InspectAgentHealthInput = z.infer<typeof InspectAgentHealthInputSchema>;

/** Ergonomic, portable runtime facade. Its `status` naming and scalar
 * notification results intentionally differ from the DO's
 * transport shapes; `gadWireMethods` below owns that internal boundary. */
export const gadMethods = defineServiceMethods({
  status: {
    description: "Return compact GAD storage and projection status metrics.",
    args: z.tuple([]),
    returns: z.array(GadStatusMetricSchema),
    access: readAccess,
  },
  ensureBlob: {
    description: "Ensure that a content digest is registered in GAD blob metadata.",
    args: z.tuple([
      z.string(),
      z.number().int().nonnegative().optional(),
      z.string().nullable().optional(),
    ]),
    returns: z.void(),
    access: writeAccess,
  },
  listUserNotificationsForMe: {
    description: "List durable notifications for the host-verified current account.",
    args: z.tuple([]),
    returns: z.array(UserNotificationSchema),
    access: readAccess,
  },
  acknowledgeUserNotification: {
    description: "Acknowledge one durable notification for the current account.",
    args: z.tuple([z.string()]),
    returns: z.boolean(),
    access: writeAccess,
  },
  putUserNotification: {
    description: "Create or update one durable account notification from a trusted runtime.",
    args: z.tuple([UserNotificationSchema]),
    returns: UserNotificationSchema,
    access: writeAccess,
  },
  deleteUserNotification: {
    description: "Withdraw one durable account notification from a trusted runtime.",
    args: z.tuple([z.string(), z.string()]),
    returns: z.boolean(),
    access: writeAccess,
  },
  getTrajectoryBranchHead: {
    description: "Return the durable head record for one trajectory branch.",
    args: z.tuple([z.object({ trajectoryId: z.string(), branchId: z.string() }).strict()]),
    returns: TrajectoryBranchHeadSchema.nullable(),
    access: readAccess,
  },
  listTrajectoryBranches: {
    description: "List trajectory branch summaries in descending update order.",
    args: z.tuple([z.object({ limit: optionalLimit }).strict().optional()]),
    returns: z.array(TrajectoryBranchSchema),
    access: readAccess,
  },
  listTrajectoryInvocations: {
    description: "List invocation summaries for one trajectory branch.",
    args: z.tuple([z.object({ branchId: z.string(), limit: optionalLimit }).strict()]),
    returns: z.array(TrajectoryInvocationSchema),
    access: readAccess,
  },
  listTrajectoryApprovals: {
    description: "List durable trajectory approval summaries.",
    args: z.tuple([z.object({ limit: optionalLimit }).strict().optional()]),
    returns: z.array(TrajectoryApprovalSchema),
    access: readAccess,
  },
  listChannelEnvelopes: {
    description: "List compact channel envelope records in durable channel order.",
    args: z.tuple([z.object({ limit: optionalLimit }).strict().optional()]),
    returns: z.array(CompactChannelEnvelopeSchema),
    access: readAccess,
  },
  listTrajectoryEvents: {
    description: "List hydrated trajectory events after an optional sequence cursor.",
    args: z.tuple([
      z
        .object({
          trajectoryId: optionalString,
          branchId: z.string(),
          cursor: z.number().int().nonnegative().nullable().optional(),
          limit: optionalLimit,
        })
        .strict(),
    ]),
    returns: z.array(TrajectoryEventWireSchema),
    access: readAccess,
  },
  appendChannelEnvelope: {
    description: "Atomically append one semantic envelope to a durable channel log.",
    args: z.tuple([ChannelEnvelopeAppendInputSchema]),
    returns: channelEnvelopeSchema,
    access: writeAccess,
  },
  listMessageTypes: {
    description:
      "List active stored custom message-type definitions for a channel. Reference-class fields are hydrated and validated by PubSub before semantic use.",
    args: z.tuple([z.object({ channelId: z.string() }).strict()]),
    returns: z.array(StoredChannelMessageTypeDefinitionSchema),
    access: readAccess,
  },
  getMessageType: {
    description:
      "Get one stored custom message-type definition from a channel registry. PubSub owns its hydration boundary.",
    args: z.tuple([z.object({ channelId: z.string(), typeId: z.string() }).strict()]),
    returns: StoredChannelMessageTypeDefinitionSchema.nullable(),
    access: readAccess,
  },
  getChannelEnvelope: {
    description: "Get one hydrated channel envelope by its durable id.",
    args: z.tuple([z.object({ envelopeId: z.string(), channelId: optionalString }).strict()]),
    returns: channelEnvelopeSchema.nullable(),
    access: readAccess,
  },
  getTrajectoryForEnvelope: {
    description: "Resolve the private trajectory lineage that published an envelope.",
    args: z.tuple([z.object({ envelopeId: z.string() }).strict()]),
    returns: EnvelopeLineageSchema.nullable(),
    access: readAccess,
  },
  listPublishedEnvelopesForTrajectory: {
    description: "List published envelope lineage matching trajectory selectors.",
    args: z.tuple([
      z
        .object({
          trajectoryId: optionalString,
          branchId: optionalString,
          eventId: optionalString,
          turnId: optionalString,
          channelId: optionalString,
          limit: optionalLimit,
        })
        .strict(),
    ]),
    returns: z.array(EnvelopeLineageSchema),
    access: readAccess,
  },
  getEnvelopesForTrajectory: {
    description: "List hydrated published envelopes for matching trajectory selectors.",
    args: z.tuple([
      z
        .object({
          trajectoryId: optionalString,
          branchId: optionalString,
          eventId: optionalString,
          turnId: optionalString,
          channelId: optionalString,
          limit: optionalLimit,
        })
        .strict(),
    ]),
    returns: z.array(EnvelopeLineageSchema),
    access: readAccess,
  },
  getPublishedArtifactsForTurn: {
    description: "List published artifacts attributed to one durable agent turn.",
    args: z.tuple([
      z
        .object({
          branchId: optionalString,
          turnId: z.string(),
          channelId: optionalString,
          limit: optionalLimit,
        })
        .strict(),
    ]),
    returns: z.array(PublishedArtifactSchema),
    access: readAccess,
  },
  getPrivateLineageForPublishedEnvelope: {
    description: "Return publication lineage plus the private branch events behind an envelope.",
    args: z.tuple([z.object({ envelopeId: z.string() }).strict()]),
    returns: PrivateLineageForPublishedEnvelopeSchema.nullable(),
    access: readAccess,
  },
  getDownstreamConsumers: {
    description: "List trajectory events that consumed a published envelope.",
    args: z.tuple([z.object({ envelopeId: z.string(), limit: optionalLimit }).strict()]),
    returns: z.array(TrajectoryEventWireSchema),
    access: readAccess,
  },
  readChannelEnvelopes: {
    description: "Read one bounded page of hydrated semantic channel envelopes.",
    args: z.tuple([ChannelEnvelopePageRequestSchema]),
    returns: channelEnvelopePageSchema(channelEnvelopeSchema),
    access: readAccess,
  },
  inspectChannelEnvelopes: {
    description: "Read one bounded page of compact channel-envelope diagnostics.",
    args: z.tuple([ChannelEnvelopePageRequestSchema]),
    returns: channelEnvelopePageSchema(ChannelEnvelopeInspectionSchema),
    access: readAccess,
  },
  listStoredValueRefs: {
    description: "List stored-value references matching event, envelope, or digest selectors.",
    args: z.tuple([InspectStoredValueRefsInputSchema.optional()]),
    returns: z.object({ rows: z.array(StoredValueRefSchema) }).strict(),
    access: readAccess,
  },
  inspectStorageDiagnostics: {
    description: "Inspect oversized or unresolved durable storage rows with bounded output.",
    args: z.tuple([InspectStorageDiagnosticsInputSchema.optional()]),
    returns: z.object({ rows: z.array(StorageDiagnosticSchema) }).strict(),
    access: readAccess,
  },
  inspectPublicationIntegrity: {
    description: "Inspect publication mappings and sequence integrity.",
    args: z.tuple([InspectPublicationIntegrityInputSchema.optional()]),
    returns: PublicationIntegrityInspectionSchema,
    access: readAccess,
  },
  inspectTurnState: {
    description: "Inspect open, streaming, and duplicate durable turn state.",
    args: z.tuple([InspectTurnStateInputSchema.optional()]),
    returns: TurnStateInspectionSchema,
    access: readAccess,
  },
  inspectInvocationState: {
    description: "Inspect projected and journaled invocation lifecycle state.",
    args: z.tuple([InspectInvocationStateInputSchema.optional()]),
    returns: InvocationStateInspectionSchema,
    access: readAccess,
  },
  diagnoseInvocation: {
    description:
      "Return one bounded causal packet joining an exact invocation to its turn, terminal events, semantic commands, effect intents, and receipts.",
    args: z.tuple([DiagnoseInvocationInputSchema]),
    returns: InvocationDiagnosticPacketSchema,
    access: readAccess,
  },
  inspectChannelRoster: {
    description: "Inspect durable participant membership for one channel.",
    args: z.tuple([InspectChannelRosterInputSchema]),
    returns: ChannelRosterInspectionSchema,
    access: readAccess,
  },
  inspectAgentHealth: {
    description:
      "Return one compact integrity and in-flight activity snapshot for an agent channel.",
    args: z.tuple([InspectAgentHealthInputSchema]),
    returns: AgentHealthInspectionSchema,
    access: readAccess,
  },
  validateGadHashes: {
    description: "Validate content, manifest, and state hashes without mutating durable state.",
    args: z.tuple([z.object({}).strict().optional()]),
    returns: z.object({ ok: z.boolean(), errors: z.array(z.string()) }).strict(),
    access: readAccess,
  },
  clearDirtyAfterValidation: {
    description: "Clear the dirty marker only after durable hash validation succeeds.",
    args: z.tuple([z.object({}).strict().optional()]),
    returns: z.object({ ok: z.boolean(), errors: z.array(z.string()) }).strict(),
    access: writeAccess,
  },
  checkGadIntegrity: {
    description: "Run durable GAD integrity checks and return structured errors.",
    args: z.tuple([z.object({}).strict().optional()]),
    returns: z.object({ ok: z.boolean(), errors: z.array(gadIntegrityErrorSchema) }).strict(),
    access: readAccess,
  },
  rebuildTrajectoryProjections: {
    description: "Rebuild trajectory-derived projections from the durable event log.",
    args: z.tuple([z.object({}).strict().optional()]),
    returns: z.object({ replayed: z.number().int().nonnegative() }).strict(),
    access: adminAccess,
  },
} satisfies Record<GadRuntimeMethodName, MethodSchema>);

const {
  status: publicStatus,
  listUserNotificationsForMe: publicListUserNotificationsForMe,
  acknowledgeUserNotification: publicAcknowledgeUserNotification,
  deleteUserNotification: publicDeleteUserNotification,
  ...directGadWireMethods
} = gadMethods;

const semanticCausalParentSchema = z
  .object({
    kind: z.literal("trajectory-invocation"),
    logId: z.string().min(1),
    head: z.string().min(1),
    invocationId: z.string().min(1),
  })
  .strict();
const semanticContextIntegritySchema = z
  .object({
    class: z.enum(["internal", "external"]),
    externalKeys: z.array(z.string()),
  })
  .strict();
const semanticIngressSchema = z
  .object({
    causalParent: semanticCausalParentSchema.nullable(),
    contextIntegrity: semanticContextIntegritySchema,
  })
  .strict();
const semanticFileDescriptorSchema = z.union([
  z.object({ contentHash: z.string().min(1), base64: z.string() }).strict(),
  z
    .object({
      contentHash: z.string().min(1),
      contentKind: z.enum(["text", "bytes"]),
      byteLength: z.number().int().nonnegative(),
      coordinateExtent: z.number().int().nonnegative(),
    })
    .strict(),
]);
const semanticEffectSchema = z
  .object({
    effectId: z.string().min(1),
    scopeKind: z.enum(["context", "workspace"]),
    scopeId: z.string().min(1),
    commandId: z.string().min(1),
    kind: z.enum(["observe-content", "materialize-context", "publish-main"]),
    payload: GadJsonRecordSchema,
    payloadDigest: z.string().min(1),
    status: z.enum(["pending", "applied"]),
    receipt: GadJsonRecordSchema.nullable(),
    createdAt: z.string(),
  })
  .strict();
const semanticHostReadSchema = z
  .object({
    kind: z.literal("read-semantic-blob"),
    state: vcsStateNodeRefSchema,
    repositoryId: z.string().min(1),
    fileId: z.string().min(1),
    repoPath: z.string(),
    path: z.string(),
    contentHash: z.string().min(1),
    authoredChangeId: z.string().min(1),
    authoredByWorkUnitId: z.string().min(1),
    contentClass: z.enum(["internal", "external"]),
    externalKeys: z.array(z.string().min(1)).max(256),
    mode: z.number().int().nonnegative(),
  })
  .strict();

function semanticWireMethod(
  method: (typeof vcsMethods)[keyof typeof vcsMethods],
  wireName: string
): MethodSchema {
  const inputSchema = (method.args as z.ZodTuple<[z.ZodTypeAny]>).items[0];
  const resultSchema = method.returns;
  return {
    description: `Execute the exact ${wireName} semantic workspace operation.`,
    args: z.tuple([
      z
        .object({
          input: inputSchema,
          ingress: semanticIngressSchema,
        })
        .strict(),
    ]),
    returns: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("complete"), result: resultSchema }).strict(),
      z
        .object({
          kind: z.literal("effects-pending"),
          // Effects may be required to construct the public method result
          // (for example an import learns its canonical snapshot only after
          // host observation). Only `complete` carries the final contract.
          result: PolymorphicJsonPayloadSchema,
          effects: z.array(semanticEffectSchema),
        })
        .strict(),
      z.object({ kind: z.literal("host-read"), request: semanticHostReadSchema }).strict(),
    ]),
    agentFacing: false,
  };
}

const semanticWireMethods = {
  vcsEdit: semanticWireMethod(vcsMethods.edit, "edit"),
  vcsMove: semanticWireMethod(vcsMethods.move, "move"),
  vcsCopy: semanticWireMethod(vcsMethods.copy, "copy"),
  vcsIntegrate: semanticWireMethod(vcsMethods.integrate, "integrate"),
  vcsRevert: semanticWireMethod(vcsMethods.revert, "revert"),
  vcsCommit: semanticWireMethod(vcsMethods.commit, "commit"),
  vcsDiscard: semanticWireMethod(vcsMethods.discard, "discard"),
  vcsImportSnapshot: semanticWireMethod(vcsMethods.importSnapshot, "import snapshot"),
  vcsRegisterExternalDelta: semanticWireMethod(
    vcsMethods.registerExternalDelta,
    "register external delta"
  ),
  vcsSupersedeExternalDelta: semanticWireMethod(
    vcsMethods.supersedeExternalDelta,
    "supersede external delta"
  ),
  vcsFinalizeExternalDelta: semanticWireMethod(
    vcsMethods.finalizeExternalDelta,
    "finalize external delta"
  ),
  vcsPush: semanticWireMethod(vcsMethods.push, "push"),
  vcsStatus: semanticWireMethod(vcsMethods.status, "status"),
  vcsCompare: semanticWireMethod(vcsMethods.compare, "compare"),
  vcsInspect: semanticWireMethod(vcsMethods.inspect, "inspect"),
  vcsNeighbors: semanticWireMethod(vcsMethods.neighbors, "neighbors"),
  vcsHistory: semanticWireMethod(vcsMethods.history, "history"),
  vcsBlame: semanticWireMethod(vcsMethods.blame, "blame"),
  vcsReadMemory: semanticWireMethod(vcsMethods.readMemory, "read memory"),
  vcsResolveRepository: semanticWireMethod(vcsMethods.resolveRepository, "resolve repository"),
  vcsReadFile: semanticWireMethod(vcsMethods.readFile, "read file"),
  vcsListDirectory: semanticWireMethod(vcsMethods.listDirectory, "list directory"),
  vcsListFiles: semanticWireMethod(vcsMethods.listFiles, "list files"),
} satisfies ServiceMethodSchemas;

const nonemptyText = z.string().min(1);
const stateRefSchema = vcsStateNodeRefSchema;
const workspacePinSchema = z
  .object({
    url: nonemptyText,
    ref: nonemptyText,
    commit: nonemptyText,
    snapshot: z.string().regex(/^v1-sha256:[a-f0-9]{64}$/u),
  })
  .strict();
const workspaceSnapshotRepositorySchema = z
  .object({
    repoPath: z.string(),
    subdir: z.string(),
    snapshot: z.string().regex(/^v1-sha256:[a-f0-9]{64}$/u),
    files: z.array(
      z
        .object({
          path: z.string(),
          contentHash: nonemptyText,
          mode: z.number().int().nonnegative(),
        })
        .strict()
    ),
  })
  .strict();
const semanticAcknowledgementSchema = z
  .object({
    effectId: nonemptyText,
    payloadDigest: nonemptyText,
    receipt: GadJsonRecordSchema,
  })
  .strict();
const workspaceInitializationInputSchema = z
  .object({
    commandId: nonemptyText,
    pin: workspacePinSchema,
    repositories: z.array(workspaceSnapshotRepositorySchema),
    acknowledgement: semanticAcknowledgementSchema.optional(),
  })
  .strict();
const workspaceSourceEffectSchema = semanticEffectSchema
  .omit({
    receipt: true,
    createdAt: true,
  })
  .extend({ status: z.literal("pending") });
const workspaceInitializationInspectionSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("empty") }).strict(),
  z
    .object({
      state: z.literal("initializing"),
      commandId: nonemptyText,
      pendingEffect: workspaceSourceEffectSchema.optional(),
    })
    .strict(),
  z
    .object({
      state: z.literal("ready"),
      commandId: nonemptyText,
      receipt: z
        .object({
          commandId: nonemptyText,
          pin: workspacePinSchema,
          initializedEventId: nonemptyText,
          initializedStateHash: nonemptyText,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      state: z.literal("failed"),
      commandId: nonemptyText,
      failure: z.object({ message: z.string(), retryable: z.boolean() }).strict(),
    })
    .strict(),
]);
const semanticStateSchema = z
  .object({ ref: stateRefSchema, workspaceFactRootId: nonemptyText })
  .strict();
const semanticContextSchema = z
  .object({
    contextId: nonemptyText,
    committed: semanticStateSchema.extend({
      ref: z.object({ kind: z.literal("event"), eventId: nonemptyText }).strict(),
    }),
    working: semanticStateSchema,
    workingHeadApplicationId: nonemptyText.nullable(),
  })
  .strict();
const genericSemanticResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("complete"), result: GadJsonValueSchema }).strict(),
  z
    .object({
      kind: z.literal("effects-pending"),
      result: GadJsonValueSchema,
      effects: z.array(semanticEffectSchema),
    })
    .strict(),
  z.object({ kind: z.literal("host-read"), request: semanticHostReadSchema }).strict(),
]);
const materializationFileStateSchema = z
  .object({ contentHash: nonemptyText, mode: z.number().int().nonnegative() })
  .strict();
const materializationRepositorySchema = z.discriminatedUnion("presence", [
  z
    .object({
      repositoryId: nonemptyText,
      repoPath: z.string(),
      presence: z.literal("deleted"),
    })
    .strict(),
  z
    .object({
      repositoryId: nonemptyText,
      repoPath: z.string(),
      presence: z.literal("present"),
      fileManifestId: nonemptyText,
      source: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("content-root"), contentRoot: nonemptyText }).strict(),
        z
          .object({
            kind: z.literal("delta"),
            basisContentRoot: nonemptyText,
            changes: z.array(
              z
                .object({
                  path: z.string(),
                  expected: materializationFileStateSchema.nullable(),
                  result: materializationFileStateSchema.nullable(),
                })
                .strict()
            ),
          })
          .strict(),
        z
          .object({
            kind: z.literal("snapshot"),
            files: z.array(
              z
                .object({
                  path: z.string(),
                  contentHash: nonemptyText,
                  mode: z.number().int().nonnegative(),
                })
                .strict()
            ),
          })
          .strict(),
      ]),
    })
    .strict(),
]);
const materializationCommandSchema = z
  .object({
    materializationId: nonemptyText,
    contextId: nonemptyText,
    commandId: nonemptyText,
    mode: z.enum(["initialize", "patch", "replace"]),
    previousState: stateRefSchema.nullable(),
    targetState: stateRefSchema,
    repositories: z.array(materializationRepositorySchema),
    blobs: z.array(z.object({ contentHash: nonemptyText, base64: z.string() }).strict()),
    payloadDigest: nonemptyText,
  })
  .strict();
const refRecordSchema = z
  .object({
    refName: nonemptyText,
    kind: nonemptyText,
    target: GadJsonValueSchema,
    updatedAt: z.string(),
  })
  .strict();
const refLogRecordSchema = z
  .object({
    id: z.number().int().positive(),
    ref_name: nonemptyText,
    old_target_json: z.string().nullable(),
    new_target_json: z.string(),
    updated_at: z.string(),
  })
  .strict();
const logHeadSchema = z
  .object({
    logId: nonemptyText,
    head: nonemptyText,
    logKind: nonemptyText,
    seq: z.number().int().nonnegative(),
    hash: nonemptyText,
    envelopeId: nonemptyText.nullable(),
    forkSeq: z.number().int().nonnegative().nullable(),
    forkHash: nonemptyText.nullable(),
    parentLogId: nonemptyText.nullable(),
    parentHead: nonemptyText.nullable(),
  })
  .strict();
const logAppendEventSchema = z
  .object({
    envelopeId: nonemptyText.nullish(),
    actor: ActorRefWireSchema,
    to: GadJsonValueSchema.nullish(),
    payloadKind: nonemptyText,
    payload: GadJsonValueSchema,
    causality: LogEventCausalityWireSchema.nullish(),
    annotations: PolymorphicJsonRecordSchema.nullish(),
    appendedAt: z.string().nullish(),
    publish: z
      .object({
        channels: z.array(
          z.object({ channelId: nonemptyText, audience: GadJsonValueSchema.optional() }).strict()
        ),
      })
      .strict()
      .nullish(),
  })
  .strict();
const appendLogResultSchema = z
  .object({
    logId: nonemptyText,
    head: nonemptyText,
    headSeq: z.number().int().nonnegative(),
    headHash: nonemptyText,
    envelopes: z.array(logEnvelopeSchema),
    published: z.array(
      z
        .object({
          originEnvelopeId: nonemptyText,
          channelId: nonemptyText,
          envelopeId: nonemptyText,
        })
        .strict()
    ),
  })
  .strict();
const forkLogInputSchema = z
  .object({
    fromLogId: nonemptyText,
    fromHead: nonemptyText,
    toLogId: nonemptyText,
    toHead: nonemptyText,
    atSeq: z.number().int().nonnegative().nullish(),
    owner: z.object({ kind: nonemptyText, id: nonemptyText }).strict().nullish(),
  })
  .strict();
const forkLogResultSchema = z
  .object({
    fromLogId: nonemptyText,
    fromHead: nonemptyText,
    toLogId: nonemptyText,
    toHead: nonemptyText,
    forkSeq: z.number().int().nonnegative(),
    forkHash: nonemptyText,
    inherited: z.number().int().nonnegative(),
  })
  .strict();
const channelInviteSchema = z
  .object({
    channelId: nonemptyText,
    userId: nonemptyText,
    memberId: nonemptyText,
    handle: nonemptyText,
    addedBy: nonemptyText,
    addedAt: z.number().int().nonnegative(),
  })
  .strict();
const channelInviteKeySchema = z.object({ channelId: nonemptyText, userId: nonemptyText }).strict();

const gadInternalWireMethods = defineServiceMethods({
  workspaceSourceInitializeExactSnapshot: {
    description: "Initialize the provider from one exact root snapshot.",
    args: z.tuple([workspaceInitializationInputSchema]),
    returns: workspaceInitializationInspectionSchema,
    agentFacing: false,
  },
  workspaceSourceResolve: {
    description: "Resolve an exact source reference.",
    args: z.tuple([z.object({ ref: nonemptyText }).strict()]),
    returns: z.object({ stateHash: nonemptyText }).strict(),
    agentFacing: false,
  },
  workspaceSourceCurrent: {
    description: "Read the current source state.",
    args: z.tuple([]),
    returns: z.object({ stateHash: nonemptyText }).strict().nullable(),
    agentFacing: false,
  },
  workspaceSourceInspectInitialization: {
    description: "Inspect exact-root initialization.",
    args: z.tuple([]),
    returns: workspaceInitializationInspectionSchema,
    agentFacing: false,
  },
  workspaceSourceHealth: {
    description: "Check the workspace-source bootstrap protocol.",
    args: z.tuple([]),
    returns: z
      .object({ ok: z.literal(true), protocol: z.literal("vibestudio.workspace-source.v1") })
      .strict(),
    agentFacing: false,
  },
  vcsSemanticEffectAck: {
    description: "Acknowledge one exact semantic host effect.",
    args: z.tuple([z.object({ acknowledgement: semanticAcknowledgementSchema }).strict()]),
    returns: genericSemanticResultSchema,
    agentFacing: false,
  },
  vcsPendingSemanticEffects: {
    description: "List durable pending semantic effects.",
    args: z.tuple([]),
    returns: z.array(semanticEffectSchema),
    agentFacing: false,
  },
  vcsContentGcRoots: {
    description: "List content roots retained by semantic state.",
    args: z.tuple([]),
    returns: z
      .object({ contentRoots: z.array(nonemptyText), contentHashes: z.array(nonemptyText) })
      .strict(),
    agentFacing: false,
  },
  vcsListContexts: {
    description: "List semantic context identifiers.",
    args: z.tuple([z.object({ prefix: z.string().optional() }).strict()]),
    returns: z.array(nonemptyText),
    agentFacing: false,
  },
  vcsReferencesReachable: {
    description: "Check whether semantic references are reachable from contexts.",
    args: z.tuple([
      z
        .object({
          contextIds: z.array(nonemptyText),
          references: z.array(z.object({ kind: nonemptyText, value: GadJsonValueSchema }).strict()),
        })
        .strict(),
    ]),
    returns: z.boolean(),
    agentFacing: false,
  },
  vcsIsStateDescendant: {
    description: "Check semantic state ancestry within a bounded traversal.",
    args: z.tuple([
      z
        .object({
          ancestor: stateRefSchema,
          descendant: stateRefSchema,
          maxEdges: z.number().int().positive(),
        })
        .strict(),
    ]),
    returns: z.boolean(),
    agentFacing: false,
  },
  vcsEnsureContext: {
    description: "Ensure one semantic context and requested projection.",
    args: z.tuple([
      z
        .object({
          contextId: nonemptyText,
          commandId: nonemptyText,
          projection: z.enum(["required", "deferred"]).optional(),
          ingress: semanticIngressSchema,
        })
        .strict(),
    ]),
    returns: genericSemanticResultSchema,
    agentFacing: false,
  },
  vcsContextMaterializationCommand: {
    description: "Derive the exact repair command for one context projection.",
    args: z.tuple([
      z.object({ contextId: nonemptyText, materializedState: stateRefSchema.nullable() }).strict(),
    ]),
    returns: materializationCommandSchema,
    agentFacing: false,
  },
  vcsForkContext: {
    description: "Fork one semantic context into another exact coordinate.",
    args: z.tuple([
      z
        .object({
          sourceContextId: nonemptyText,
          targetContextId: nonemptyText,
          commandId: nonemptyText,
          ingress: semanticIngressSchema,
        })
        .strict(),
    ]),
    returns: genericSemanticResultSchema,
    agentFacing: false,
  },
  vcsDropContext: {
    description: "Drop one semantic context.",
    args: z.tuple([z.object({ contextId: nonemptyText }).strict()]),
    returns: z.object({ dropped: z.boolean() }).strict(),
    agentFacing: false,
  },
  resolveRef: {
    description: "Resolve one generic semantic reference.",
    args: z.tuple([z.object({ refName: nonemptyText }).strict()]),
    returns: refRecordSchema.nullable(),
    agentFacing: false,
  },
  updateRef: {
    description: "Update one generic semantic reference with optional CAS.",
    args: z.tuple([
      z
        .object({
          refName: nonemptyText,
          kind: nonemptyText,
          target: GadJsonValueSchema,
          expected: GadJsonValueSchema.optional(),
        })
        .strict(),
    ]),
    returns: refRecordSchema,
    agentFacing: false,
  },
  deleteRef: {
    description: "Delete one generic semantic reference.",
    args: z.tuple([z.object({ refName: nonemptyText }).strict()]),
    returns: z.object({ deleted: z.number().int().min(0).max(1) }).strict(),
    agentFacing: false,
  },
  deleteLogHead: {
    description: "Delete one exact log head.",
    args: z.tuple([z.object({ logId: nonemptyText, head: nonemptyText }).strict()]),
    returns: z.object({ deleted: z.boolean() }).strict(),
    agentFacing: false,
  },
  listRefs: {
    description: "List generic references by kind or prefix.",
    args: z.tuple([
      z.object({ kind: z.string().nullish(), prefix: z.string().nullish() }).strict().optional(),
    ]),
    returns: z.array(refRecordSchema),
    agentFacing: false,
  },
  listRefLog: {
    description: "List the mutation log for one generic reference.",
    args: z.tuple([
      z.object({ refName: nonemptyText, limit: z.number().int().positive().nullish() }).strict(),
    ]),
    returns: z.array(refLogRecordSchema),
    agentFacing: false,
  },
  getLogHead: {
    description: "Read one exact log head.",
    args: z.tuple([z.object({ logId: nonemptyText, head: nonemptyText }).strict()]),
    returns: logHeadSchema.nullable(),
    agentFacing: false,
  },
  getLogLineage: {
    description: "Read the fork lineage of one log head.",
    args: z.tuple([z.object({ logId: nonemptyText, head: nonemptyText.optional() }).strict()]),
    returns: z
      .object({
        parentLogId: nonemptyText.nullable(),
        forkSeq: z.number().int().nonnegative().nullable(),
        forkHash: nonemptyText.nullable(),
      })
      .strict(),
    agentFacing: false,
  },
  readLog: {
    description: "Read a bounded exact log range.",
    args: z.tuple([
      z
        .object({
          logId: nonemptyText,
          head: nonemptyText,
          afterSeq: z.number().int().nonnegative().nullish(),
          beforeSeq: z.number().int().nonnegative().nullish(),
          limit: z.number().int().nonnegative().nullish(),
          payloadKind: z.string().nullish(),
        })
        .strict(),
    ]),
    returns: z.array(logEnvelopeSchema),
    agentFacing: false,
  },
  getLogEvent: {
    description: "Read one exact log envelope.",
    args: z.tuple([
      z.object({ logId: nonemptyText, head: nonemptyText, envelopeId: nonemptyText }).strict(),
    ]),
    returns: logEnvelopeSchema.nullable(),
    agentFacing: false,
  },
  hasLogEvents: {
    description: "Return requested envelope identifiers present in a log lineage.",
    args: z.tuple([
      z
        .object({
          logId: nonemptyText,
          head: nonemptyText,
          envelopeIds: z.array(nonemptyText),
        })
        .strict(),
    ]),
    returns: z.array(nonemptyText),
    agentFacing: false,
  },
  appendLogEvent: {
    description: "Append exact events to one semantic log.",
    args: z.tuple([
      z
        .object({
          logId: nonemptyText,
          head: nonemptyText,
          logKind: nonemptyText,
          owner: LogOwnerWireSchema.nullish(),
          expectedHeadHash: z.string().nullish(),
          idempotency: z.enum(["exact", "idempotent-by-id"]).nullish(),
          events: z.array(logAppendEventSchema).min(1),
        })
        .strict(),
    ]),
    returns: appendLogResultSchema,
    agentFacing: false,
  },
  forkLog: {
    description: "Fork one log head into a new exact lineage.",
    args: z.tuple([forkLogInputSchema]),
    returns: forkLogResultSchema,
    agentFacing: false,
  },
  checkLogIntegrity: {
    description: "Validate durable log chains and head pointers.",
    args: z.tuple([
      z.object({ logId: z.string().nullish(), head: z.string().nullish() }).strict().optional(),
    ]),
    returns: z.object({ ok: z.boolean(), errors: z.array(logIntegrityErrorSchema) }).strict(),
    agentFacing: false,
  },
  indexMemoryFiles: {
    description: "Index exact file text for semantic recall.",
    args: z.tuple([
      z
        .object({
          files: z.array(
            z.object({ path: z.string(), contentHash: nonemptyText, text: z.string() }).strict()
          ),
          removedPaths: z.array(z.string()).nullish(),
        })
        .strict(),
    ]),
    returns: z.object({ indexed: z.number().int().nonnegative() }).strict(),
    agentFacing: false,
  },
  getMemoryIndexMarker: {
    description: "Read one memory-index state marker.",
    args: z.tuple([z.object({ key: nonemptyText }).strict()]),
    returns: z.object({ value: z.string().nullable() }).strict(),
    agentFacing: false,
  },
  setMemoryIndexMarker: {
    description: "Write one memory-index state marker.",
    args: z.tuple([z.object({ key: nonemptyText, value: z.string() }).strict()]),
    returns: z.void(),
    agentFacing: false,
  },
  recallMemory: {
    description: "Search bounded semantic memory with provenance.",
    args: z.tuple([
      z
        .object({
          query: z.string(),
          kinds: z.array(z.string()).nullish(),
          limit: z.number().int().positive().nullish(),
          pathPrefixes: z.array(z.string()).nullish(),
          recallKeywords: z.array(z.string()).nullish(),
        })
        .strict(),
    ]),
    returns: z
      .object({
        results: z.array(
          z
            .object({
              kind: nonemptyText,
              snippet: z.string(),
              score: z.number().nullable(),
              logId: z.string().nullable(),
              head: z.string().nullable(),
              eventId: z.string().nullable(),
              path: z.string().nullable(),
              contentHash: z.string().nullable(),
              anchor: GadJsonRecordSchema.nullable(),
              actor: GadJsonValueSchema,
              appendedAt: z.string().nullable(),
            })
            .strict()
        ),
      })
      .strict(),
    agentFacing: false,
  },
  getTrajectoryEvent: {
    description: "Read one trajectory event by exact identifier.",
    args: z.tuple([z.object({ eventId: nonemptyText }).strict()]),
    returns: TrajectoryEventWireSchema.nullable(),
    agentFacing: false,
  },
  forkTrajectoryBranch: {
    description: "Fork one trajectory branch at an exact semantic boundary.",
    args: z.tuple([
      z
        .object({
          fromTrajectoryId: nonemptyText,
          fromBranchId: nonemptyText,
          toTrajectoryId: nonemptyText,
          toBranchId: nonemptyText,
          throughSeq: z.number().int().nonnegative().nullish(),
          throughEventHash: z.string().nullish(),
          throughPublishedChannelId: z.string().nullish(),
          throughPublishedChannelSeq: z.number().int().nonnegative().nullish(),
          toPublishedChannelId: z.string().nullish(),
          owner: z
            .object({ kind: z.literal("agent"), id: nonemptyText })
            .strict()
            .nullish(),
        })
        .strict(),
    ]),
    returns: z
      .object({
        fromTrajectoryId: nonemptyText,
        fromBranchId: nonemptyText,
        toTrajectoryId: nonemptyText,
        toBranchId: nonemptyText,
        copied: z.number().int().nonnegative(),
        headEventId: z.string().nullable(),
        headEventHash: z.string().nullable(),
        lineage: z.array(
          z
            .object({
              sourceEventId: nonemptyText,
              forkEventId: nonemptyText,
              sourceSeq: z.number().int().nonnegative(),
              forkSeq: z.number().int().nonnegative(),
              sourceEventHash: nonemptyText,
              forkEventHash: nonemptyText,
            })
            .strict()
        ),
      })
      .strict(),
    agentFacing: false,
  },
  putChannelMembership: {
    description: "Project one versioned channel membership and invite.",
    args: z.tuple([channelInviteSchema.extend({ revision: z.number().int().nonnegative() })]),
    returns: z
      .object({ applied: z.boolean(), currentRevision: z.number().int().nonnegative() })
      .strict(),
    agentFacing: false,
  },
  deleteChannelMembership: {
    description: "Project one versioned channel membership removal.",
    args: z.tuple([channelInviteKeySchema.extend({ revision: z.number().int().nonnegative() })]),
    returns: z
      .object({
        applied: z.boolean(),
        currentRevision: z.number().int().nonnegative(),
        deleted: z.boolean(),
      })
      .strict(),
    agentFacing: false,
  },
  listChannelMembershipsForUser: {
    description: "List channels indexed for one workspace account.",
    args: z.tuple([z.object({ userId: nonemptyText }).strict()]),
    returns: z.object({ userId: nonemptyText, channelIds: z.array(nonemptyText) }).strict(),
    agentFacing: false,
  },
  purgeRevokedUserChannelIndexes: {
    description: "Purge remaining channel indexes for a revoked account.",
    args: z.tuple([z.object({ userId: nonemptyText }).strict()]),
    returns: z.void(),
    agentFacing: false,
  },
  deleteChannelInvite: {
    description: "Delete one channel invite from the workspace inbox.",
    args: z.tuple([channelInviteKeySchema]),
    returns: z.object({ deleted: z.boolean() }).strict(),
    agentFacing: false,
  },
  getChannelInvite: {
    description: "Read one pending channel invite.",
    args: z.tuple([channelInviteKeySchema]),
    returns: channelInviteSchema.nullable(),
    agentFacing: false,
  },
  rebuildTrajectoryProjections: {
    ...gadMethods.rebuildTrajectoryProjections,
    agentFacing: false,
  },
  getStatus: {
    ...gadMethods.status,
    agentFacing: false,
  },
  listChannelLogs: {
    description: "List canonical channel log identities.",
    args: z.tuple([]),
    returns: z.array(
      z
        .object({
          channelId: nonemptyText,
          logId: nonemptyText,
          createdAt: z.number().nullable(),
        })
        .strict()
    ),
    agentFacing: false,
  },
  validateGadHashes: {
    ...gadMethods.validateGadHashes,
    agentFacing: false,
  },
  clearDirtyAfterValidation: {
    ...gadMethods.clearDirtyAfterValidation,
    agentFacing: false,
  },
  checkGadIntegrity: {
    ...gadMethods.checkGadIntegrity,
    agentFacing: false,
  },
});

/** Actual GadWorkspaceDO RPC shapes. Keeping this explicit makes adapter
 * transforms reviewable and runtime-validatable instead of relying on casts. */
const rawGadWireMethods = defineServiceMethods({
  ...gadInternalWireMethods,
  ...semanticWireMethods,
  ...directGadWireMethods,
  getStatus: {
    ...publicStatus,
    agentFacing: false,
  },
  listUserNotificationsForMe: {
    ...publicListUserNotificationsForMe,
    agentFacing: false,
    returns: z.object({ notifications: z.array(UserNotificationSchema) }).strict(),
  },
  acknowledgeUserNotification: {
    ...publicAcknowledgeUserNotification,
    agentFacing: false,
    args: z.tuple([z.object({ id: z.string() }).strict()]),
    returns: z.object({ acknowledged: z.boolean() }).strict(),
  },
  deleteUserNotification: {
    ...publicDeleteUserNotification,
    agentFacing: false,
    args: z.tuple([z.object({ userId: z.string(), id: z.string() }).strict()]),
    returns: z.object({ deleted: z.boolean() }).strict(),
  },
});

type GadAuthorityGroup = {
  methods: readonly string[];
  capability: string;
  principals: readonly ("host" | "user" | "code")[];
  tier: "open" | "critical";
  sensitivity: "read" | "write" | "admin" | "destructive";
  effect?: MethodSchema["directEffect"];
};

const GAD_AUTHORITY_GROUPS: readonly GadAuthorityGroup[] = [
  {
    methods: ["ensureBlob", "rebuildTrajectoryProjections", "clearDirtyAfterValidation"],
    capability: "workspace.graph.write",
    principals: ["host", "user", "code"],
    tier: "open",
    sensitivity: "write",
    effect: { kind: "open" },
  },
  {
    methods: [
      "workspaceSourceInitializeExactSnapshot",
      "vcsSemanticEffectAck",
      "vcsEnsureContext",
      "vcsContextMaterializationCommand",
      "vcsForkContext",
    ],
    capability: "workspace.source.write",
    principals: ["host"],
    tier: "open",
    sensitivity: "write",
    effect: { kind: "open" },
  },
  {
    methods: [
      "workspaceSourceResolve",
      "workspaceSourceCurrent",
      "workspaceSourceInspectInitialization",
      "workspaceSourceHealth",
      "vcsPendingSemanticEffects",
      "vcsContentGcRoots",
      "vcsListContexts",
      "vcsReferencesReachable",
      "vcsIsStateDescendant",
      "listChannelMembershipsForUser",
    ],
    capability: "workspace.source.read",
    principals: ["host"],
    tier: "open",
    sensitivity: "read",
    effect: { kind: "open" },
  },
  {
    methods: Object.keys(semanticWireMethods),
    capability: "workspace.source.admin",
    principals: ["host"],
    tier: "open",
    sensitivity: "admin",
    effect: { kind: "open" },
  },
  {
    methods: ["vcsDropContext"],
    capability: "workspace.source.delete",
    principals: ["host"],
    tier: "open",
    sensitivity: "destructive",
    effect: { kind: "open" },
  },
  {
    methods: [
      "resolveRef",
      "listRefs",
      "listRefLog",
      "getLogHead",
      "getLogLineage",
      "readLog",
      "getLogEvent",
      "hasLogEvents",
      "checkLogIntegrity",
      "getMemoryIndexMarker",
      "recallMemory",
      "listTrajectoryEvents",
      "listTrajectoryBranches",
      "listTrajectoryInvocations",
      "listTrajectoryApprovals",
      "listChannelEnvelopes",
      "getTrajectoryEvent",
      "getTrajectoryBranchHead",
      "getChannelEnvelope",
      "readChannelEnvelopes",
      "inspectChannelEnvelopes",
      "listMessageTypes",
      "getMessageType",
      "getTrajectoryForEnvelope",
      "listPublishedEnvelopesForTrajectory",
      "getEnvelopesForTrajectory",
      "getPublishedArtifactsForTurn",
      "getPrivateLineageForPublishedEnvelope",
      "getDownstreamConsumers",
      "inspectPublicationIntegrity",
      "inspectTurnState",
      "inspectInvocationState",
      "diagnoseInvocation",
      "inspectChannelRoster",
      "inspectAgentHealth",
      "inspectStorageDiagnostics",
      "listStoredValueRefs",
      "getStatus",
      "listChannelLogs",
      "validateGadHashes",
      "checkGadIntegrity",
    ],
    capability: "workspace.graph.read",
    principals: ["host", "user", "code"],
    tier: "open",
    sensitivity: "read",
    effect: { kind: "open" },
  },
  {
    methods: [
      "updateRef",
      "appendLogEvent",
      "forkLog",
      "indexMemoryFiles",
      "setMemoryIndexMarker",
      "forkTrajectoryBranch",
      "appendChannelEnvelope",
      "putChannelMembership",
      "putUserNotification",
      "deleteUserNotification",
    ],
    capability: "workspace.graph.write",
    principals: ["host", "code"],
    tier: "open",
    sensitivity: "write",
    effect: { kind: "open" },
  },
  {
    methods: ["deleteRef", "deleteLogHead", "deleteChannelMembership", "deleteChannelInvite"],
    capability: "workspace.graph.delete",
    principals: ["host", "code"],
    tier: "critical",
    sensitivity: "destructive",
    effect: {
      kind: "userland-capability",
      capability: "workspace.graph.delete",
      resource: { kind: "receiver-object" },
    },
  },
  {
    methods: ["purgeRevokedUserChannelIndexes"],
    capability: "workspace.graph.delete",
    principals: ["host"],
    tier: "critical",
    sensitivity: "destructive",
    effect: {
      kind: "userland-capability",
      capability: "workspace.graph.delete",
      resource: { kind: "receiver-object" },
    },
  },
  {
    methods: ["getChannelInvite"],
    capability: "workspace.graph.read",
    principals: ["host", "code"],
    tier: "open",
    sensitivity: "read",
    effect: { kind: "open" },
  },
  {
    methods: ["listUserNotificationsForMe"],
    capability: "workspace.notifications.read",
    principals: ["user", "code"],
    tier: "open",
    sensitivity: "read",
    effect: { kind: "open" },
  },
  {
    methods: ["acknowledgeUserNotification"],
    capability: "workspace.notifications.write",
    principals: ["user", "code"],
    tier: "open",
    sensitivity: "write",
    effect: { kind: "open" },
  },
] as const;

function applyGadAuthority<const T extends ServiceMethodSchemas>(methods: T): T {
  const policies = new Map(
    GAD_AUTHORITY_GROUPS.flatMap((group) => group.methods.map((method) => [method, group] as const))
  );
  const declared = Object.keys(methods);
  if (policies.size !== declared.length || declared.some((method) => !policies.has(method))) {
    const missing = declared.filter((method) => !policies.has(method));
    const unknown = [...policies.keys()].filter((method) => !declared.includes(method));
    throw new Error(
      `GAD typed authority groups must classify every wire method exactly once; ` +
        `missing=[${missing.join(",")}], unknown=[${unknown.join(",")}]`
    );
  }
  return Object.fromEntries(
    Object.entries(methods).map(([method, schema]) => {
      const policy = policies.get(method)!;
      return [
        method,
        {
          ...schema,
          capability: policy.capability,
          authority: { principals: [...policy.principals] },
          tier: {
            tier: policy.tier,
            session: "family",
            rationale:
              policy.tier === "critical"
                ? "Destructive workspace-graph mutation requires explicit confirmation."
                : "Workspace-local semantic state operation inside the trusted workspace.",
          },
          directEffect: policy.effect,
          access: { ...schema.access, sensitivity: policy.sensitivity },
        },
      ];
    })
  ) as T;
}

export const gadWireMethods = applyGadAuthority(rawGadWireMethods);
