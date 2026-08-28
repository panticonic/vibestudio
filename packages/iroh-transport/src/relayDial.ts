import { assertIrohReach, type IrohReach } from "./reach.js";

export interface RelayDialAttempt {
  endpointId: string;
  relayUrl: string;
  attempt: number;
  signal: AbortSignal;
}

export interface RelayDialResult<T> {
  value: T;
  relayUrl: string;
  attempts: number;
}

export interface OrderedRelayDialOptions<T> {
  reach: IrohReach;
  dial(attempt: RelayDialAttempt): Promise<T>;
  deadlineMs: number;
  preferredRelay?: string;
  signal?: AbortSignal;
}

export class OrderedRelayDialError extends Error {
  readonly failures: readonly unknown[];

  constructor(message: string, failures: readonly unknown[], cause?: unknown) {
    super(message);
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", { value: cause, configurable: true });
    }
    this.name = "OrderedRelayDialError";
    this.failures = Object.freeze([...failures]);
  }
}

function attemptOrder(relays: readonly string[], preferredRelay: string | undefined): string[] {
  if (!preferredRelay || !relays.includes(preferredRelay)) return [...relays];
  return [preferredRelay, ...relays.filter((relay) => relay !== preferredRelay)];
}

function abortReason(signal: AbortSignal): unknown {
  return (
    (signal as AbortSignal & { reason?: unknown }).reason ?? new Error("Iroh relay dial aborted")
  );
}

export async function dialOrderedRelays<T>(
  options: OrderedRelayDialOptions<T>
): Promise<RelayDialResult<T>> {
  assertIrohReach(options.reach);
  if (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0) {
    throw new Error("Iroh relay dial deadlineMs must be a positive finite number");
  }

  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", onCallerAbort, { once: true });

  const timeout = setTimeout(() => controller.abort(), options.deadlineMs);
  (timeout as unknown as { unref?: () => void }).unref?.();

  const failures: unknown[] = [];
  const relays = attemptOrder(options.reach.relays, options.preferredRelay);
  try {
    for (let index = 0; index < relays.length; index += 1) {
      if (controller.signal.aborted) {
        const reason = abortReason(controller.signal);
        throw new OrderedRelayDialError("Iroh relay dial aborted", failures, reason);
      }
      const relayUrl = relays[index];
      if (!relayUrl) throw new Error("Iroh relay attempt order contained an empty entry");
      try {
        const value = await options.dial({
          endpointId: options.reach.endpointId,
          relayUrl,
          attempt: index + 1,
          signal: controller.signal,
        });
        return { value, relayUrl, attempts: index + 1 };
      } catch (error) {
        failures.push(error);
        if (controller.signal.aborted) {
          const reason = abortReason(controller.signal);
          throw new OrderedRelayDialError("Iroh relay dial aborted", failures, reason);
        }
      }
    }
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }

  throw new OrderedRelayDialError(
    `Unable to reach ${options.reach.endpointId} through ${relays.length} configured relays`,
    failures
  );
}
