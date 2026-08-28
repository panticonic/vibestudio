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
 * The selected bindings do not expose per-connect cancellation. A timed-out
 * attempt therefore closes the entire current endpoint generation, awaits the
 * native attempt's settlement, and rebinds the same durable secret. All hub and
 * workspace sessions observe one atomic generation transition; no abandoned
 * attempt can overlap its successor.
 */
export class EndpointGenerationOwner<
  Connection extends IrohPhysicalConnection,
  Endpoint extends IrohPhysicalEndpoint<Connection>,
> {
  private endpoint: Endpoint | null = null;
  private generation = 0;
  private closed = false;
  private operationTail: Promise<void> = Promise.resolve();
  private bindingPromise: Promise<Endpoint> | null = null;
  private readonly generationListeners = new Set<(snapshot: EndpointGenerationSnapshot) => void>();

  constructor(private readonly binding: IrohEndpointBinding<Connection, Endpoint>) {}

  async ready(): Promise<EndpointGenerationSnapshot> {
    const endpoint = await this.ensureEndpoint();
    return { endpointId: endpoint.endpointId, generation: this.generation };
  }

  onGeneration(handler: (snapshot: EndpointGenerationSnapshot) => void): () => void {
    this.generationListeners.add(handler);
    return () => this.generationListeners.delete(handler);
  }

  dial(options: EndpointGenerationDialOptions): Promise<EndpointGenerationDialResult<Connection>> {
    const operation = this.operationTail.then(() => this.dialExclusive(options));
    this.operationTail = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const endpoint = this.endpoint;
    this.endpoint = null;
    await endpoint?.close();
    await this.operationTail;
  }

  private async dialExclusive(
    options: EndpointGenerationDialOptions
  ): Promise<EndpointGenerationDialResult<Connection>> {
    if (this.closed) throw new Error("Iroh endpoint-generation owner is closed");
    assertIrohReach(options.reach);
    requirePositiveDuration(options.overallDeadlineMs, "overallDeadlineMs");
    requirePositiveDuration(options.perAttemptDeadlineMs, "perAttemptDeadlineMs");

    const startedAt = Date.now();
    const failures: unknown[] = [];
    const relays = orderedRelays(options.reach, options.preferredRelay);
    for (let index = 0; index < relays.length; index += 1) {
      const elapsed = Date.now() - startedAt;
      const remaining = options.overallDeadlineMs - elapsed;
      if (remaining <= 0) break;
      const relayUrl = relays[index];
      if (!relayUrl) throw new Error("Iroh relay order contained an empty entry");
      const endpoint = await this.ensureEndpoint();
      const deadlineMs = Math.min(remaining, options.perAttemptDeadlineMs);
      try {
        const connection = await this.connectWithGenerationDeadline(
          endpoint,
          options.reach,
          relayUrl,
          deadlineMs
        );
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
      connection.close(0x100n, new TextEncoder().encode("stale endpoint generation"));
      throw new Error(`Iroh dial through ${relayUrl} completed on a stale endpoint generation`);
    });
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        replacement = this.replaceGeneration(endpoint, attempt);
        void replacement.then(
          () => reject(new Error(`Iroh dial through ${relayUrl} timed out after ${deadlineMs}ms`)),
          reject
        );
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

  private async replaceGeneration(endpoint: Endpoint, attempt: Promise<Connection>): Promise<void> {
    if (endpoint !== this.endpoint) {
      await attempt.catch(() => undefined);
      return;
    }
    this.endpoint = null;
    await endpoint.close();
    await attempt.then(
      (connection) =>
        connection.close(0x100n, new TextEncoder().encode("cancelled endpoint generation")),
      () => undefined
    );
    if (!this.closed) await this.ensureEndpoint();
  }

  private async ensureEndpoint(): Promise<Endpoint> {
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
