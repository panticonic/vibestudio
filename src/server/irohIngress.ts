import type {
  IrohEndpointBinding,
  IrohPhysicalConnection,
  IrohPhysicalEndpoint,
} from "@vibestudio/iroh-transport";

const ADMISSION_REJECTED = 0x210n;
const SERVER_STOPPED = 0x211n;
const CONNECTION_LIMIT = 0x212n;
const DEFAULT_ONLINE_TIMEOUT_MS = 15_000;
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
  waitUntilOnline?(endpoint: Endpoint): Promise<void>;
  onlineTimeoutMs?: number;
  log?(message: string): void;
}

export interface IrohIngress {
  readonly endpointId: string;
  readonly ready: Promise<void>;
  stop(): Promise<void>;
}

/**
 * Owns one server endpoint and its full-handshake accept loop. Admission is
 * deliberately before `attach`: rejected peers can never open the lifecycle
 * stream or consume application framing/authentication budgets.
 */
export function startIrohIngress<
  Connection extends IrohPhysicalConnection,
  Endpoint extends IrohPhysicalEndpoint<Connection>,
>(options: IrohIngressOptions<Connection, Endpoint>): IrohIngress {
  const maximum = options.maxConnections ?? DEFAULT_CATASTROPHIC_CONNECTION_CEILING;
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new Error("Iroh ingress maxConnections must be a positive safe integer");
  }
  const onlineTimeoutMs = options.onlineTimeoutMs ?? DEFAULT_ONLINE_TIMEOUT_MS;
  if (!Number.isSafeInteger(onlineTimeoutMs) || onlineTimeoutMs < 1) {
    throw new Error("Iroh ingress onlineTimeoutMs must be a positive safe integer");
  }
  const live = new Set<Connection>();
  const closedEndpoints = new WeakSet<object>();
  let endpoint: Endpoint | null = null;
  let endpointId = "";
  let stopped = false;
  let wakeBackoff: (() => void) | null = null;
  const closeEndpoint = async (owner: Endpoint | null): Promise<void> => {
    if (!owner || closedEndpoints.has(owner)) return;
    closedEndpoints.add(owner);
    await owner.close();
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
        .then((reason) =>
          options.log?.(
            `Iroh peer closed endpoint=${connection.peerEndpointId.slice(0, 12)} reason=${reason}`
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

  async function awaitOnline(owner: Endpoint): Promise<void> {
    if (options.waitUntilOnline) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error(`Iroh endpoint did not become online within ${onlineTimeoutMs}ms`)),
            onlineTimeoutMs
          );
          timer.unref?.();
        });
        await Promise.race([options.waitUntilOnline(owner), deadline]);
      } finally {
        if (timer) clearTimeout(timer);
      }
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
      try {
        owner = await options.binding.bind();
        if (stopped) {
          await closeEndpoint(owner);
          break;
        }
        if (endpointId && owner.endpointId !== endpointId) {
          throw new Error(
            `Iroh ingress endpoint identity changed across generations (${endpointId} -> ${owner.endpointId})`
          );
        }
        endpointId = owner.endpointId;
        endpoint = owner;
        await awaitOnline(owner);
        rebindAttempt = 0;
        if (!readySettled) {
          readySettled = true;
          resolveReady();
        } else {
          options.log?.(`Iroh ingress recovered endpoint=${endpointId.slice(0, 12)}`);
        }
        await acceptLoop(owner);
      } catch (error) {
        if (stopped) break;
        if (!readySettled) {
          readySettled = true;
          rejectReady(error);
          stopped = true;
          break;
        }
        const reason = error instanceof Error ? error.message : String(error);
        if (reason.includes("endpoint identity changed across generations")) {
          stopped = true;
          options.log?.(`Iroh ingress stopped: ${reason}`);
          break;
        }
        options.log?.(`Iroh ingress generation failed; rebinding: ${reason}`);
      } finally {
        if (endpoint === owner) endpoint = null;
        await closeEndpoint(owner).catch(() => undefined);
      }
      if (!stopped) await waitForRebind(rebindAttempt++);
    }
  })();

  return {
    get endpointId() {
      if (!endpointId) throw new Error("Iroh ingress endpoint is not bound yet");
      return endpointId;
    },
    ready,
    async stop() {
      if (stopped) return;
      stopped = true;
      wakeBackoff?.();
      for (const connection of live) {
        connection.close(SERVER_STOPPED, new TextEncoder().encode("server stopped"));
      }
      live.clear();
      await closeEndpoint(endpoint);
      await supervisor.catch(() => undefined);
    },
  };
}
