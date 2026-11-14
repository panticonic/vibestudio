/**
 * Wire schema for the host's `dynamicCode` service (docs/dolt-redesign.md §7.3).
 *
 * Dynamic code is a class hosted by an entity: the entity owns the code's
 * storage and the host never proxies calls to it. What only the host can do is
 * admit a run (authority, execution session, task authority, causal parent),
 * release that admission when the run ends, and the two lifecycle controls that
 * need host authority (resetting or retiring a hosted scope). The caller then
 * talks to the hosting entity directly: `start` with the admission, `await` and
 * `events` to pull, `cancel`.
 */

import { z } from "zod";
import type { RpcCallOptions, RpcCaller, RpcMethod } from "@vibestudio/rpc";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import {
  abortReason,
  evalResetArgsSchema,
  evalRunResultSchema,
  evalRunStatusSchema,
  evalStartInputSchema,
  settledResult,
  type EvalRunEvent,
  type EvalStartInput,
} from "./eval.js";
import { createMainRpcCaller } from "./mainRpc.js";

/** The run's intent: what to run and the authority it may use. The host adds every trusted fact. */
export const dynamicCodeAdmitInputSchema = evalStartInputSchema.omit({ resultReceiver: true });
export type DynamicCodeAdmitInput = z.infer<typeof dynamicCodeAdmitInputSchema>;

export const dynamicCodeHostRefSchema = z
  .object({
    source: z.string().min(1),
    className: z.string().min(1),
    objectKey: z.string().min(1),
  })
  .strict();

export const dynamicCodeAdmissionSchema = z
  .object({
    runId: z.string().min(1),
    /** Digest of the complete normalized accepted run identity. */
    runDigest: z.string().regex(/^[a-f0-9]{64}$/),
    /** Digest of the normalized per-run attenuation manifest. */
    authorityManifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    /** The entity that hosts the code, as a call coordinate and as an entity id. */
    host: dynamicCodeHostRefSchema,
    hostId: z.string().min(1),
    /** The execution-session nonce the hosting entity presents with `start`. */
    nonce: z.string().min(1),
    /** The exact input of the hosting entity's `start(input, nonce)`. */
    start: z.record(z.unknown()),
  })
  .strict();
export type DynamicCodeAdmission = z.infer<typeof dynamicCodeAdmissionSchema>;

const releaseInputSchema = z
  .object({
    runId: z.string().min(1),
    /** The `hostId` the admission returned. */
    hostId: z.string().min(1),
  })
  .strict();

export const dynamicCodeMethods = defineServiceMethods({
  admit: {
    website: {
      kind: "eligible",
      rationale:
        "Caller-owned evaluated execution retains its authenticated launch scope; effects use ordinary resource approvals.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "eval.create",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    args: z.tuple([dynamicCodeAdmitInputSchema]),
    returns: dynamicCodeAdmissionSchema,
    description:
      "Admit one run of dynamic code for the caller. The host resolves the owner and the hosting session entity (creating it when it does not exist), normalizes the run's authority intent, registers its execution session and task authority, and returns the nonce and the exact start input. The caller then calls the hosting entity's `start(input, nonce)` and pulls with `await` and `events`; it calls `release` when the run is terminal. Replaying the same runId and input returns the same admission.",
    access: { sensitivity: "write" },
  },
  release: {
    website: {
      kind: "eligible",
      rationale: "Releases only an admission the authenticated caller made.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "eval.retire",
      rationale: "Owned-resource release of the caller's own admission.",
    },
    args: z.tuple([releaseInputSchema]),
    returns: z.object({ released: z.boolean() }).strict(),
    description:
      "Close the execution session of a run the caller admitted. A run that is still executing is not ended by this call: cancel it on the hosting entity first. Releasing an unknown or already released run answers `released: false`.",
    access: { sensitivity: "write" },
  },
  reset: {
    website: {
      kind: "eligible",
      rationale:
        "Caller-owned evaluated execution retains its authenticated launch scope; effects use ordinary resource approvals.",
    } as const,
    capability: "code-runner.reset",
    tier: {
      tier: "critical",
      session: "family",
      residency: "untrusted-execution",
      family: "eval.control",
      rationale:
        "C3: irreversible destruction outside VCS protection; §2 default {code, session} family",
    },
    presentation: {
      title: "Reset the code runner",
      action: "reset the code runner",
      description: "Clear the code runner and start fresh.",
      group: "runtime",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
    args: z.union([z.tuple([]), z.tuple([evalResetArgsSchema])]),
    returns: z.object({ ok: z.boolean() }).strict(),
    description:
      "Reset the caller's hosted code scope: wipe the live and durable scope and user `db` tables while preserving kernel infrastructure. The owner's existing data in it is cleared.",
    access: { sensitivity: "destructive" },
  },
  dispose: {
    website: {
      kind: "eligible",
      rationale:
        "Caller-owned evaluated execution retains its authenticated launch scope; effects use ordinary resource approvals.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "eval.control",
      rationale:
        "Owned-resource release: the host admits disposal only when this caller declared the scope finite at its immutable first activation",
    },
    args: z.union([z.tuple([]), z.tuple([evalResetArgsSchema])]),
    returns: z.object({ ok: z.boolean() }).strict(),
    description:
      "Permanently retire one explicitly finite hosted scope through its host lifecycle owner. Close admission and drain owned work before releasing the runtime and content. Retained receipts remain closed; use a new scope key for new work. A persistent scope cannot be disposed through this method.",
    access: { sensitivity: "destructive" },
  },
});

// ---------------------------------------------------------------------------
// The caller's side: admit, start on the hosting entity, pull, release
// ---------------------------------------------------------------------------

function hostedCall<Args extends unknown[], Result>(name: string): RpcMethod<Args, Result> {
  return {
    name,
    invoke: (args, dispatch) => dispatch(args) as Promise<Result>,
    parseArgs: async (args) => args,
  };
}

type RunStatus = z.infer<typeof evalRunStatusSchema>;
type RunResult = z.infer<typeof evalRunResultSchema>;
interface EventsPage {
  events: EvalRunEvent[];
  next: number;
  hasMore: boolean;
}

/**
 * The calls a caller makes on the entity that hosts its code (§7.5.1). They are the
 * hosting entity's own methods, not host services: the entity checks its caller.
 */
export const hostedCodeMethods = {
  start: hostedCall<[Record<string, unknown>, string], { runId: string; status: string }>("start"),
  await: hostedCall<[string, { waitMs?: number }], RunStatus>("await"),
  events: hostedCall<[string, { after?: number; limit?: number }], EventsPage>("events"),
  cancel: hostedCall<[string], { ok: true; forcedReset: boolean }>("cancel"),
  get: hostedCall<[string], RunStatus>("get"),
  receipt: hostedCall<[string], unknown>("receipt"),
  readScopeTextPage: hostedCall<
    [string, number, number],
    { length: number; encoding: "utf16le-base64"; chunk: string }
  >("readScopeTextPage"),
  deleteScopeValue: hostedCall<[string], { ok: boolean; existed: boolean }>("deleteScopeValue"),
  end: hostedCall<[], { ok: true }>("end"),
} as const;

export interface DynamicCodeExecutorOptions {
  signal?: AbortSignal;
  /** Receives each page of the run's events, in order, as they are pulled (console, authority, state). */
  onEvents?: (events: EvalRunEvent[]) => void;
  /**
   * How long one pull blocks before the events are read again. A run that ends ends the
   * wait at once; this bounds the latency of live output. Default 400 ms.
   */
  waitMs?: number;
}

/**
 * The familiar one-call UX over the pull model: admit the run, start it on the hosting
 * entity, tail its events and wait for its terminal row, then release the admission.
 * Nothing is pushed to the caller: a caller that restarts re-reads the committed row.
 */
export function createDynamicCodeExecutor(
  rpc: Pick<RpcCaller, "call">,
  options: DynamicCodeExecutorOptions = {}
): (input: EvalStartInput) => Promise<RunResult> {
  const main = createMainRpcCaller(rpc);
  return async (input) => {
    if (options.signal?.aborted) throw abortReason(options.signal);
    const { resultReceiver: _receiver, ...intent } = input;
    const admission = await main("dynamicCode.admit", [intent]);
    const { runId, hostId } = admission;
    const on = <A extends unknown[], R>(
      method: RpcMethod<A, R>,
      args: A,
      callOptions?: RpcCallOptions
    ): Promise<R> => rpc.call(hostId, method, args, callOptions);
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await main("dynamicCode.release", [{ runId, hostId }]).catch(() => undefined);
    };
    let cancelled = false;
    const cancel = async (): Promise<never> => {
      if (!cancelled) {
        cancelled = true;
        await on(hostedCodeMethods.cancel, [runId]).catch(() => undefined);
      }
      throw abortReason(options.signal);
    };
    try {
      await on(hostedCodeMethods.start, [admission.start, admission.nonce]);
      let after = 0;
      for (;;) {
        if (options.signal?.aborted) return await cancel();
        let snapshot: RunStatus;
        try {
          snapshot = await on(
            hostedCodeMethods.await,
            [runId, { waitMs: options.waitMs ?? 400 }],
            options.signal ? { signal: options.signal } : undefined
          );
        } catch (error) {
          if (options.signal?.aborted) return await cancel();
          throw error;
        }
        for (;;) {
          const page = await on(hostedCodeMethods.events, [runId, { after, limit: 256 }]);
          after = page.next;
          if (page.events.length > 0) options.onEvents?.(page.events);
          if (!page.hasMore) break;
        }
        const result = settledResult(snapshot);
        if (result) return result;
        if (snapshot.status === "unknown") {
          throw new Error(`eval: run ${runId} is unknown after start`);
        }
      }
    } finally {
      await release();
    }
  };
}
