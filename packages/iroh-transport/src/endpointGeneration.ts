import type {
  IrohEndpointBinding,
  IrohPhysicalConnection,
  IrohPhysicalEndpoint,
} from "./physical.js";
import { assertIrohReach, type IrohReach } from "./reach.js";

export interface EndpointGenerationSnapshot {
  endpointId: string;
  generation: number;
}

export interface EndpointGenerationInvalidation extends EndpointGenerationSnapshot {
  reason: "dial-timeout";
  /** The dial whose cancellation cost this generation. */
  timedOutDial: { peerEndpointId: string; relayUrl: string; deadlineMs: number };
}

export interface EndpointGenerationDialOptions {
  reach: IrohReach;
  overallDeadlineMs: number;
  perAttemptDeadlineMs: number;
  preferredRelay?: string;
}

export interface EndpointGenerationDialResult<Connection> {
  connection: Connection;
  relayUrl: string;
  attempts: number;
  generation: number;
}

export class EndpointGenerationDialError extends Error {
  constructor(
    message: string,
    readonly failures: readonly unknown[],
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "EndpointGenerationDialError";
  }
}

function requirePositiveDuration(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
}

function orderedRelays(reach: IrohReach, preferredRelay: string | undefined): string[] {
  if (!preferredRelay || !reach.relays.includes(preferredRelay)) return [...reach.relays];
  return [preferredRelay, ...reach.relays.filter((relay) => relay !== preferredRelay)];
}

/**
 * Owns the one native endpoint generation for a process/app.
 *
 * The selected bindings do not expose per-connect cancellation, so the only
 * way to cancel a timed-out attempt is to close the entire current endpoint
 * generation, await the native attempt's settlement, and rebind the same
 * durable secret. All hub and workspace sessions then observe one atomic
 * generation transition.
 *
 * That cancellation is only free while this endpoint has nothing to lose.
 * Once it carries live connections, spending it to cancel one dial closes
 * every one of them, and the replacement hands the next attempt an endpoint
 * that has to earn its paths again — which is how a desktop spent seventeen
 * minutes alternating between two groups of connections, each killed 11.9s
 * into its life by the other group's dial timing out. So a timeout with live
 * connections abandons its attempt instead: the attempt may then overlap its
 * successor, and a late arrival is closed on sight, which is a smaller price
 * than the connections it would otherwise take down with it.
 */
export class EndpointGenerationOwner<
  Connection extends IrohPhysicalConnection,
  Endpoint extends IrohPhysicalEndpoint<Connection>,
> {
  private endpoint: Endpoint | null = null;
  private generation = 0;
  private closed = false;
  private bindingPromise: Promise<Endpoint> | null = null;
  private replacementPromise: Promise<void> | null = null;
  private readonly activeDials = new Set<Promise<unknown>>();
  /** The endpoint this owner has already waited for, once per generation. */
  private onlineEndpoint: Endpoint | null = null;
  /** Connections handed out and not yet observed closed. */
  private readonly openConnections = new Set<Connection>();
  private lastSuccessfulRelay: string | null = null;
  private readonly successfulRelayByPeer = new Map<string, string>();
  private readonly generationListeners = new Set<(snapshot: EndpointGenerationSnapshot) => void>();
  private readonly invalidationListeners = new Set<
    (invalidation: EndpointGenerationInvalidation) => void
  >();

  constructor(private readonly binding: IrohEndpointBinding<Connection, Endpoint>) {}

  async ready(): Promise<EndpointGenerationSnapshot> {
    const endpoint = await this.ensureEndpoint();
    return { endpointId: endpoint.endpointId, generation: this.generation };
  }

  onGeneration(handler: (snapshot: EndpointGenerationSnapshot) => void): () => void {
    this.generationListeners.add(handler);
    return () => this.generationListeners.delete(handler);
  }

  /**
   * Fires before a live native endpoint generation is closed because the
   * binding cannot cancel one timed-out dial. Process-level connection owners
   * use this edge to invalidate every peer connection atomically instead of
   * waiting for each connection's close watcher to notice independently.
   */
  onInvalidation(handler: (invalidation: EndpointGenerationInvalidation) => void): () => void {
    this.invalidationListeners.add(handler);
    return () => this.invalidationListeners.delete(handler);
  }

  dial(options: EndpointGenerationDialOptions): Promise<EndpointGenerationDialResult<Connection>> {
    const operation = this.dialConcurrent(options);
    this.activeDials.add(operation);
    void operation.finally(() => this.activeDials.delete(operation)).catch(() => undefined);
    return operation;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const endpoint = this.endpoint;
    this.endpoint = null;
    this.onlineEndpoint = null;
    this.openConnections.clear();
    await endpoint?.close();
    await Promise.allSettled([...this.activeDials]);
    await this.replacementPromise?.catch(() => undefined);
  }

  /**
   * Waiting out the window where a bound endpoint cannot yet be dialed from.
   *
   * Binding is not reachability: the endpoint has to announce itself to its
   * relays first, and a dial issued before that spends its entire per-attempt
   * deadline on a path that cannot answer. The only cure this owner has for a
   * timed-out attempt is to replace the endpoint generation — which closes
   * every healthy connection on it and hands the next attempt another endpoint
   * that has not announced itself either. That is a stable oscillation, and it
   * was measured as one: two groups of connections alternating, each living
   * 11.9s against a 12s per-attempt deadline, for as long as the run lasted.
   *
   * A binding that cannot report readiness, or one that does not become ready
   * within the time one attempt was worth, falls through to dialing anyway:
   * the attempt deadline remains the backstop, and a dial that reports failure
   * without ever attempting anything is the worse answer.
   */
  private async awaitEndpointOnline(endpoint: Endpoint, remainingMs: number): Promise<void> {
    if (this.onlineEndpoint === endpoint) return;
    const waitUntilOnline = this.binding.waitUntilOnline?.bind(this.binding);
    if (!waitUntilOnline || remainingMs <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        waitUntilOnline(endpoint).catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, remainingMs);
          (timer as unknown as { unref?: () => void }).unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (endpoint === this.endpoint) this.onlineEndpoint = endpoint;
  }

  private async dialConcurrent(
    options: EndpointGenerationDialOptions
  ): Promise<EndpointGenerationDialResult<Connection>> {
    if (this.closed) throw new Error("Iroh endpoint-generation owner is closed");
    assertIrohReach(options.reach);
    requirePositiveDuration(options.overallDeadlineMs, "overallDeadlineMs");
    requirePositiveDuration(options.perAttemptDeadlineMs, "perAttemptDeadlineMs");

    const startedAt = Date.now();
    const failures: unknown[] = [];
    const explicitPreferredRelay = options.preferredRelay;
    const preferredRelay =
      explicitPreferredRelay && options.reach.relays.includes(explicitPreferredRelay)
        ? explicitPreferredRelay
        : this.successfulRelayByPeer.get(options.reach.endpointId) &&
            options.reach.relays.includes(this.successfulRelayByPeer.get(options.reach.endpointId)!)
          ? this.successfulRelayByPeer.get(options.reach.endpointId)!
          : this.lastSuccessfulRelay && options.reach.relays.includes(this.lastSuccessfulRelay)
            ? this.lastSuccessfulRelay
            : undefined;
    const relays = orderedRelays(options.reach, preferredRelay);
    for (let index = 0; index < relays.length; index += 1) {
      const elapsed = Date.now() - startedAt;
      const remaining = options.overallDeadlineMs - elapsed;
      if (remaining <= 0) break;
      const relayUrl = relays[index];
      if (!relayUrl) throw new Error("Iroh relay order contained an empty entry");
      const endpoint = await this.ensureEndpoint();
      const deadlineMs = Math.min(remaining, options.perAttemptDeadlineMs);
      // Waiting costs at most what one attempt would have, and the attempt
      // still gets its own deadline: a dial that reports failure without ever
      // having attempted anything is the worse answer. The overall deadline is
      // enforced where it belongs, at the top of the next relay's turn.
      await this.awaitEndpointOnline(endpoint, deadlineMs);
      try {
        const connection = await this.connectWithGenerationDeadline(
          endpoint,
          options.reach,
          relayUrl,
          deadlineMs
        );
        // The endpoint is process-wide: hub and workspace reaches share it. A
        // timed-out native dial can only be cancelled by replacing that whole
        // endpoint generation, which also closes every healthy connection on
        // it. Carry the last working relay across peers so a second reach does
        // not retry a relay this endpoint has just proved unreachable and tear
        // down the first reach while doing so. This is only a dial-order hint;
        // each reach remains authoritative and the hint is ignored when absent.
        this.lastSuccessfulRelay = relayUrl;
        this.successfulRelayByPeer.delete(options.reach.endpointId);
        this.successfulRelayByPeer.set(options.reach.endpointId, relayUrl);
        // This is diagnostic/hint state, never product state. The very large
        // ceiling only prevents a hostile process from retaining arbitrary
        // peer identifiers forever; normal installations never approach it.
        if (this.successfulRelayByPeer.size > 16_384) {
          const oldest = this.successfulRelayByPeer.keys().next().value as string | undefined;
          if (oldest) this.successfulRelayByPeer.delete(oldest);
        }
        this.trackConnection(connection);
        return {
          connection,
          relayUrl,
          attempts: index + 1,
          generation: this.generation,
        };
      } catch (error) {
        failures.push(error);
      }
    }

    throw new EndpointGenerationDialError(
      `Unable to reach ${options.reach.endpointId} through ${relays.length} configured relays`,
      Object.freeze([...failures]),
      failures.length ? { cause: failures.at(-1) } : undefined
    );
  }

  /**
   * Following a connection until it closes, so the cost of a rebind is known.
   *
   * Whether cancelling a dial by replacing the endpoint is free or ruinous
   * depends entirely on how many working connections that endpoint is holding,
   * and this owner is the only place that knows: it handed every one of them
   * out.
   */
  private trackConnection(connection: Connection): void {
    this.openConnections.add(connection);
    const forget = (): void => {
      this.openConnections.delete(connection);
    };
    void connection.closed().then(forget, forget);
  }

  private async connectWithGenerationDeadline(
    endpoint: Endpoint,
    reach: IrohReach,
    relayUrl: string,
    deadlineMs: number
  ): Promise<Connection> {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let replacement: Promise<void> | null = null;
    const attempt = endpoint.connect(reach, relayUrl);
    const guardedAttempt = attempt.then(async (connection) => {
      if (!timedOut) return connection;
      await replacement;
      connection.close(0x100n, new TextEncoder().encode("abandoned dial"));
      throw new Error(`Iroh dial through ${relayUrl} completed after it had been given up on`);
    });
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        const failure = new Error(`Iroh dial through ${relayUrl} timed out after ${deadlineMs}ms`);
        if (this.openConnections.size > 0) {
          // Abandoned rather than cancelled: cancelling costs every live
          // connection on this endpoint, and this attempt is not worth them.
          reject(failure);
          return;
        }
        replacement = this.replaceGeneration(endpoint, attempt, {
          peerEndpointId: reach.endpointId,
          relayUrl,
          deadlineMs,
        });
        void replacement.then(() => reject(failure), reject);
      }, deadlineMs);
      (timer as unknown as { unref?: () => void }).unref?.();
    });

    try {
      const connection = await Promise.race([guardedAttempt, timeout]);
      if (endpoint !== this.endpoint) {
        connection.close(0x100n, new TextEncoder().encode("stale endpoint generation"));
        throw new Error(`Iroh dial through ${relayUrl} completed on a stale endpoint generation`);
      }
      return connection;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async replaceGeneration(
    endpoint: Endpoint,
    attempt: Promise<Connection>,
    timedOutDial: EndpointGenerationInvalidation["timedOutDial"]
  ): Promise<void> {
    if (endpoint !== this.endpoint) {
      await attempt.catch(() => undefined);
      return;
    }
    if (this.replacementPromise) {
      await Promise.all([this.replacementPromise, attempt.catch(() => undefined)]);
      return;
    }
    const replacement = this.replaceGenerationExclusive(endpoint, attempt, timedOutDial);
    this.replacementPromise = replacement;
    try {
      await replacement;
    } finally {
      if (this.replacementPromise === replacement) this.replacementPromise = null;
    }
  }

  private async replaceGenerationExclusive(
    endpoint: Endpoint,
    attempt: Promise<Connection>,
    timedOutDial: EndpointGenerationInvalidation["timedOutDial"]
  ): Promise<void> {
    if (endpoint !== this.endpoint) {
      await attempt.catch(() => undefined);
      return;
    }
    const invalidation = {
      endpointId: endpoint.endpointId,
      generation: this.generation,
      reason: "dial-timeout" as const,
      timedOutDial,
    };
    for (const listener of [...this.invalidationListeners]) listener(invalidation);
    this.endpoint = null;
    this.onlineEndpoint = null;
    await endpoint.close();
    await attempt.then(
      (connection) =>
        connection.close(0x100n, new TextEncoder().encode("cancelled endpoint generation")),
      () => undefined
    );
  }

  private async ensureEndpoint(): Promise<Endpoint> {
    if (this.closed) throw new Error("Iroh endpoint-generation owner is closed");
    if (this.replacementPromise) await this.replacementPromise;
    if (this.closed) throw new Error("Iroh endpoint-generation owner is closed");
    if (this.endpoint) return this.endpoint;
    if (this.bindingPromise) return this.bindingPromise;
    this.bindingPromise = this.bindEndpoint();
    try {
      return await this.bindingPromise;
    } finally {
      this.bindingPromise = null;
    }
  }

  private async bindEndpoint(): Promise<Endpoint> {
    const endpoint = await this.binding.bind();
    if (this.closed) {
      await endpoint.close();
      throw new Error("Iroh endpoint-generation owner closed while binding");
    }
    const previousId = this.generation > 0 ? this.lastEndpointId : null;
    if (previousId !== null && endpoint.endpointId !== previousId) {
      await endpoint.close();
      throw new Error(
        `Iroh endpoint identity changed across generations (${previousId} -> ${endpoint.endpointId})`
      );
    }
    this.endpoint = endpoint;
    this.generation += 1;
    this.lastEndpointId = endpoint.endpointId;
    const snapshot = { endpointId: endpoint.endpointId, generation: this.generation };
    for (const listener of [...this.generationListeners]) listener(snapshot);
    return endpoint;
  }

  private lastEndpointId: string | null = null;
}
