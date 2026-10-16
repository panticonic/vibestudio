import type { IrohConnection } from "@vibestudio/mobile-iroh";
import type { IrohClientSession } from "@vibestudio/rpc/transports/irohClient";
import type {
  OpenedSession,
  SessionCallerKind,
  SessionHandlers,
  SessionOpeners,
} from "./sessionRelay";

/** The hub-control connection and the means to open a routed workspace's connection. */
export interface WorkspaceAccount {
  readonly control: IrohConnection;
  openWorkspace(
    workspaceId: string,
    onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>
  ): Promise<IrohConnection>;
}

interface Pipe {
  connection: Promise<IrohConnection>;
  references: number;
  /** The host's own connection (launch workspace): never closed by a client's release. */
  hostOwned: boolean;
}

/**
 * The device's workspace connections, one physical connection per workspace,
 * shared by every client that is routed there and by the host itself. A
 * client's sessions are logical sessions on these connections, never
 * connections of their own: the server admits one physical connection per
 * (device endpoint, server endpoint) and a second would supersede the first.
 */
export class WorkspacePipes {
  private readonly pipes = new Map<string, Pipe>();
  private closed = false;

  constructor(private readonly account: WorkspaceAccount) {}

  /** Register a connection the host already opened (the launch workspace). It stays open for the host's lifetime. */
  adopt(workspaceId: string, connection: IrohConnection): void {
    this.pipes.set(workspaceId, {
      connection: Promise.resolve(connection),
      references: 1,
      hostOwned: true,
    });
  }

  async acquire(workspaceId: string): Promise<IrohConnection> {
    if (this.closed) throw new Error("The device's workspace connections are closed");
    let pipe = this.pipes.get(workspaceId);
    if (!pipe) {
      pipe = {
        connection: this.account.openWorkspace(workspaceId),
        references: 0,
        hostOwned: false,
      };
      this.pipes.set(workspaceId, pipe);
    }
    pipe.references += 1;
    try {
      return await pipe.connection;
    } catch (error) {
      pipe.references -= 1;
      if (pipe.references === 0 && this.pipes.get(workspaceId) === pipe) this.pipes.delete(workspaceId);
      throw error;
    }
  }

  async release(workspaceId: string): Promise<void> {
    const pipe = this.pipes.get(workspaceId);
    if (!pipe) return;
    pipe.references -= 1;
    if (pipe.references > 0 || pipe.hostOwned) return;
    this.pipes.delete(workspaceId);
    await (await pipe.connection).close();
  }

  /** Close every connection the clients caused to be opened. */
  async close(): Promise<void> {
    this.closed = true;
    const owned = [...this.pipes.entries()].filter(([, pipe]) => !pipe.hostOwned);
    this.pipes.clear();
    const results = await Promise.allSettled(
      owned.map(async ([, pipe]) => (await pipe.connection).close())
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Workspace connections failed to close");
  }
}

function openedFrom(
  connection: IrohConnection,
  session: IrohClientSession,
  callerKind: SessionCallerKind,
  release: () => Promise<void>
): OpenedSession {
  return {
    session,
    callerKind,
    deviceId: connection.deviceId ?? null,
    serverId: connection.serverId ?? null,
    waitUntilConnected: (timeoutMs) => connection.waitUntilConnected(timeoutMs),
    onReconnectProgress: (handler) => connection.transport.onReconnectProgress(handler),
    openAuxiliary(label, getToken, handlers, connectionId) {
      const auxiliary = connection.openAuxiliarySession(label, {
        getToken,
        ...handlers,
        ...(connectionId ? { connectionId } : {}),
      });
      return openedFrom(connection, auxiliary, "panel", () => auxiliary.close());
    },
    release,
  };
}

/** `SessionOpeners` over the host's own connections. */
export function createSessionOpeners(deps: {
  /** The launch workspace's connection; client principal sessions open on its pipe. */
  launch: IrohConnection;
  account: WorkspaceAccount;
  pipes: WorkspacePipes;
}): SessionOpeners {
  const { launch, account, pipes } = deps;
  return {
    principal(label, getToken, handlers: SessionHandlers) {
      const session = launch.openAuxiliarySession(label, { getToken, ...handlers });
      return openedFrom(launch, session, "client", () => session.close());
    },
    accountControl(label, handlers) {
      const session = account.control.openAuxiliarySession(label, handlers);
      return openedFrom(account.control, session, "shell", () => session.close());
    },
    async workspace(workspaceId, label, handlers) {
      const connection = await pipes.acquire(workspaceId);
      let session: IrohClientSession;
      try {
        session = connection.openAuxiliarySession(label, handlers);
      } catch (error) {
        await pipes.release(workspaceId);
        throw error;
      }
      return openedFrom(connection, session, "shell", async () => {
        try {
          await session.close();
        } finally {
          await pipes.release(workspaceId);
        }
      });
    },
  };
}
