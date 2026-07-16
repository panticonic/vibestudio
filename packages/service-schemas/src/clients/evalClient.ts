import type { EvalRunEvent, EvalRunResult, EvalRunSnapshot, EvalStartInput } from "../eval.js";

export interface EvalClientTransport {
  start(input: EvalStartInput): Promise<{ runId: string }>;
  get(input: {
    runId: string;
    target?: EvalStartInput["target"];
    scope?: { key: string };
  }): Promise<EvalRunSnapshot>;
  events(input: {
    runId: string;
    target?: EvalStartInput["target"];
    scope?: { key: string };
    after?: number;
  }): Promise<{ events: EvalRunEvent[]; next: number }>;
  cancel(input: {
    runId: string;
    target?: EvalStartInput["target"];
    scope?: { key: string };
  }): Promise<{ status: "requested" | "cancelled" | "terminal" }>;
}

export interface EvalExecuteOptions {
  signal?: AbortSignal;
  pollIntervalMs?: number;
  onEvent?: (event: EvalRunEvent) => void | Promise<void>;
}

const TERMINAL = new Set<EvalRunSnapshot["status"]>([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "interrupted",
]);

function abortError(): Error {
  const error = new Error("Eval execution was aborted");
  error.name = "AbortError";
  return error;
}

function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort?: () => void
): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    onAbort?.();
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => {
      onAbort?.();
      reject(abortError());
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener("abort", handleAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", handleAbort);
        reject(error);
      }
    );
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Transport-agnostic convenience composition. The server exposes only the
 * asynchronous handle lifecycle; every CLI/panel/agent gets identical waiting,
 * event, cancellation, and terminal semantics through this helper.
 */
export async function executeEval(
  client: EvalClientTransport,
  input: EvalStartInput,
  options: EvalExecuteOptions = {}
): Promise<EvalRunResult> {
  if (options.signal?.aborted) throw abortError();
  const start = client.start(input);
  let handle: { runId: string };
  try {
    handle = await abortable(start, options.signal);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      // The server may accept after the local caller has stopped waiting. Once
      // its durable handle arrives, cancel it without extending local latency.
      void start
        .then((accepted) =>
          client.cancel({
            runId: accepted.runId,
            ...(input.target ? { target: input.target } : {}),
            ...(input.scope ? { scope: { key: input.scope.key } } : {}),
          })
        )
        .catch(() => undefined);
    }
    throw error;
  }
  const route = {
    runId: handle.runId,
    ...(input.target ? { target: input.target } : {}),
    ...(input.scope ? { scope: { key: input.scope.key } } : {}),
  };
  let after = 0;
  let cancellation: Promise<unknown> | undefined;
  const requestCancellation = () => {
    cancellation ??= client.cancel(route).catch(() => undefined);
  };
  options.signal?.addEventListener("abort", requestCancellation, { once: true });
  try {
    for (;;) {
      if (options.signal?.aborted) {
        requestCancellation();
        throw abortError();
      }
      const page = await abortable(
        client.events({ ...route, after }),
        options.signal,
        requestCancellation
      );
      for (const event of page.events) {
        await abortable(
          Promise.resolve(options.onEvent?.(event)).then(() => undefined),
          options.signal,
          requestCancellation
        );
      }
      after = page.next;
      const snapshot = await abortable(client.get(route), options.signal, requestCancellation);
      if (TERMINAL.has(snapshot.status)) {
        if (snapshot.result) return snapshot.result;
        return {
          success: false,
          console: "",
          error: snapshot.terminalReason ?? `eval ended as ${snapshot.status}`,
          errorCode: snapshot.status === "interrupted" ? "EVAL_INTERRUPTED" : undefined,
          provenance: {
            startIntentDigest: snapshot.startIntentDigest,
            sourceDigest: snapshot.sourceDigest,
            executionProvenanceDigest: snapshot.executionProvenanceDigest,
            scopeInputRevision: snapshot.scopeInputRevision,
            runDigest: snapshot.runDigest,
            sourceBundleDigest: snapshot.sourceBundleDigest,
            manifestDigest: snapshot.manifestDigest,
            terminalReason: snapshot.terminalReason,
          },
        };
      }
      await delay(options.pollIntervalMs ?? 100, options.signal);
    }
  } catch (error) {
    requestCancellation();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", requestCancellation);
  }
}
