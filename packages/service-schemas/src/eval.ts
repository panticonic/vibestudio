/**
 * Wire schema for the server "eval" service — owner-scoped sandbox eval backed by a
 * per-owner internal EvalDO. Replaces the former "scope" service: the EvalDO holds REPL
 * scope (and a user `db`) in its own SQLite, and runs code via the workerd UnsafeEval binding.
 *
 * The `objectKey` is derived server-side from `ctx.caller` (+ optional `subKey`), so a caller
 * can only ever address its own EvalDO — owner isolation is structural, no client-supplied key.
 */

import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

/**
 * Maximum serialized return preview carried in one terminal eval result.
 * Consumers that return a page through eval must stay below this wire budget
 * after worst-case JSON escaping.
 */
export const EVAL_RESULT_RETURN_PREVIEW_CHARS = 12_000;

export const evalRunArgsSchema = z
  .object({
    /**
     * Privileged owner override for host surfaces. Shell/server callers use this to run
     * eval as an attached session entity instead of as the shell device itself.
     */
    ownerId: z.string().optional(),
    /** Context owned by `ownerId`; must match the active entity registry. */
    contextId: z.string().optional(),
    /** Logical sub-context name (default "default") — lets one owner keep multiple eval scopes. */
    subKey: z.string().optional(),
    /** Inline code to execute (provide either `code` or `path`). */
    code: z.string().optional(),
    /** Context-relative TS/TSX file to execute instead of inline code. */
    path: z.string().optional(),
    /** Optional context-relative virtual filename/base for inline code. */
    sourcePath: z.string().optional(),
    /** Atomically clear this owner's scope and user db before this run is inserted/executed. */
    reset: z.boolean().optional(),
    syntax: z.enum(["javascript", "typescript", "jsx", "tsx"]).optional(),
    /** On-demand package builds (e.g. { "lodash": "npm:^4.17.21" }). */
    imports: z.record(z.string()).optional(),
    /** Idempotent run identity (the agent eval gate uses its current invocation id). */
    runId: z.string().optional(),
    /** Opt-in deadline in ms; the run is aborted after this long. Absent ⇒ unbounded. */
    timeoutMs: z.number().int().positive().optional(),
    /** Read-only containment: every service call this run makes is dispatched with
     *  `ctx.readOnly`, so the server refuses any method not declared `sensitivity:"read"`. */
    readOnly: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasCode = value.code !== undefined;
    const hasPath = value.path !== undefined;
    if (hasCode === hasPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provide exactly one of code or path",
        path: hasCode ? ["path"] : ["code"],
      });
    }
    if (value.sourcePath !== undefined && !hasCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sourcePath is only valid with inline code",
        path: ["sourcePath"],
      });
    }
    if ((value.ownerId === undefined) !== (value.contextId === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ownerId and contextId must be provided together",
        path: value.ownerId === undefined ? ["ownerId"] : ["contextId"],
      });
    }
  });
export type EvalRunArgs = z.infer<typeof evalRunArgsSchema>;

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
    /** Keys currently held in the persistent REPL scope (for the agent's awareness). */
    scopeKeys: z.array(z.string()).optional(),
  })
  .strict();

/** Args for polling an async run: routing (owner/subKey, like `run`) + the runId. */
export const evalGetRunArgsSchema = z
  .object({
    ownerId: z.string().optional(),
    contextId: z.string().optional(),
    subKey: z.string().optional(),
    runId: z.string(),
  })
  .strict();

/** A run's status + (when terminal) its result. status ∈ pending|running|done|cancelled|unknown. */
export const evalRunStatusSchema = z
  .object({
    status: z.string(),
    result: evalRunResultSchema.optional(),
    /** Latest durable heartbeat published by the running sandbox. */
    progress: z.unknown().optional(),
  })
  .strict();

export const evalResetArgsSchema = z
  .object({
    ownerId: z.string().optional(),
    contextId: z.string().optional(),
    subKey: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.ownerId === undefined) !== (value.contextId === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ownerId and contextId must be provided together",
        path: value.ownerId === undefined ? ["ownerId"] : ["contextId"],
      });
    }
  });

/** Args for cancelling ONE run: routing (owner/subKey, like `reset`) + the runId to cancel. */
export const evalCancelArgsSchema = z
  .object({
    ownerId: z.string().optional(),
    contextId: z.string().optional(),
    subKey: z.string().optional(),
    runId: z.string(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.ownerId === undefined) !== (value.contextId === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ownerId and contextId must be provided together",
        path: value.ownerId === undefined ? ["ownerId"] : ["contextId"],
      });
    }
  });

/**
 * Owner-scoped routing plus a bounded page into one durable string value in the
 * current eval scope. This is the lossless transport for values too large for
 * an eval run's deliberately bounded result envelope.
 */
export const evalReadScopeTextPageArgsSchema = z
  .object({
    ownerId: z.string().optional(),
    contextId: z.string().optional(),
    subKey: z.string().optional(),
    key: z.string().min(1).max(512),
    offset: z.number().int().nonnegative(),
    /** Bounded so the base64 RPC response remains comfortably below transport limits. */
    limit: z
      .number()
      .int()
      .positive()
      .max(128 * 1024),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.ownerId === undefined) !== (value.contextId === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ownerId and contextId must be provided together",
        path: value.ownerId === undefined ? ["ownerId"] : ["contextId"],
      });
    }
  });

export const evalDeleteScopeValueArgsSchema = z
  .object({
    ownerId: z.string().optional(),
    contextId: z.string().optional(),
    subKey: z.string().optional(),
    key: z.string().min(1).max(512),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.ownerId === undefined) !== (value.contextId === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ownerId and contextId must be provided together",
        path: value.ownerId === undefined ? ["ownerId"] : ["contextId"],
      });
    }
  });

export const evalMethods = defineServiceMethods({
  run: {
    args: z.tuple([evalRunArgsSchema]),
    returns: evalRunResultSchema,
    description:
      "Run TypeScript/JS in the caller's per-owner EvalDO sandbox (persistent REPL scope + synchronous in-DO SQLite `db`). Set reset:true to atomically clear scope/db before this run. Owner is the verified caller; fs is scoped to the owner's context.",
    access: { sensitivity: "write" },
  },
  reset: {
    args: z.union([z.tuple([]), z.tuple([evalResetArgsSchema])]),
    returns: z.object({ ok: z.boolean() }).strict(),
    description:
      "Reset the eval context: wipe the persistent scope + the user `db` tables (a fresh scope), preserving the kernel's own state. The owner's existing data is cleared.",
    access: { sensitivity: "destructive" },
  },
  startRun: {
    args: z.tuple([evalRunArgsSchema]),
    returns: z.object({ runId: z.string() }).strict(),
    description:
      "Start an asynchronous eval for an agent DO: returns a runId after the EvalDO durably records and schedules the idempotent run; reset:true atomically clears scope/db before first insertion. The owning EvalDO delivers the result directly to its agent, while getRun reads the canonical durable result for recovery. Panels/CLI should use run for a one-request result.",
    access: { sensitivity: "write" },
  },
  getRun: {
    args: z.tuple([evalGetRunArgsSchema]),
    returns: evalRunStatusSchema,
    description:
      "Poll an async run started with startRun: returns its status, latest durable progress heartbeat, and (when done) result.",
    access: { sensitivity: "read" },
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
      "Cancel an in-flight or pending run by runId. Cooperative cancellation preserves other runs and scope and returns forcedReset:false. If the run or its cleanup does not settle within the recovery grace period, the EvalDO cancels all non-terminal runs, resets its shared scope/user db, and returns forcedReset:true. A terminal run is a no-op with forcedReset:false.",
    access: { sensitivity: "write" },
  },
});
