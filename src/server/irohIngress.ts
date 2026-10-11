import type {
  IrohEndpointBinding,
  IrohPhysicalConnection,
  IrohPhysicalEndpoint,
} from "@vibestudio/iroh-transport";
import { formatRpcFailure } from "@vibestudio/rpc";

const ADMISSION_REJECTED = 0x210n;
const SERVER_STOPPED = 0x211n;
const CONNECTION_LIMIT = 0x212n;
const DEFAULT_CATASTROPHIC_CONNECTION_CEILING = 65_536;
const REBIND_BACKOFF_MAX_MS = 5_000;

export interface IrohIngressOptions<
  Connection extends IrohPhysicalConnection,
  Endpoint extends IrohPhysicalEndpoint<Connection>,
> {
  binding: IrohEndpointBinding<Connection, Endpoint>;
  maxConnections?: number;
  /** Runs after the authenticated QUIC handshake and before any stream is accepted. */
  admitPeer(endpointId: string): boolean | Promise<boolean>;
  attach(connection: Connection): Promise<void>;
  log?(message: string, error?: unknown): void;
}

export interface IrohIngress<Endpoint = IrohPhysicalEndpoint<IrohPhysicalConnection>> {
  readonly endpointId: string;
  readonly endpoint: Endpoint;
  /** Resolves when the endpoint is bound and accepting; relay connectivity remains live state. */
  readonly ready: Promise<void>;
  /** Resolves with this bound generation only after its binding reports usable reachability. */
  waitUntilOnline(): Promise<Endpoint>;
  /** True only while the currently bound generation has reported online. */
  readonly isOnline: boolean;
  stop(): Promise<void>;
}

/**
 * Owns one server endpoint and its full-handshake accept loop. Admission is
 * deliberately before `attach`: rejected peers can never open the lifecycle
 * stream or consume application framing/authentication budgets.
 * Binding establishes ingress readiness. Relay discovery and reconnection stay
 * on the same endpoint and never prevent local startup or direct peer admission.
 */
export function startIrohIngress<
  Connection extends IrohPhysicalConnection,
  Endpoint extends IrohPhysicalEndpoint<Connection>,
>(options: IrohIngressOptions<Connection, Endpoint>): IrohIngress<Endpoint> {
  const maximum = options.maxConnections ?? DEFAULT_CATASTROPHIC_CONNECTION_CEILING;
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new Error("Iroh ingress maxConnections must be a positive safe integer");
  }
  const live = new Set<Connection>();
  const endpointClosures = new WeakMap<object, Promise<void>>();
  let endpoint: Endpoint | null = null;
  type EndpointGeneration = {
    endpoint: Endpoint;
    onlineTask: Promise<void> | null;
    reachReady: Promise<void>;
    resolveReachReady(): void;
    rejectReachReady(error: unknown): void;
    retirementComplete: Promise<void>;
    resolveRetirementComplete(): void;
    reachSettled: boolean;
    retiring: boolean;
    hasFailure: boolean;
    failure?: unknown;
    additionalFailures: unknown[];
    isOnline: boolean;
  };
  let generation: EndpointGeneration | null = null;
  let endpointId = "";
  let stopped = false;
  let stopFailure: Error | null = null;
  let wakeBackoff: (() => void) | null = null;
  let readySucceeded = false;
  const closeEndpoint = (owner: Endpoint | null): Promise<void> => {
    if (!owner) return Promise.resolve();
    const existing = endpointClosures.get(owner);
    if (existing) return existing;
    const closing = Promise.resolve().then(() => owner.close());
    endpointClosures.set(owner, closing);
    return closing;
  };
  const recordGenerationFailure = (owner: EndpointGeneration, error: unknown): void => {
    if (owner.retiring || stopped) return;
    if (!owner.hasFailure) {
      owner.hasFailure = true;
      owner.failure = error;
    } else if (owner.failure !== error) {
      owner.additionalFailures.push(error);
    }
  };

  async function acceptLoop(owner: Endpoint): Promise<void> {
    while (!stopped) {
      const connection = await owner.accept();
      if (stopped) break;
      if (!connection) throw new Error("Iroh endpoint accept loop ended unexpectedly");
      if (live.size >= maximum) {
        connection.close(CONNECTION_LIMIT, new TextEncoder().encode("connection limit"));
        continue;
      }
      let admitted = false;
      try {
        admitted = await options.admitPeer(connection.peerEndpointId);
      } catch (error) {
        options.log?.(`Iroh peer admission failed: ${String(error)}`);
      }
      if (stopped) {
        connection.close(SERVER_STOPPED, new TextEncoder().encode("server stopped"));
        break;
      }
      if (!admitted) {
        connection.close(ADMISSION_REJECTED, new TextEncoder().encode("peer not admitted"));
        continue;
      }
      live.add(connection);
      const selectedPath = connection.diagnostics?.().paths.find((path) => path.selected);
      options.log?.(
        `Iroh peer admitted endpoint=${connection.peerEndpointId.slice(0, 12)} path=${
          selectedPath?.kind ?? "unknown"
        }${selectedPath?.remoteAddress ? ` remote=${selectedPath.remoteAddress}` : ""}`
      );
      let lastPath = selectedPath
        ? `${selectedPath.kind}\x00${selectedPath.remoteAddress}`
        : "unknown";
      const unsubscribeDiagnostics = connection.onDiagnosticsChange?.((diagnostics) => {
        const selected = diagnostics.paths.find((path) => path.selected);
        const nextPath = selected ? `${selected.kind}\x00${selected.remoteAddress}` : "unknown";
        if (nextPath === lastPath) return;
        lastPath = nextPath;
        options.log?.(
          `Iroh peer path changed endpoint=${connection.peerEndpointId.slice(0, 12)} path=${
            selected?.kind ?? "unknown"
          }${selected?.remoteAddress ? ` remote=${selected.remoteAddress}` : ""}${
            selected?.rttMs === undefined ? "" : ` rttMs=${selected.rttMs}`
          }`
        );
      });
      void connection
        .closed()
        .then(
          (reason) =>
            options.log?.(
              `Iroh peer closed endpoint=${connection.peerEndpointId.slice(0, 12)} reason=${reason}`
            ),
          (error) =>
            options.log?.(
              `Iroh peer lost endpoint=${connection.peerEndpointId.slice(0, 12)} reason=${
                error instanceof Error ? error.message : String(error)
              }`
            )
        )
        .finally(() => {
          unsubscribeDiagnostics?.();
          live.delete(connection);
        });
      void options.attach(connection).catch((error) => {
        live.delete(connection);
        const reason = error instanceof Error ? error.message : String(error);
        connection.close(ADMISSION_REJECTED, new TextEncoder().encode(reason));
        options.log?.(`Iroh connection setup failed: ${reason}`);
      });
    }
  }

  const waitForRebind = async (attempt: number): Promise<void> => {
    const delayMs = Math.min(REBIND_BACKOFF_MAX_MS, 50 * 2 ** Math.min(attempt, 7));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      timer.unref?.();
      wakeBackoff = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wakeBackoff = null;
  };

  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  let readySettled = false;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const supervisor = (async () => {
    let rebindAttempt = 0;
    while (!stopped) {
      let owner: Endpoint | null = null;
      let onlineTask: Promise<void> | null = null;
      let acceptTask: Promise<void> | null = null;
      let generationError: unknown;
      let hasGenerationError = false;
      let closeError: unknown;
      let closeFailed = false;
      let terminalFailure: unknown;
      try {
        owner = await options.binding.bind();
        if (!stopped && endpointId && owner.endpointId !== endpointId) {
          throw new Error(
            `Iroh ingress endpoint identity changed across generations (${endpointId} -> ${owner.endpointId})`
          );
        }
        if (!stopped) {
          endpointId = owner.endpointId;
          endpoint = owner;
          onlineTask = options.binding.waitUntilOnline
            ? Promise.resolve().then(() => options.binding.waitUntilOnline!(owner!))
            : null;
          let resolveReachReady!: () => void;
          let rejectReachReady!: (error: unknown) => void;
          const reachReady = new Promise<void>((resolve, reject) => {
            resolveReachReady = resolve;
            rejectReachReady = reject;
          });
          let resolveRetirementComplete!: () => void;
          const retirementComplete = new Promise<void>((resolve) => {
            resolveRetirementComplete = resolve;
          });
          void reachReady.catch(() => undefined);
          const currentGeneration: EndpointGeneration = {
            endpoint: owner,
            onlineTask,
            reachReady,
            resolveReachReady,
            rejectReachReady,
            retirementComplete,
            resolveRetirementComplete,
            reachSettled: false,
            retiring: false,
            hasFailure: false,
            additionalFailures: [],
            isOnline: false,
          };
          generation = currentGeneration;
          if (onlineTask) {
            void onlineTask.then(
              () => {
                if (
                  generation === currentGeneration &&
                  !stopped &&
                  !currentGeneration.retiring &&
                  !currentGeneration.hasFailure &&
                  !currentGeneration.reachSettled
                ) {
                  currentGeneration.isOnline = true;
                  currentGeneration.reachSettled = true;
                  currentGeneration.resolveReachReady();
                }
              },
              (error: unknown) => recordGenerationFailure(currentGeneration, error)
            );
          }
          rebindAttempt = 0;
          if (!readySettled) {
            readySettled = true;
            readySucceeded = true;
            resolveReady();
          } else {
            options.log?.(`Iroh ingress recovered endpoint=${endpointId.slice(0, 12)}`);
          }
          const currentAcceptTask = acceptLoop(owner).then(() => {
            if (!stopped) throw new Error("Iroh endpoint accept loop ended unexpectedly");
          });
          acceptTask = currentAcceptTask;
          void acceptTask.catch((error: unknown) => {
            recordGenerationFailure(currentGeneration, error);
          });
          // Direct admission remains active while relay discovery is pending.
          // Either owned operation may end the generation; finally closes the
          // endpoint and joins its sibling before exposing the failure.
          await Promise.all(onlineTask ? [onlineTask, currentAcceptTask] : [currentAcceptTask]);
        }
      } catch (error) {
        if (!stopped) {
          generationError = error;
          hasGenerationError = true;
          if (!readySettled) {
            readySettled = true;
            rejectReady(error);
            stopped = true;
          } else {
            const reason = formatRpcFailure(error);
            if (reason.includes("endpoint identity changed across generations")) {
              stopped = true;
              options.log?.(`Iroh ingress stopped: ${reason}`, error);
            } else {
              options.log?.(`Iroh ingress generation failed; rebinding: ${reason}`, error);
            }
          }
        }
      } finally {
        const retiringGeneration: EndpointGeneration | null =
          generation?.endpoint === owner ? generation : null;
        if (retiringGeneration) retiringGeneration.retiring = true;
        if (endpoint === owner) endpoint = null;
        try {
          await closeEndpoint(owner);
        } catch (error) {
          closeFailed = true;
          closeError = error;
        }
        await Promise.allSettled(
          [onlineTask, acceptTask].filter((task): task is Promise<void> => task !== null)
        );
        const failures: unknown[] = [];
        if (retiringGeneration?.hasFailure) {
          failures.push(retiringGeneration.failure, ...retiringGeneration.additionalFailures);
        }
        if (hasGenerationError && !failures.includes(generationError))
          failures.push(generationError);
        if (closeFailed) failures.push(closeError);
        if (failures.length === 0 && stopped && stopFailure) failures.push(stopFailure);
        const hasTerminalFailure = failures.length > 0;
        terminalFailure =
          failures.length === 0
            ? undefined
            : failures.length === 1
              ? failures[0]
              : new AggregateError(failures, "Iroh ingress generation terminated with failures");
        if (retiringGeneration && hasTerminalFailure) {
          retiringGeneration.hasFailure = true;
          retiringGeneration.failure = terminalFailure;
          retiringGeneration.isOnline = false;
          if (!retiringGeneration.reachSettled) {
            retiringGeneration.reachSettled = true;
            retiringGeneration.rejectReachReady(terminalFailure);
          }
        } else if (retiringGeneration && !retiringGeneration.reachSettled) {
          retiringGeneration.reachSettled = true;
          retiringGeneration.rejectReachReady(new Error("Iroh endpoint generation retired"));
        }
        retiringGeneration?.resolveRetirementComplete();
        if (retiringGeneration && generation === retiringGeneration) generation = null;
        if (failures.length > 1 && !stopped) {
          options.log?.(
            `Iroh ingress generation terminal operations failed: ${formatRpcFailure(terminalFailure)}`,
            terminalFailure
          );
        }
      }
      if (closeFailed) {
        throw (
          terminalFailure ??
          new AggregateError([closeError], "Iroh ingress generation failed to close cleanly")
        );
      }
      if (!stopped) await waitForRebind(rebindAttempt++);
    }
  })();
  void supervisor.catch((error) => {
    options.log?.(
      `Iroh ingress supervisor stopped with an error: ${formatRpcFailure(error)}`,
      error
    );
  });

  return {
    get endpoint() {
      if (!endpoint) throw new Error("Iroh ingress endpoint is not bound");
      return endpoint;
    },
    get endpointId() {
      if (!endpointId) throw new Error("Iroh ingress endpoint is not bound yet");
      return endpointId;
    },
    ready,
    get isOnline() {
      return generation?.isOnline === true && !generation.hasFailure;
    },
    async waitUntilOnline() {
      if (!readySucceeded) await ready;
      const current = generation;
      if (!current) throw new Error("Iroh ingress has no bound endpoint generation");
      if (!current.onlineTask) {
        throw new Error("Iroh endpoint binding cannot report home-relay readiness");
      }
      await current.reachReady;
      if (
        current.hasFailure ||
        generation !== current ||
        endpoint !== current.endpoint ||
        stopped
      ) {
        await current.retirementComplete;
        if (current.hasFailure) throw current.failure;
        throw stopFailure ?? new Error("Iroh endpoint generation retired before reach was used");
      }
      return current.endpoint as Endpoint;
    },
    async stop() {
      stopped = true;
      stopFailure ??= new Error("Iroh ingress stopped before reach became ready");
      if (!readySettled) {
        readySettled = true;
        rejectReady(new Error("Iroh ingress stopped before becoming ready"));
      }
      wakeBackoff?.();
      for (const connection of live) {
        connection.close(SERVER_STOPPED, new TextEncoder().encode("server stopped"));
      }
      live.clear();
      const settled = await Promise.allSettled([closeEndpoint(endpoint), supervisor]);
      const errors = settled
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      const uniqueErrors = errors.filter((error, index) => errors.indexOf(error) === index);
      if (uniqueErrors.length === 1) throw uniqueErrors[0];
      if (uniqueErrors.length > 1) {
        throw new AggregateError(uniqueErrors, "Iroh ingress stop failed");
      }
    },
  };
}
