/**
 * Wire contract for owner-scoped agentic eval.
 *
 * Eval is deliberately handle based. `start` accepts an attenuation intent and
 * returns before preparation/execution; `get`/`events` observe the durable run,
 * and `cancel` is cooperative. `execute` is a client composition, never a
 * second server execution path.
 */

import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

export const evalResourceScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact"), key: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("prefix"), prefix: z.string() }).strict(),
  z.object({ kind: z.literal("origin"), origin: z.string().url() }).strict(),
  z.object({ kind: z.literal("domain"), domain: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("network"), value: z.literal("*") }).strict(),
]);

export const evalCapabilityScopeSchema = z
  .object({ capability: z.string().min(1), resource: evalResourceScopeSchema })
  .strict();

export const evalPreauthorizationIntentSchema = z.discriminatedUnion("plane", [
  z
    .object({
      plane: z.literal("host-service"),
      method: z.string().min(3),
      args: z.array(z.unknown()),
    })
    .strict(),
  z
    .object({
      plane: z.literal("workspace-do"),
      target: z
        .object({
          source: z.string().min(1),
          className: z.string().min(1),
          objectKey: z.string().min(1),
        })
        .strict(),
      method: z.string().min(1),
      args: z.array(z.unknown()),
    })
    .strict(),
]);
export type EvalPreauthorizationIntent = z.infer<typeof evalPreauthorizationIntentSchema>;

export const evalAuthorityIntentSchema = z
  .object({
    mode: z.enum(["adaptive", "strict"]).optional(),
    effects: z.enum(["read-only", "mutable"]).optional(),
    approvals: z.enum(["prompt", "pregranted-only"]).optional(),
    requests: z.array(evalCapabilityScopeSchema).max(256).optional(),
    preauthorize: z.array(evalPreauthorizationIntentSchema).max(32).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode !== "strict" && value.requests !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requests"],
        message: "requests are valid only in strict mode",
      });
    }
    if (value.approvals === "pregranted-only" && (value.preauthorize?.length ?? 0) > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["preauthorize"],
        message: "preauthorization requires approvals:'prompt'",
      });
    }
  });
export type EvalAuthorityIntent = z.infer<typeof evalAuthorityIntentSchema>;

export const evalSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("inline"),
      code: z.string(),
      pathHint: z.string().min(1).optional(),
      syntax: z.enum(["javascript", "typescript", "jsx", "tsx"]).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("context-file"),
      path: z.string().min(1),
      syntax: z.enum(["javascript", "typescript", "jsx", "tsx"]).optional(),
    })
    .strict(),
]);
export type EvalSource = z.infer<typeof evalSourceSchema>;

/**
 * Host-attached CLI/shell targeting is explicit and separately verified. It is
 * not an owner override hidden among ordinary eval fields.
 */
export const evalTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("caller") }).strict(),
  z
    .object({
      kind: z.literal("attached-session"),
      ownerId: z.string().min(1),
      contextId: z.string().min(1),
    })
    .strict(),
]);
export type EvalTarget = z.infer<typeof evalTargetSchema>;

export const evalScopeSchema = z
  .object({ key: z.string().min(1).max(256), reset: z.boolean().optional() })
  .strict();

export const evalStartInputSchema = z
  .object({
    source: evalSourceSchema,
    target: evalTargetSchema.optional(),
    scope: evalScopeSchema.optional(),
    imports: z.record(z.string().min(1)).optional(),
    deadlineMs: z.number().int().positive().optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
    authority: evalAuthorityIntentSchema.optional(),
    /** Agent-owned runs use this only to install the owner chat facade. The
     * service validates the owner from the authenticated caller. */
    channelId: z.string().min(1).optional(),
  })
  .strict();
export type EvalStartInput = z.infer<typeof evalStartInputSchema>;

/** Opaque parent-host authority proof used only by the managed development
 * transport. The extension can relay these bytes but cannot mint or widen
 * them; the child verifies the Ed25519 signature and every generation/input
 * binding before accepting the ordinary start intent. */
export const evalParentAuthorityEnvelopeSchema = z
  .object({
    payload: z
      .string()
      .min(32)
      .max(128 * 1024),
    signature: z.string().min(64).max(256),
  })
  .strict();
export type EvalParentAuthorityEnvelope = z.infer<typeof evalParentAuthorityEnvelopeSchema>;

/** Short-lived signed proof that the parent challenge route was live
 * immediately before the managed child accepted a prompt-capable run. */
export const evalParentApprovalRouteProofSchema = z
  .object({
    payload: z
      .string()
      .min(32)
      .max(64 * 1024),
    signature: z.string().min(64).max(256),
  })
  .strict();
export type EvalParentApprovalRouteProof = z.infer<typeof evalParentApprovalRouteProofSchema>;

export const evalRunStateSchema = z.enum([
  "accepted",
  "queued",
  "preparing",
  "awaiting-preparation-challenge",
  "awaiting-preauthorization",
  "running",
  "awaiting-challenge",
  "approval-route-lost",
  "cancellation-requested",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "interrupted",
]);
export type EvalRunState = z.infer<typeof evalRunStateSchema>;

export const evalRunHandleSchema = z
  .object({
    runId: z.string().min(1),
    status: evalRunStateSchema,
    acceptedAt: z.number(),
    startIntentDigest: sha256Schema,
  })
  .strict();
export type EvalRunHandle = z.infer<typeof evalRunHandleSchema>;

export const evalRunResultSchema = z
  .object({
    success: z.boolean(),
    console: z.string(),
    returnValue: z.unknown().optional(),
    error: z.string().optional(),
    errorCode: z.string().optional(),
    scopeKeys: z.array(z.string()).optional(),
    authority: z
      .object({
        manifestDigest: sha256Schema,
        activated: z.array(evalCapabilityScopeSchema),
        approvalsRequested: z.number().int().nonnegative(),
        approvalsReused: z.number().int().nonnegative(),
        approvalsDenied: z.number().int().nonnegative(),
        constraintFailures: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    provenance: z
      .object({
        startIntentDigest: sha256Schema,
        sourceDigest: sha256Schema.nullable(),
        executionProvenanceDigest: sha256Schema.nullable(),
        scopeInputRevision: z.string().nullable(),
        runDigest: sha256Schema.nullable(),
        sourceBundleDigest: sha256Schema.nullable(),
        manifestDigest: sha256Schema.nullable(),
        terminalReason: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
export type EvalRunResult = z.infer<typeof evalRunResultSchema>;

export const evalRunSnapshotSchema = z
  .object({
    runId: z.string(),
    status: evalRunStateSchema,
    acceptedAt: z.number(),
    startedAt: z.number().nullable(),
    endedAt: z.number().nullable(),
    deadlineAt: z.number().nullable(),
    startIntentDigest: sha256Schema,
    sourceDigest: sha256Schema.nullable(),
    executionProvenanceDigest: sha256Schema.nullable(),
    scopeInputRevision: z.string().nullable(),
    runDigest: sha256Schema.nullable(),
    sourceBundleDigest: sha256Schema.nullable(),
    manifestDigest: sha256Schema.nullable(),
    result: evalRunResultSchema.optional(),
    progress: z.unknown().optional(),
    terminalReason: z.string().nullable(),
  })
  .strict();
export type EvalRunSnapshot = z.infer<typeof evalRunSnapshotSchema>;

export const evalRunEventSchema = z
  .object({
    seq: z.number().int().positive(),
    at: z.number(),
    type: z.string().min(1),
    status: evalRunStateSchema.optional(),
    detail: z.unknown().optional(),
  })
  .strict();
export type EvalRunEvent = z.infer<typeof evalRunEventSchema>;

const evalRouteSchema = z
  .object({
    target: evalTargetSchema.optional(),
    scope: z
      .object({ key: z.string().min(1).max(256) })
      .strict()
      .optional(),
  })
  .strict();

export const evalGetInputSchema = evalRouteSchema.extend({ runId: z.string().min(1) }).strict();
export type EvalGetInput = z.infer<typeof evalGetInputSchema>;
export const evalEventsInputSchema = evalGetInputSchema
  .extend({ after: z.number().int().nonnegative().optional() })
  .strict();
export type EvalEventsInput = z.infer<typeof evalEventsInputSchema>;
export const evalCancelInputSchema = evalGetInputSchema;
export type EvalCancelInput = z.infer<typeof evalCancelInputSchema>;
export const evalResetInputSchema = evalRouteSchema;

export const evalReadScopeTextPageArgsSchema = evalRouteSchema
  .extend({
    key: z.string().min(1).max(512),
    offset: z.number().int().nonnegative(),
    limit: z
      .number()
      .int()
      .positive()
      .max(128 * 1024),
  })
  .strict();

export const evalDeleteScopeValueArgsSchema = evalRouteSchema
  .extend({ key: z.string().min(1).max(512) })
  .strict();

export const evalMethods = defineServiceMethods({
  start: {
    args: z.tuple([evalStartInputSchema]),
    returns: evalRunHandleSchema,
    description:
      "Accept an owner-scoped eval run and return its durable handle. Defaults to adaptive, mutable, prompt-capable authority.",
    access: { sensitivity: "write" },
  },
  delegatedStart: {
    args: z.tuple([
      z
        .object({
          input: evalStartInputSchema,
          authority: evalParentAuthorityEnvelopeSchema,
          approvalRoute: evalParentApprovalRouteProofSchema.optional(),
        })
        .strict(),
    ]),
    returns: evalRunHandleSchema,
    description:
      "Managed child-host transport for a parent-attested eval initiator. Not an agent-facing execution API.",
    agentFacing: false,
    authority: { principals: ["user", "host"] },
    access: { sensitivity: "write" },
  },
  renew: {
    args: z.tuple([
      z.object({ runId: z.string().min(1), credential: z.string().min(32) }).strict(),
    ]),
    returns: z.object({ expiresAt: z.number() }).strict(),
    description: "Renew an active EvalDO invocation lease. Trusted eval-kernel lifecycle only.",
    agentFacing: false,
    authority: { principals: ["code", "host"] },
    access: { sensitivity: "write" },
  },
  beginCleanup: {
    args: z.tuple([
      z.object({ runId: z.string().min(1), credential: z.string().min(32) }).strict(),
    ]),
    returns: z.object({ expiresAt: z.number() }).strict(),
    description:
      "Enter the bounded terminal-cleanup phase for an active invocation. Trusted eval-kernel lifecycle only.",
    agentFacing: false,
    authority: { principals: ["code", "host"] },
    access: { sensitivity: "write" },
  },
  get: {
    args: z.tuple([evalGetInputSchema]),
    returns: evalRunSnapshotSchema,
    description: "Read the latest durable snapshot for an eval run.",
    access: { sensitivity: "read" },
  },
  events: {
    args: z.tuple([evalEventsInputSchema]),
    returns: z.object({ events: z.array(evalRunEventSchema), next: z.number().int() }).strict(),
    description: "Read a bounded page of run lifecycle, authority, and progress events.",
    access: { sensitivity: "read" },
  },
  cancel: {
    args: z.tuple([evalCancelInputSchema]),
    returns: z.object({ status: z.enum(["requested", "cancelled", "terminal"]) }).strict(),
    description:
      "Request cooperative cancellation, settle bounded structured cleanup, then invalidate run authority.",
    access: { sensitivity: "write" },
  },
  reset: {
    args: z.union([z.tuple([]), z.tuple([evalResetInputSchema])]),
    returns: z.object({ status: z.enum(["reset", "waiting-for-safe-boundary"]) }).strict(),
    description: "Reset durable eval scope at a safe execution boundary.",
    access: { sensitivity: "destructive" },
  },
  forceReset: {
    args: z.union([z.tuple([]), z.tuple([evalResetInputSchema])]),
    returns: z
      .object({ status: z.enum(["requested", "reset", "requires-process-restart"]) })
      .strict(),
    description:
      "Invalidate live authority immediately and reset only after execution reaches a safe boundary.",
    access: { sensitivity: "destructive" },
  },
  readScopeTextPage: {
    args: z.tuple([evalReadScopeTextPageArgsSchema]),
    returns: z
      .object({
        length: z.number().int().nonnegative(),
        encoding: z.literal("utf16le-base64"),
        chunk: z.string(),
      })
      .strict(),
    description: "Read a bounded lossless page from a string in durable eval scope.",
    access: { sensitivity: "read" },
  },
  deleteScopeValue: {
    args: z.tuple([evalDeleteScopeValueArgsSchema]),
    returns: z.object({ ok: z.boolean(), existed: z.boolean() }).strict(),
    description: "Delete one value from durable eval scope.",
    access: { sensitivity: "write" },
  },
});
