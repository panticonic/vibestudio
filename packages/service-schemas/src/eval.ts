/**
 * The data shapes of dynamic code run as eval (docs/dolt-redesign.md §7): a run's intent, its
 * result and receipt, its events, and the kernel's status. The calls themselves are the host's
 * `dynamicCode` service (admission) and the hosting entity's own methods (`dynamicCode.ts`).
 */

import { z } from "zod";
import { rpcFailureSchema } from "./rpcFailure.js";
import { CapabilityScopeSchema } from "./build.js";
import { sha256HexSyncText } from "@vibestudio/content-addressing";

const EVAL_RPC_FINGERPRINT_MAX_CHARS = 64 * 1024;
const EVAL_RPC_FINGERPRINT_MAX_NODES = 8192;
const EVAL_RPC_FINGERPRINT_MAX_DEPTH = 64;

export const evalRpcFingerprintSchema = z.discriminatedUnion("available", [
  z
    .object({ available: z.literal(true), fingerprint: z.string().regex(/^[0-9a-f]{64}$/u) })
    .strict(),
  z
    .object({
      available: z.literal(false),
      reason: z.enum(["unsupported", "too-large", "unreadable"]),
    })
    .strict(),
]);
export type EvalRpcFingerprint = z.infer<typeof evalRpcFingerprintSchema>;
/**
 * Host evidence for one evaluated-code RPC dispatch. Receiver results are
 * committed only as bounded one-way fingerprints; arguments and main-service
 * results remain covered by existing semantic projections. A fingerprint is
 * evidence identity, not a confidentiality boundary.
 */
export const evalRpcCallObservationSchema = z
  .object({
    protocol: z.literal("rpc-call-observation.v1"),
    ownerId: z.string().min(1),
    ownerGeneration: z.string().uuid(),
    callId: z.number().int().nonnegative(),
    admissionOrder: z.number().int().nonnegative(),
    settlementOrder: z.number().int().nonnegative(),
    targetId: z.string().min(1),
    method: z.string().min(1),
    outcome: z.enum(["fulfilled", "rejected"]),
    result: evalRpcFingerprintSchema.optional(),
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (receipt.settlementOrder <= receipt.admissionOrder) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "RPC settlement must follow admission in the execution event order",
      });
    }
    if (receipt.outcome === "rejected" && receipt.result !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Rejected RPC calls cannot carry a result fingerprint",
      });
    }
  });
export type EvalRpcCallObservation = z.infer<typeof evalRpcCallObservationSchema>;

const evalWorkerCreationObservationSchema = z.object({
  protocol: z.literal("worker-lifecycle-observation.v1"),
  callId: z.number().int().nonnegative(),
  operation: z.literal("create"),
  entityId: z.string().min(1),
  targetId: z.string().min(1),
  source: z.string().min(1),
  objectKey: z.string().optional(),
});
export const evalWorkerLifecycleObservationSchema = z.union([
  z.discriminatedUnion("kind", [
    evalWorkerCreationObservationSchema
      .extend({ kind: z.literal("do"), className: z.string().min(1) })
      .strict(),
    evalWorkerCreationObservationSchema.extend({ kind: z.literal("worker") }).strict(),
  ]),
  z
    .object({
      protocol: z.literal("worker-lifecycle-observation.v1"),
      callId: z.number().int().nonnegative(),
      operation: z.literal("resolve"),
      targetId: z.string().min(1),
      source: z.string().min(1),
      className: z.string().min(1),
      objectKey: z.string().min(1),
    })
    .strict(),
  z
    .object({
      protocol: z.literal("worker-lifecycle-observation.v1"),
      callId: z.number().int().nonnegative(),
      operation: z.literal("resolve-service"),
      query: z.string(),
      serviceName: z.string(),
      targetId: z.string().min(1),
      source: z.string().min(1),
      className: z.string().min(1),
      objectKey: z.string().min(1),
    })
    .strict(),
  z
    .object({
      protocol: z.literal("worker-lifecycle-observation.v1"),
      callId: z.number().int().nonnegative(),
      operation: z.literal("retire"),
      entityId: z.string().min(1),
    })
    .strict(),
]);
export type EvalWorkerLifecycleObservation = z.infer<typeof evalWorkerLifecycleObservationSchema>;

export type CapturedEvalRpcFingerprint =
  | { available: true; encoding: string }
  | { available: false; reason: "unsupported" | "too-large" | "unreadable" };

function compareEvalFingerprintKeys(left: string, right: string): number {
  // UTF-16 ordering distinguishes every JavaScript key, including unpaired
  // surrogates that a UTF-8 encoder would both replace with the same character.
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Capture deterministic canonical JSON under strict per-value size/depth/node bounds. */
function captureEvalRpcFingerprintWithin(
  value: unknown,
  maxChars: number
): CapturedEvalRpcFingerprint {
  let nodes = 0;
  let characters = 0;
  const spend = (count: number): void => {
    characters += count;
    if (characters > maxChars) throw "too-large";
  };
  const ancestors = new Set<object>();
  const encode = (current: unknown, depth: number, arrayValue = false): string => {
    nodes += 1;
    if (nodes > EVAL_RPC_FINGERPRINT_MAX_NODES || depth > EVAL_RPC_FINGERPRINT_MAX_DEPTH) {
      throw "too-large";
    }
    let encoded: string;
    if (current === null) encoded = "null";
    else if (typeof current === "string") {
      if (current.length > maxChars) throw "too-large";
      encoded = JSON.stringify(current);
    } else if (typeof current === "boolean") encoded = current ? "true" : "false";
    else if (typeof current === "number") {
      if (!Number.isFinite(current)) throw "unsupported";
      encoded = JSON.stringify(Object.is(current, -0) ? 0 : current);
    } else if (current === undefined && arrayValue) encoded = "null";
    else if (typeof current !== "object" || current === undefined) throw "unsupported";
    else {
      if (ancestors.has(current)) throw "unsupported";
      ancestors.add(current);
      try {
        if (Array.isArray(current)) {
          if (current.length > EVAL_RPC_FINGERPRINT_MAX_NODES) throw "too-large";
          spend(2 + Math.max(0, current.length - 1));
          const items: string[] = [];
          for (let index = 0; index < current.length; index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
            if (!descriptor) {
              spend(4);
              items.push("null");
            } else if (!("value" in descriptor)) throw "unreadable";
            else items.push(encode(descriptor.value, depth + 1, true));
          }
          encoded = `[${items.join(",")}]`;
        } else {
          const prototype = Object.getPrototypeOf(current);
          if (prototype !== Object.prototype && prototype !== null) throw "unsupported";
          const keys: string[] = [];
          for (const key in current) {
            if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
            keys.push(key);
            if (keys.length > EVAL_RPC_FINGERPRINT_MAX_NODES) throw "too-large";
          }
          let keyCharacters = 0;
          const normalized = keys.map((original) => {
            if (original.length > maxChars) throw "too-large";
            const key = original;
            keyCharacters += key.length;
            if (keyCharacters > maxChars) throw "too-large";
            return { original, key };
          });
          normalized.sort((left, right) => compareEvalFingerprintKeys(left.key, right.key));
          const seen = new Set<string>();
          const fields: string[] = [];
          spend(2);
          for (const { original, key } of normalized) {
            if (seen.has(key)) throw "unsupported";
            seen.add(key);
            const descriptor = Object.getOwnPropertyDescriptor(current, original);
            if (!descriptor || !descriptor.enumerable) continue;
            if (!("value" in descriptor)) throw "unreadable";
            const child = descriptor.value;
            if (child === undefined) continue;
            if (fields.length > 0) spend(1);
            spend(JSON.stringify(key).length + 1);
            fields.push(`${JSON.stringify(key)}:${encode(child, depth + 1)}`);
          }
          encoded = `{${fields.join(",")}}`;
        }
      } finally {
        ancestors.delete(current);
      }
    }
    if (typeof current !== "object" || current === null) spend(encoded.length);
    if (encoded.length > maxChars) throw "too-large";
    return encoded;
  };
  try {
    return { available: true, encoding: encode(value, 0) };
  } catch (reason) {
    return {
      available: false,
      reason:
        reason === "too-large"
          ? "too-large"
          : reason === "unreadable"
            ? "unreadable"
            : "unsupported",
    };
  }
}

export function captureEvalRpcFingerprint(value: unknown): CapturedEvalRpcFingerprint {
  return captureEvalRpcFingerprintWithin(value, EVAL_RPC_FINGERPRINT_MAX_CHARS);
}

/** Hash the captured canonical encoding; hashing never needs the mutable guest value again. */
export function finishEvalRpcFingerprint(captured: CapturedEvalRpcFingerprint): EvalRpcFingerprint {
  if (!captured.available) return captured;
  try {
    return { available: true, fingerprint: sha256HexSyncText(captured.encoding) };
  } catch {
    return { available: false, reason: "unreadable" };
  }
}

/** Convenience for validators fingerprinting values they actually observed. */
export function fingerprintEvalRpcValue(value: unknown): EvalRpcFingerprint {
  return finishEvalRpcFingerprint(captureEvalRpcFingerprint(value));
}

export { mapEvalResultLeaves } from "./eval/resultTree.js";

/**
 * Maximum serialized return preview carried in one terminal eval result.
 * Consumers that return a page through eval must stay below this wire budget
 * after worst-case JSON escaping.
 */
export const EVAL_RESULT_RETURN_PREVIEW_CHARS = 12_000;
export const EVAL_OPERATION_JOURNAL_MAX_ENTRIES = 100;
export const EVAL_OPERATION_JOURNAL_PREVIEW_CHARS = 24_000;
export const evalOperationJournalSchema = z
  .object({
    protocol: z.literal("workspace-operations.v1"),
    entries: z.array(z.record(z.unknown())).max(EVAL_OPERATION_JOURNAL_MAX_ENTRIES),
    truncated: z.boolean(),
  })
  .strict();
export type EvalOperationJournal = z.infer<typeof evalOperationJournalSchema>;

/** Binary eval results have artifact ownership and do not consume JSON preview space. */
export const evalImagePayloadSchema = z
  .object({
    data: z.string().min(1),
    mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  })
  .strict();
export const evalImageArtifactSchema = evalImagePayloadSchema
  .omit({ data: true })
  .extend({
    protocol: z.literal("eval-image-artifact.v1"),
    digest: z.string().regex(/^[0-9a-f]{64}$/u),
    size: z.number().int().positive(),
  })
  .strict();

/**
 * Host-emitted eval lifecycle failure codes (the kernel's `RunResult.failureCode`
 * values for terminations the runtime itself decides). The wire field stays an
 * open string — engine/user code may surface its own codes — but every host
 * lifecycle termination uses exactly one of these, so drivers can branch on
 * them without string drift.
 *
 * The two infrastructure codes are deliberately distinct rather than unified:
 * - `eval_runtime_restarted` — an UNPLANNED process loss (crash/kill) orphaned a
 *   `running` row; stamped by the kernel's boot orphan-reconcile. Nothing had a
 *   chance to cancel cleanly.
 * - `runtime_generation_lost` — a PLANNED lifecycle transition (workerd
 *   suspend/replace) cancelled the run through the normal cooperative path.
 *   Infrastructure-typed so it can never be mistaken for user cancellation
 *   (`eval_cancelled`), and distinct from the crash code because the driver may
 *   trust that owned cleanup ran.
 */
export const evalLifecycleFailureCodes = {
  /** infrastructure: unplanned process loss orphaned a running row (boot orphan-reconcile). */
  runtimeRestarted: "eval_runtime_restarted",
  /** infrastructure: a planned runtime lifecycle transition retired the generation executing this run. */
  runtimeGenerationLost: "runtime_generation_lost",
  /** infrastructure: the host admission backing an evaluated execution expired or no longer matches. */
  executionAdmissionLost: "eval_execution_admission_lost",
  /** cancelled: the caller's own opt-in deadline elapsed. */
  deadlineExceeded: "eval_deadline_exceeded",
  /** cancelled: explicit owner/user cancellation. */
  cancelled: "eval_cancelled",
} as const;
export type EvalLifecycleFailureCode =
  (typeof evalLifecycleFailureCodes)[keyof typeof evalLifecycleFailureCodes];

export const evalTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("caller") }).strict(),
  z.object({ kind: z.literal("owner-session"), sessionId: z.string().min(1) }).strict(),
]);

const evalRouteShape = {
  /**
   * Host surfaces may select a live owner session. The server resolves the
   * owner and context from that session's registered entity; callers never
   * supply owner/context relationship facts independently.
   */
  target: evalTargetSchema.optional(),
  /** Logical scope key (default "default") — lets one owner keep multiple eval notebooks. */
  scopeKey: z.string().min(1).optional(),
};

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

export const evalScopeSchema = z
  .object({
    key: z.string().min(1),
    lifecycle: z.enum(["persistent", "finite"]).optional(),
  })
  .strict();

export const evalPreauthorizationIntentSchema = z
  .object({
    /** Canonical host-service operation. The dispatcher resolves every
     * capability/resource/tier fact from this exact method and argument list. */
    service: z.string().min(1),
    method: z.string().min(1),
    args: z.array(z.unknown()).max(64),
  })
  .strict();

const evalAuthorityIntentShape = {
  effects: z.enum(["read-only", "read-write"]).default("read-write"),
  approvals: z.enum(["prompt", "pregranted-only"]).default("prompt"),
  requests: z.array(CapabilityScopeSchema).max(256).optional(),
  preauthorize: z.array(evalPreauthorizationIntentSchema).max(64).optional(),
};

function refineEvalAuthorityIntent(
  value: {
    approvals?: "prompt" | "pregranted-only";
    preauthorize?: unknown;
  },
  ctx: z.RefinementCtx
): void {
  // An empty collection carries no preauthorization intent. Treat it as the
  // neutral value so JSON-schema clients that materialize optional arrays do
  // not turn absence into an authority-mode conflict.
  if (
    Array.isArray(value.preauthorize) &&
    value.preauthorize.length > 0 &&
    (value.approvals ?? "prompt") !== "prompt"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "preauthorize is valid only when authority.approvals is prompt",
      path: ["preauthorize"],
    });
  }
}

export const evalAuthorityIntentSchema = z
  .object(evalAuthorityIntentShape)
  .strict()
  .superRefine(refineEvalAuthorityIntent);
export const evalAuthorityInputSchema = z
  .object(evalAuthorityIntentShape)
  .partial()
  .strict()
  .superRefine(refineEvalAuthorityIntent);
export type EvalAuthorityIntent = z.infer<typeof evalAuthorityIntentSchema>;

export function normalizeEvalAuthorityIntent(
  authority: Partial<EvalAuthorityIntent> | undefined
): EvalAuthorityIntent {
  return evalAuthorityIntentSchema.parse(authority ?? {});
}

export const evalStartInputSchema = z
  .object({
    target: evalTargetSchema.optional(),
    source: evalSourceSchema,
    /**
     * Declare that this eval scope is an owned finite resource. Finite scopes may
     * be disposed without an interactive destructive-data confirmation after
     * their result has been copied out. The declaration is bound immutably to
     * the session entity on first activation; a persistent scope cannot later be
     * reclassified as finite.
     */
    scope: evalScopeSchema.optional(),
    /** Atomically clear this owner's scope and user db before this run is inserted/executed. */
    reset: z.boolean().optional(),
    /** On-demand package builds (e.g. { "lodash": "npm:^4.17.21" }). */
    imports: z.record(z.string()).optional(),
    /** Caller-owned idempotent run identity (agents derive it from the tool invocation id). */
    runId: z.string().min(1),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Optional whole-run wall-clock deadline in milliseconds. Omit for no deadline."),
    /**
     * Per-run attenuation. This can only narrow the authority already admitted
     * by receiver declarations, sealed code, live grants, and relationships.
     * Omit `requests` to adapt to that admitted authority; provide it (including
     * an empty list) to enforce an exact per-run allowlist.
     */
    authority: evalAuthorityInputSchema.optional(),
  })
  .strict();
export type EvalStartInput = z.infer<typeof evalStartInputSchema>;

export const evalKernelStatusSchema = z
  .object({
    /** Exact in-memory notebook incarnation that produced this result. */
    incarnationId: z.string().min(1),
    startedAt: z.number().int().nonnegative(),
    /** First-result-only lifecycle event for this incarnation. */
    event: z
      .object({
        kind: z.enum(["started", "restarted"]),
        recovery: z.union([
          z
            .object({
              status: z.literal("complete"),
              restored: z.array(z.string()),
              lost: z.array(z.string()),
            })
            .strict(),
          z.object({ status: z.literal("unavailable") }).strict(),
        ]),
        /**
         * Set on the first result of a scope whose notebook belonged to the retired
         * product notebook class (docs/dolt-redesign.md §7.10, D5): its scope values and its
         * `db` tables were dropped when the workspace moved to the kernel class.
         */
        legacyNotebookDropped: z.literal(true).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** One natlang call made by an eval cell (provider-reported, bounded by the provider). */
export const evalNatlangCallSummarySchema = z
  .object({
    callId: z.string(),
    name: z.string(),
    outcome: z.string(),
    detail: z.string().optional(),
    model: z.string().optional(),
    turns: z.number(),
    promptTokens: z.number(),
    completionTokens: z.number(),
    durationMs: z.number(),
    recordId: z.string().optional(),
    /** Why a failed call failed (the provider's typed reason, as in its failure's `errorData.reason`). */
    reason: z.string().optional(),
    /**
     * A finite-result call's decision readout: the value its model's scores chose and how sure they were
     * (`mode: "scored"`), or that the model could not score and the call ran the tool loop instead (`mode:
     * "tool-loop"`, with natlang's `reason`).
     */
    decision: z
      .discriminatedUnion("mode", [
        z
          .object({
            mode: z.literal("scored"),
            value: z.string(),
            p: z.number(),
            runnerUp: z.string().optional(),
            pRunnerUp: z.number().optional(),
          })
          .strict(),
        z.object({ mode: z.literal("tool-loop"), reason: z.string() }).strict(),
      ])
      .optional(),
  })
  .strict();
export type EvalNatlangCallSummary = z.infer<typeof evalNatlangCallSummarySchema>;

/** Most calls one result carries; `omitted` counts the rest. */
export const EVAL_NATLANG_RESULT_MAX_CALLS = 200;

export const evalNatlangResultSchema = z
  .object({
    calls: z.array(evalNatlangCallSummarySchema).max(EVAL_NATLANG_RESULT_MAX_CALLS),
    omitted: z.number().int().positive().optional(),
  })
  .strict();
export type EvalNatlangResult = z.infer<typeof evalNatlangResultSchema>;

export const evalRunResultSchema = z
  .object({
    success: z.boolean(),
    /** Formatted console output captured during the run. Oversized output may be windowed; read
     *  `scope.$lastLargeConsole` in follow-up evals for the bounded saved copy. */
    console: z.string(),
    /** Safe-serialized return value (present on success). Oversized values may be replaced with a
     *  structured truncation summary pointing at `scope.$lastLargeReturn`. */
    returnValue: z.unknown().optional(),
    /** Complete RPC failure graph (present on failure), including causes and aggregate errors. */
    error: rpcFailureSchema.optional(),
    /** Failure domain controls whether an agent may recover in-turn. */
    failureKind: z.enum(["user-code", "infrastructure", "cancelled"]).optional(),
    /** Stable machine-readable diagnostic, independent of displayed copy. */
    failureCode: z.string().optional(),
    /**
     * Structured failure details preserved from the sandbox exception.
     * Consumers use this for typed recovery (for example publication recovery);
     * it is diagnostic data, not display copy.
     */
    /** Keys currently held in the live notebook scope (for the agent's awareness). */
    scopeKeys: z.array(z.string()).optional(),
    /** Runtime-emitted completed operations, independent of the guest return value. */
    operationJournal: evalOperationJournalSchema.optional(),
    /** Panels opened by this eval kernel and not yet archived through its runtime surface. */
    panelResources: z
      .object({
        open: z
          .array(
            z
              .object({
                id: z.string(),
                source: z.string(),
                kind: z.enum(["workspace", "browser"]),
              })
              .strict()
          )
          .max(100),
      })
      .strict()
      .optional(),
    /** Natlang calls this cell made (omitted when it made none). */
    natlang: evalNatlangResultSchema.optional(),
    /** Notebook incarnation, residency, and exact cold-recovery diagnostics. */
    kernel: evalKernelStatusSchema.optional(),
  })
  .strict();

/** Args for reading one caller-owned durable run. */
export const evalGetArgsSchema = z
  .object({
    ...evalRouteShape,
    runId: z.string().min(1),
  })
  .strict();

/** An exact domain-owned terminal receipt; transport credentials are not its identity. */
export const evalResultIdentitySchema = z
  .object({
    runDigest: z.string().regex(/^[a-f0-9]{64}$/),
    resultDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const evalResultReceiptSchema = evalResultIdentitySchema
  .extend({
    runId: z.string().min(1),
    result: evalRunResultSchema,
    acknowledged: z.boolean(),
  })
  .strict();
export type EvalResultReceipt = z.infer<typeof evalResultReceiptSchema>;
/** Durable eval lifecycle. `cancelling` remains non-terminal while registered
 * cleanup still needs the run's evaluated-execution admission. */
export const evalRunStatusValueSchema = z.enum([
  "pending",
  "running",
  "cancelling",
  "done",
  "cancelled",
  "approval-route-lost",
  "unknown",
]);

/** A run's status + (when terminal) its result. */
export const evalRunStatusSchema = z
  .object({
    status: evalRunStatusValueSchema,
    result: evalRunResultSchema.optional(),
    /** Latest durable heartbeat published by the running sandbox. */
    progress: z.unknown().optional(),
    /** Latest host-owned execution checkpoint (for example the outbound RPC currently awaited). */
    checkpoint: z.unknown().optional(),
    /** Observable lifecycle state, distinct from execution/result status. */
    activity: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("executing") }).strict(),
        z.object({ kind: z.literal("authority-pending"), request: z.unknown() }).strict(),
        z
          .object({
            kind: z.literal("external-wait"),
            operation: z.string().min(1),
            resource: z.object({ kind: z.string().min(1), value: z.unknown() }).strict(),
            targetId: z.string().min(1),
            method: z.string().min(1),
          })
          .strict(),
        z.object({ kind: z.literal("cancelling") }).strict(),
      ])
      .optional(),
  })
  .strict();

export const evalResetArgsSchema = z
  .object({
    ...evalRouteShape,
  })
  .strict();

export const evalRunEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    at: z.number().int().nonnegative(),
    kind: z.enum([
      "state",
      "console",
      "progress",
      "checkpoint",
      "authority-requested",
      "authority-decided",
      "kernel",
      "cleanup",
      "diagnostic",
    ]),
    payload: z.unknown(),
  })
  .strict();
export type EvalRunEvent = z.infer<typeof evalRunEventSchema>;

export const evalEventsPageSchema = z
  .object({
    events: z.array(evalRunEventSchema).max(256),
    next: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  })
  .strict();

export interface EvalRunRoute {
  target?: EvalStartInput["target"];
  scopeKey?: string;
  runId: string;
}

export function settledResult(
  snapshot: z.infer<typeof evalRunStatusSchema> | undefined
): z.infer<typeof evalRunResultSchema> | undefined {
  if (snapshot?.status === "done" || snapshot?.status === "approval-route-lost") {
    if (!snapshot.result) throw new Error("eval: terminal run has no result");
    return snapshot.result;
  }
  if (snapshot?.status === "cancelled") {
    // A cancelled row normally carries no stored result (user cancellation);
    // lifecycle-driven termination stamps one so its infrastructure-typed
    // `runtime_generation_lost` code survives to the driver.
    return (
      snapshot.result ?? {
        success: false,
        console: "",
        error: {
          message: "eval: run cancelled",
          errorKind: "application",
        },
        failureKind: "cancelled",
        failureCode: evalLifecycleFailureCodes.cancelled,
      }
    );
  }
  return undefined;
}

export function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return AbortSignal.abort().reason;
}
