import type {
  IrohEndpointBinding,
  IrohPhysicalConnection,
  IrohPhysicalEndpoint,
} from "@vibestudio/iroh-transport";

const ADMISSION_REJECTED = 0x210n;
const SERVER_STOPPED = 0x211n;
const CONNECTION_LIMIT = 0x212n;
const DEFAULT_ONLINE_TIMEOUT_MS = 15_000;

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
  const maximum = options.maxConnections ?? 64;
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new Error("Iroh ingress maxConnections must be a positive safe integer");
  }
  const onlineTimeoutMs = options.onlineTimeoutMs ?? DEFAULT_ONLINE_TIMEOUT_MS;
  if (!Number.isSafeInteger(onlineTimeoutMs) || onlineTimeoutMs < 1) {
    throw new Error("Iroh ingress onlineTimeoutMs must be a positive safe integer");
  }
  const live = new Set<Connection>();
  let endpoint: Endpoint | null = null;
  let endpointId = "";
  let stopped = false;

  async function acceptLoop(owner: Endpoint): Promise<void> {
    while (!stopped) {
      const connection = await owner.accept();
      if (!connection || stopped) break;
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

  const ready = (async () => {
    endpoint = await options.binding.bind();
    endpointId = endpoint.endpointId;
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
        await Promise.race([options.waitUntilOnline(endpoint), deadline]);
      } catch (error) {
        stopped = true;
        await endpoint.close();
        endpoint = null;
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    void acceptLoop(endpoint).catch((error) => {
      if (!stopped) options.log?.(`Iroh ingress accept loop failed: ${String(error)}`);
    });
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
      await ready.catch(() => undefined);
      for (const connection of live) {
        connection.close(SERVER_STOPPED, new TextEncoder().encode("server stopped"));
      }
      live.clear();
      await endpoint?.close();
    },
  };
}
