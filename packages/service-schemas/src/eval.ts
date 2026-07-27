/**
 * Wire schema for the server "eval" service — owner-scoped sandbox eval backed by a
 * per-owner internal EvalDO. Replaces the former "scope" service: the EvalDO holds REPL
 * scope (and a user `db`) in its own SQLite, and runs code via the workerd UnsafeEval binding.
 *
 * The `objectKey` is derived server-side from `ctx.caller` (+ optional scope key), so a caller
 * can only ever address its own EvalDO — owner isolation is structural, no client-supplied key.
 */

import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { CapabilityScopeSchema } from "./build.js";

/**
 * Maximum serialized return preview carried in one terminal eval result.
 * Consumers that return a page through eval must stay below this wire budget
 * after worst-case JSON escaping.
 */
export const EVAL_RESULT_RETURN_PREVIEW_CHARS = 12_000;

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

/**
 * The only public completion destination is the authenticated caller. The host
 * derives its runtime/entity identity from transport; input can never name an
 * owner, agent, channel, or arbitrary RPC target.
 */
export const evalResultReceiverRefSchema = z.object({ kind: z.literal("caller") }).strict();
export type EvalResultReceiverRef = z.infer<typeof evalResultReceiverRefSchema>;

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
  mode: z.enum(["adaptive", "strict"]).default("adaptive"),
  effects: z.enum(["read-only", "mutable"]).default("mutable"),
  approvals: z.enum(["prompt", "pregranted-only"]).default("prompt"),
  requests: z.array(CapabilityScopeSchema).max(256).optional(),
  preauthorize: z.array(evalPreauthorizationIntentSchema).max(64).optional(),
};

function refineEvalAuthorityIntent(
  value: {
    mode?: "adaptive" | "strict";
    approvals?: "prompt" | "pregranted-only";
    requests?: unknown;
    preauthorize?: unknown;
  },
  ctx: z.RefinementCtx
): void {
    if (value.requests !== undefined && value.mode !== "strict") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "requests are valid only when authority.mode is strict",
        path: ["requests"],
      });
    }
    if (value.preauthorize !== undefined && value.approvals !== "prompt") {
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
     * the EvalDO entity on first activation; a persistent scope cannot later be
     * reclassified as finite.
     */
    scope: evalScopeSchema.optional(),
    /** Atomically clear this owner's scope and user db before this run is inserted/executed. */
    reset: z.boolean().optional(),
    /** On-demand package builds (e.g. { "lodash": "npm:^4.17.21" }). */
    imports: z.record(z.string()).optional(),
    /** Caller-owned idempotent run identity (agents derive it from the tool invocation id). */
    runId: z.string().min(1),
    /** Optional terminal push to the authenticated caller. */
    resultReceiver: evalResultReceiverRefSchema.optional(),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Optional wall-clock deadline in milliseconds. Omit for ordinary work, long-running operations, and calls that may wait for human approval: eval has no implicit deadline. Set only when the task explicitly requires a bound or the code may never settle."
      ),
    /**
     * Per-run attenuation. This can only narrow the authority already admitted
     * by receiver declarations, sealed code, live grants, and relationships.
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
    /** Current 30-minute idle residency deadline, refreshed before each cell. */
    idleExpiresAt: z.number().int().nonnegative().optional(),
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
      })
      .strict()
      .optional(),
  })
  .strict();

export const evalRunResultSchema = z
  .object({
    success: z.boolean(),
    /** Formatted console output captured during the run. Oversized output may be windowed; read
     *  `scope.$lastLargeConsole` in follow-up evals for the bounded saved copy. */
    console: z.string(),
    /** Safe-serialized return value (present on success). Oversized values may be replaced with a
     *  structured truncation summary pointing at `scope.$lastLargeReturn`. */
    returnValue: z.unknown().optional(),
    /** Error message (present on failure). Oversized errors are windowed and retained at
     *  `scope.$lastLargeError` for bounded follow-up inspection. */
    error: z.string().optional(),
    /** Failure domain controls whether an agent may recover in-turn. */
    failureKind: z.enum(["user-code", "infrastructure", "cancelled"]).optional(),
    /** Stable machine-readable diagnostic, independent of displayed copy. */
    failureCode: z.string().optional(),
    /**
     * Structured failure details preserved from the sandbox exception.
     * Consumers use this for typed recovery (for example publication recovery);
     * it is diagnostic data, not display copy.
     */
    errorData: z.unknown().optional(),
    /** Keys currently held in the live notebook scope (for the agent's awareness). */
    scopeKeys: z.array(z.string()).optional(),
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
  })
  .strict();

export const evalStartResultSchema = z
  .object({
    runId: z.string().min(1),
    /** Digest of the complete normalized accepted run identity. */
    runDigest: z.string().regex(/^[a-f0-9]{64}$/),
    /** Digest of the normalized per-run attenuation manifest. */
    authorityManifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["accepted", "already-running", "terminal"]),
    snapshot: evalRunStatusSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.status === "terminal") !== (value.snapshot !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "snapshot is required exactly when status is terminal",
        path: ["snapshot"],
      });
    }
  });

export const evalResetArgsSchema = z
  .object({
    ...evalRouteShape,
  })
  .strict();

/** Args for cancelling one run: owner/scope routing plus the caller-owned runId. */
export const evalCancelArgsSchema = z
  .object({
    ...evalRouteShape,
    runId: z.string().min(1),
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

export const evalEventsArgsSchema = z
  .object({
    ...evalRouteShape,
    runId: z.string().min(1),
    after: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(256).optional(),
  })
  .strict();

export const evalEventsPageSchema = z
  .object({
    events: z.array(evalRunEventSchema).max(256),
    next: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  })
  .strict();

/**
 * Owner-scoped routing plus a bounded page into one durable string value in the
 * current eval scope. This is the lossless transport for values too large for
 * an eval run's deliberately bounded result envelope.
 */
export const evalReadScopeTextPageArgsSchema = z
  .object({
    ...evalRouteShape,
    key: z.string().min(1).max(512),
    offset: z.number().int().nonnegative(),
    /** Bounded so the base64 RPC response remains comfortably below transport limits. */
    limit: z
      .number()
      .int()
      .positive()
      .max(128 * 1024),
  })
  .strict();

export const evalDeleteScopeValueArgsSchema = z
  .object({
    ...evalRouteShape,
    key: z.string().min(1).max(512),
  })
  .strict();

export const evalMethods = defineServiceMethods({
  start: {
    args: z.tuple([evalStartInputSchema]),
    returns: evalStartResultSchema,
    description:
      "Durably accept one caller-owned eval run. A new run executes asynchronously in the owner's EvalDO; replaying the same runId and exact input observes the same run, while input drift is rejected. A trivially fast or replayed settled run may return its terminal snapshot immediately.",
    access: { sensitivity: "write" },
  },
  get: {
    args: z.tuple([evalGetArgsSchema]),
    returns: evalRunStatusSchema,
    description:
      "Read the canonical durable snapshot for a caller-owned eval run. This is a recovery/backstop read; agent-owned runs normally settle through the EvalDO's terminal completion push.",
    access: { sensitivity: "read" },
  },
  events: {
    args: z.tuple([evalEventsArgsSchema]),
    returns: evalEventsPageSchema,
    description:
      "Read one stable, bounded page of durable events for a caller-owned eval run. Subscribe to the canonical eval:run-event through events.watch for live delivery, then use this cursor page to catch up after reconnect or backpressure.",
    access: { sensitivity: "read" },
  },
  reset: {
    args: z.union([z.tuple([]), z.tuple([evalResetArgsSchema])]),
    returns: z.object({ ok: z.boolean() }).strict(),
    description:
      "Reset the eval context: wipe the live/durable scope and user `db` tables while preserving kernel infrastructure. The owner's existing eval data is cleared.",
    access: { sensitivity: "destructive" },
  },
  dispose: {
    args: z.union([z.tuple([]), z.tuple([evalResetArgsSchema])]),
    returns: z.object({ ok: z.boolean() }).strict(),
    description:
      "Permanently release one owner-scoped eval kernel and erase its scope, run records, loaded modules, runtime image, and entity registration. Use this for explicitly finite eval scopes; ordinary notebooks remain durable until disposed.",
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
    description:
      "Read a bounded page from a string in the caller's current durable eval scope. Use this to retrieve a large eval result losslessly after an eval caches it under a scope key; pages are UTF-16LE base64 so every JavaScript string code unit round-trips exactly.",
    access: { sensitivity: "read" },
  },
  deleteScopeValue: {
    args: z.tuple([evalDeleteScopeValueArgsSchema]),
    returns: z.object({ ok: z.boolean(), existed: z.boolean() }).strict(),
    description:
      "Delete one value from the caller's current durable eval scope and persist the deletion. Intended for cleaning up temporary keys used by lossless large-result paging.",
    access: { sensitivity: "write" },
  },
  cancel: {
    args: z.tuple([evalCancelArgsSchema]),
    returns: z.object({ ok: z.literal(true), forcedReset: z.boolean() }).strict(),
    description:
      "Cancel an in-flight or pending run by runId. The durable status is cancelling while registered cleanup runs and becomes cancelled only after cleanup settles, so evaluated-execution authority remains valid for teardown. Cooperative cancellation preserves other runs and scope and returns forcedReset:false. If the run or its cleanup does not settle within the recovery grace period, the EvalDO cancels all non-terminal runs, resets its shared scope/user db, and returns forcedReset:true. A terminal run is a no-op with forcedReset:false.",
    access: { sensitivity: "write" },
  },
});

export type EvalCall = <T>(method: string, args: unknown[]) => Promise<T>;

export interface EvalRunRoute {
  target?: EvalStartInput["target"];
  scopeKey?: string;
  runId: string;
}

/**
 * Shared non-blocking control surface for one caller-owned eval handle.
 *
 * Long-lived orchestrators may intentionally start now and observe/cancel
 * later; this keeps their route construction and public lifecycle calls on the
 * same composition as one-shot callers without forcing them into a polling
 * wait.
 */
export function createEvalRunObserver(call: EvalCall, route: EvalRunRoute) {
  const canonicalRoute = {
    ...(route.target ? { target: route.target } : {}),
    ...(route.scopeKey !== undefined ? { scopeKey: route.scopeKey } : {}),
    runId: route.runId,
  };
  return {
    route: canonicalRoute,
    get: () => call<z.infer<typeof evalRunStatusSchema>>("eval.get", [canonicalRoute]),
    cancel: () =>
      call<z.infer<typeof evalMethods.cancel.returns>>("eval.cancel", [canonicalRoute]),
  };
}

export function createEvalRunHandle(call: EvalCall, input: EvalStartInput) {
  const observer = createEvalRunObserver(call, {
    ...(input.target ? { target: input.target } : {}),
    ...(input.scope?.key !== undefined ? { scopeKey: input.scope.key } : {}),
    runId: input.runId,
  });
  return {
    ...observer,
    start: (receiver?: EvalResultReceiverRef) =>
      call<z.infer<typeof evalStartResultSchema>>("eval.start", [
        receiver ? { ...input, resultReceiver: receiver } : input,
      ]),
  };
}

export interface EvalExecutorOptions {
  signal?: AbortSignal;
  /** Ask the host to deliver the terminal snapshot to this authenticated caller. */
  receiver?: EvalResultReceiverRef;
  /**
   * Optional local receiver bridge. When supplied, terminal push and durable
   * polling race; the first terminal result wins and is settled exactly once.
   */
  waitForReceiver?: (
    runId: string,
    signal?: AbortSignal
  ) => Promise<z.infer<typeof evalRunResultSchema>>;
  /** Test/embedding seam. Production callers use the latency-sensitive bounded backoff. */
  pollDelay?: (attempt: number) => Promise<void>;
}

/**
 * Compose the durable eval lifecycle into the familiar one-call UX.
 *
 * `start` is the only execution method. `get` is solely the lost-push/recovery
 * backstop, and abort requests cancellation through that same run handle.
 * Callers with a native completion receiver (the agent vessel) keep using the
 * terminal push as their primary settlement path.
 */
export function createEvalExecutor(
  call: EvalCall,
  options: EvalExecutorOptions = {}
): (input: EvalStartInput) => Promise<z.infer<typeof evalRunResultSchema>> {
  return async (input) => {
    const handle = createEvalRunHandle(call, input);
    let cancelled = false;
    const cancel = async (): Promise<never> => {
      if (!cancelled) {
        cancelled = true;
        await handle.cancel();
      }
      throw abortReason(options.signal);
    };
    if (options.signal?.aborted) return cancel();

    const started = await handle.start(options.receiver);
    const immediate = settledResult(started.snapshot);
    if (immediate) return immediate;

    let receiverResult: z.infer<typeof evalRunResultSchema> | undefined;
    const poll = async (): Promise<z.infer<typeof evalRunResultSchema>> => {
      let attempt = 0;
      for (;;) {
        if (receiverResult) return receiverResult;
        if (options.signal?.aborted) return cancel();
        const snapshot = await handle.get();
        if (receiverResult) return receiverResult;
        const result = settledResult(snapshot);
        if (result) return result;
        if (snapshot.status === "unknown") {
          throw new Error(`eval: run ${input.runId} is unknown after start`);
        }
        await (options.pollDelay ?? defaultEvalPollDelay)(attempt++);
      }
    };
    if (!options.waitForReceiver) return poll();
    const receiver = options.waitForReceiver(input.runId, options.signal).then(
      (result) => {
        receiverResult = result;
        return result;
      },
      // Losing the local push bridge is precisely what the durable read path
      // exists to recover from. Keep polling instead of stranding the run or
      // leaving a rejected race with a live background poller.
      () => new Promise<never>(() => undefined)
    );
    return Promise.race([receiver, poll()]);
  };
}

export type DeferredEvalSettlement =
  | { deferred: true }
  | { deferred: false; result: z.infer<typeof evalRunResultSchema> };

/**
 * Compose the agent vessel's push-primary deferral over the same lifecycle.
 * `start` registers the caller receiver, then one immediate durable read closes
 * the lost-push/replay window. A non-terminal run stays parked for the receiver
 * push or the vessel's ordinary durable redrive; no polling loop is created.
 */
export function createDeferredEvalExecutor(
  call: EvalCall,
  options: {
    receiver?: EvalResultReceiverRef;
    onBackstopError?: (error: unknown) => void;
  } = {}
): (input: EvalStartInput) => Promise<DeferredEvalSettlement> {
  return async (input) => {
    const handle = createEvalRunHandle(call, input);
    const started = await handle.start(options.receiver ?? { kind: "caller" });
    const immediate = settledResult(started.snapshot);
    if (immediate) return { deferred: false, result: immediate };
    let snapshot: z.infer<typeof evalRunStatusSchema>;
    try {
      snapshot = await handle.get();
    } catch (error) {
      options.onBackstopError?.(error);
      return { deferred: true };
    }
    const result = settledResult(snapshot);
    return result ? { deferred: false, result } : { deferred: true };
  };
}

function settledResult(
  snapshot: z.infer<typeof evalRunStatusSchema> | undefined
): z.infer<typeof evalRunResultSchema> | undefined {
  if (snapshot?.status === "done" || snapshot?.status === "approval-route-lost") {
    if (!snapshot.result) throw new Error("eval: terminal run has no result");
    return snapshot.result;
  }
  if (snapshot?.status === "cancelled") {
    return {
      success: false,
      console: "",
      error: "eval: run cancelled",
      failureKind: "cancelled",
      failureCode: "eval_cancelled",
    };
  }
  return undefined;
}

function defaultEvalPollDelay(attempt: number): Promise<void> {
  const delayMs = Math.min(250, 10 * 2 ** Math.min(attempt, 5));
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("Eval execution aborted", "AbortError");
}
