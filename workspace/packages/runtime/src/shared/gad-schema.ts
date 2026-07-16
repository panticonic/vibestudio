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
import { defineServiceMethods, type MethodSchema } from "@vibestudio/shared/typedServiceClient";
import { channelEnvelopeSchema, trajectoryEventSchema } from "@workspace/agentic-protocol";

const readAccess = { sensitivity: "read" as const };
const writeAccess = { sensitivity: "write" as const };
const adminAccess = { sensitivity: "admin" as const };

export const GadJsonRecordSchema = z.record(z.unknown());
export type GadJsonRecord = z.infer<typeof GadJsonRecordSchema>;

export const GadSqlBindingSchema = z.union([
  z.null(),
  z.string(),
  z.number(),
  z.boolean(),
  z.instanceof(Uint8Array),
]);
export type GadSqlBinding = z.infer<typeof GadSqlBindingSchema>;

export const GadSqlInputSchema = z.union([
  z.string(),
  z
    .object({
      sql: z.string(),
      params: z.array(GadSqlBindingSchema).optional(),
      bindings: z.array(GadSqlBindingSchema).optional(),
    })
    .strict(),
]);
export type GadSqlInput = z.infer<typeof GadSqlInputSchema>;

export const GadSqlResultSchema = z.object({ rows: z.array(GadJsonRecordSchema) }).strict();
export type GadSqlResult = z.infer<typeof GadSqlResultSchema>;

export const GadStatusMetricSchema = z.object({ metric: z.string(), value: z.number() }).strict();
export type GadStatusMetric = z.infer<typeof GadStatusMetricSchema>;

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

const TrajectoryEventWireSchema = trajectoryEventSchema;

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
    payloadSummary: z.unknown(),
    storedRefs: z.array(GadJsonRecordSchema),
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
    rows: z.array(GadJsonRecordSchema),
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
    rows: z.array(GadJsonRecordSchema),
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
    rows: z.array(GadJsonRecordSchema),
  })
  .strict();
export type InvocationStateInspection = z.infer<typeof InvocationStateInspectionSchema>;

export const ChannelRosterInspectionSchema = z
  .object({
    summary: z
      .object({
        rows: z.number().int().nonnegative(),
        activeParticipants: z.number().int().nonnegative(),
        inactiveParticipants: z.number().int().nonnegative(),
      })
      .strict(),
    rows: z.array(GadJsonRecordSchema),
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
    storage: z.object({ rows: z.array(GadJsonRecordSchema) }).strict(),
  })
  .strict();
export type AgentHealthInspection = z.infer<typeof AgentHealthInspectionSchema>;

export const ChannelMessageTypeDefinitionSchema = z
  .object({
    typeId: z.string(),
    displayMode: z.enum(["inline", "row"]),
    source: z.union([
      z.object({ type: z.literal("code"), code: z.string() }).strict(),
      z.object({ type: z.literal("file"), path: z.string() }).strict(),
    ]),
    imports: z.record(z.string()).optional(),
    stateSchema: GadJsonRecordSchema.optional(),
    updateSchema: GadJsonRecordSchema.optional(),
    registeredBy: GadJsonRecordSchema.optional(),
    updatedAtSeq: z.number().int().nonnegative(),
    clearedAtSeq: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ChannelMessageTypeDefinition = z.infer<typeof ChannelMessageTypeDefinitionSchema>;

export const RegistryMutationInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("upsertMessageType"),
      typeId: z.string(),
      row: ChannelMessageTypeDefinitionSchema.omit({
        typeId: true,
        updatedAtSeq: true,
        clearedAtSeq: true,
      }),
    })
    .strict(),
  z.object({ kind: z.literal("clearMessageType"), typeId: z.string() }).strict(),
]);
export type RegistryMutationInput = z.infer<typeof RegistryMutationInputSchema>;

const ChannelEnvelopeAppendInputSchema = channelEnvelopeSchema
  .omit({ seq: true, envelopeId: true, publishedAt: true })
  .extend({
    envelopeId: z.string().nullish(),
    publishedAt: z.string().nullish(),
  });

const ChannelEnvelopeAppendWithRegistryInputSchema = ChannelEnvelopeAppendInputSchema.extend({
  registryMutation: RegistryMutationInputSchema,
});

const UserNotificationSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    kind: z.string(),
    title: z.string(),
    message: z.string().optional(),
    data: z.unknown().optional(),
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

/** Ergonomic, portable runtime facade. Its SQL-object overload, `status`
 * naming, and scalar notification results intentionally differ from the DO's
 * transport shapes; `gadWireMethods` below owns that internal boundary. */
export const gadMethods = defineServiceMethods({
  rawSql: {
    description: "Execute SQL against the workspace GAD database and return result rows.",
    args: z.tuple([GadSqlInputSchema, z.array(GadSqlBindingSchema).optional()]),
    returns: GadSqlResultSchema,
    access: adminAccess,
  },
  query: {
    description: "Execute a read-oriented SQL query against the workspace GAD database.",
    args: z.tuple([GadSqlInputSchema, z.array(GadSqlBindingSchema).optional()]),
    returns: GadSqlResultSchema,
    access: readAccess,
  },
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
    returns: GadJsonRecordSchema.nullable(),
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
  appendChannelEnvelopeWithRegistryMutation: {
    description: "Append an envelope and its message-type registry mutation atomically.",
    args: z.tuple([ChannelEnvelopeAppendWithRegistryInputSchema]),
    returns: channelEnvelopeSchema,
    access: writeAccess,
  },
  listMessageTypes: {
    description: "List active custom message-type definitions for a channel.",
    args: z.tuple([z.object({ channelId: z.string() }).strict()]),
    returns: z.array(ChannelMessageTypeDefinitionSchema),
    access: readAccess,
  },
  getMessageType: {
    description: "Get one custom message-type definition from a channel registry.",
    args: z.tuple([z.object({ channelId: z.string(), typeId: z.string() }).strict()]),
    returns: ChannelMessageTypeDefinitionSchema.nullable(),
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
    returns: z.object({ rows: z.array(GadJsonRecordSchema) }).strict(),
    access: readAccess,
  },
  inspectStorageDiagnostics: {
    description: "Inspect oversized or unresolved durable storage rows with bounded output.",
    args: z.tuple([InspectStorageDiagnosticsInputSchema.optional()]),
    returns: z.object({ rows: z.array(GadJsonRecordSchema) }).strict(),
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
    returns: z.object({ ok: z.boolean(), errors: z.array(GadJsonRecordSchema) }).strict(),
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
  rawSql: publicRawSql,
  query: publicQuery,
  status: publicStatus,
  listUserNotificationsForMe: publicListUserNotificationsForMe,
  acknowledgeUserNotification: publicAcknowledgeUserNotification,
  deleteUserNotification: publicDeleteUserNotification,
  ...directGadWireMethods
} = gadMethods;

/** Actual GadWorkspaceDO RPC shapes. Keeping this explicit makes adapter
 * transforms reviewable and runtime-validatable instead of relying on casts. */
export const gadWireMethods = defineServiceMethods({
  ...directGadWireMethods,
  rawSql: {
    ...publicRawSql,
    agentFacing: false,
    args: z.tuple([z.string(), z.array(GadSqlBindingSchema).optional()]),
  },
  query: {
    ...publicQuery,
    agentFacing: false,
    args: z.tuple([z.string(), z.array(GadSqlBindingSchema).optional()]),
  },
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
