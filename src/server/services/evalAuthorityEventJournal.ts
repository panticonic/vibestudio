import type { DORef, HeldDoDispatcher } from "@vibestudio/shared/doDispatcher";
import { EVAL_HOST_CLASS, EVAL_HOST_SOURCE } from "@vibestudio/shared/evalRuntimeIdentity";

export type EvalAuthorityEventKind = "authority-requested" | "authority-decided";

export interface EvalAuthorityEvent {
  objectKey: string;
  runId: string;
  kind: EvalAuthorityEventKind;
  payload: unknown;
}

/**
 * Ordered delivery of host-observed authority lifecycle events to the eval kernel,
 * through the session entity that hosts it.
 *
 * An eval kernel calls the host while executing a sandbox operation. Authority is
 * evaluated on that outbound call, so the observer must never await a call
 * back into the same eval kernel: that is a causal cycle, not backpressure. This
 * journal accepts the observation synchronously and owns one bounded-live
 * promise tail per eval kernel. Events for an object remain ordered, failures do not
 * poison later delivery, and graceful shutdown drains every accepted event.
 * The authority acquisition records remain the semantic source of truth; this
 * path projects their lifecycle into the eval kernel's durable run-event journal.
 */
export class EvalAuthorityEventJournal {
  private readonly tails = new Map<string, Promise<void>>();
  private closed = false;

  constructor(
    private readonly dispatcher: Pick<HeldDoDispatcher, "dispatch">,
    private readonly onError: (event: EvalAuthorityEvent, error: unknown) => void = defaultReporter
  ) {}

  append(event: EvalAuthorityEvent): void {
    if (this.closed) {
      throw new Error("eval authority event journal is closed");
    }
    const previous = this.tails.get(event.objectKey) ?? Promise.resolve();
    const current = previous
      .then(async () => {
        await this.dispatcher.dispatch(
          refFor(event.objectKey),
          "recordAuthorityEvent",
          event.runId,
          event.kind,
          event.payload
        );
      })
      .catch((error) => {
        try {
          this.onError(event, error);
        } catch (reportingError) {
          defaultReporter(event, reportingError);
        }
      });
    this.tails.set(event.objectKey, current);
    void current.finally(() => {
      if (this.tails.get(event.objectKey) === current) this.tails.delete(event.objectKey);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    while (this.tails.size > 0) {
      await Promise.all([...this.tails.values()]);
    }
  }
}

function refFor(objectKey: string): DORef {
  return { source: EVAL_HOST_SOURCE, className: EVAL_HOST_CLASS, objectKey };
}

function defaultReporter(event: EvalAuthorityEvent, error: unknown): void {
  console.warn(
    `[EvalAuthorityEventJournal] failed to append ${event.kind} for ${event.objectKey}/${event.runId}:`,
    error instanceof Error ? error.message : error
  );
}
