import { RpcBoundaryError, stampEnvelopeCaller, type RpcEnvelope } from "@vibestudio/rpc";
import type { ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import type { HostUiSession, ServerClient } from "./serverClient.js";

/** Native ownership metadata, never supplied by the renderer. */
export interface NativeIpcCaller {
  callerId: string;
  callerKind: "shell" | "panel" | "app";
  runtimeId?: string;
  workspaceId?: string;
}
export interface WorkspaceIpcRuntime {
  workspaceId: string;
  serverClient: ServerClient;
  dispatcher: ServiceDispatcher;
}
export type ResolveWorkspaceUiRuntime = (
  caller: NativeIpcCaller,
  destinationWorkspaceId: string
) => Promise<WorkspaceIpcRuntime | null>;

type SessionEntry = {
  runtime: WorkspaceIpcRuntime;
  session: HostUiSession;
  unsubscribe: () => void;
};

/** Owns device/user sessions exclusively for native-admitted System chrome. */
export class WorkspaceUiSessions {
  private readonly sessions = new Map<string, Promise<SessionEntry>>();
  private closed = false;

  constructor(
    private readonly resolve: ResolveWorkspaceUiRuntime,
    private readonly deliver: (caller: NativeIpcCaller, envelope: RpcEnvelope) => void
  ) {}

  private key(caller: NativeIpcCaller, workspaceId: string): string {
    return JSON.stringify([caller.callerId, workspaceId]);
  }

  async admit(caller: NativeIpcCaller, workspaceId: string): Promise<WorkspaceIpcRuntime | null> {
    if (this.closed) throw new Error("Workspace UI sessions are closed");
    const key = this.key(caller, workspaceId);
    try {
      const runtime = await this.resolve(caller, workspaceId);
      if (!runtime) {
        await this.closeEntry(key);
        return null;
      }
      if (runtime.workspaceId !== workspaceId)
        throw new Error("Workspace UI admission returned another workspace");
      return runtime;
    } catch (error) {
      await this.closeEntry(key);
      throw error;
    }
  }

  async session(caller: NativeIpcCaller, runtime: WorkspaceIpcRuntime): Promise<HostUiSession> {
    const key = this.key(caller, runtime.workspaceId);
    const existing = this.sessions.get(key);
    if (existing) {
      const entry = await existing;
      if (entry.runtime.serverClient === runtime.serverClient && !entry.session.isClosed?.())
        return entry.session;
      await this.closeEntry(key);
    }
    if (this.closed) throw new Error("Workspace UI sessions are closed");
    const opening = runtime.serverClient.openHostUiSession().then(async (session) => {
      if (this.closed || this.sessions.get(key) !== opening) {
        await session.close();
        throw new Error("Workspace UI session was released while opening");
      }
      let deliveryTail: Promise<void> = Promise.resolve();
      const unsubscribe = session.onMessage((envelope) => {
        deliveryTail = deliveryTail
          .then(() => this.admit(caller, runtime.workspaceId))
          .then((current) => {
            if (
              !current ||
              current.serverClient !== runtime.serverClient ||
              this.sessions.get(key) !== opening
            )
              return;
            this.deliver(caller, {
              ...envelope,
              target: caller.runtimeId ?? caller.callerId,
              targetWorkspaceId: caller.workspaceId,
              delivery: {
                ...envelope.delivery,
                caller: { ...envelope.delivery.caller, workspaceId: runtime.workspaceId },
              },
            });
          })
          .catch(() => undefined);
      });
      return { runtime, session, unsubscribe };
    });
    this.sessions.set(key, opening);
    try {
      return (await opening).session;
    } catch (error) {
      if (this.sessions.get(key) === opening) this.sessions.delete(key);
      throw error;
    }
  }

  envelope(
    caller: NativeIpcCaller,
    runtime: WorkspaceIpcRuntime,
    envelope: RpcEnvelope
  ): RpcEnvelope {
    return stampEnvelopeCaller(
      { ...envelope, targetWorkspaceId: runtime.workspaceId },
      {
        callerId: caller.runtimeId ?? caller.callerId,
        callerKind: "shell",
        workspaceId: runtime.workspaceId,
      }
    );
  }

  async require(caller: NativeIpcCaller, workspaceId: string): Promise<WorkspaceIpcRuntime> {
    const runtime = await this.admit(caller, workspaceId);
    if (!runtime)
      throw new RpcBoundaryError("This renderer is not admitted as workspace UI", "access");
    return runtime;
  }

  private async closeEntry(key: string): Promise<void> {
    const pending = this.sessions.get(key);
    this.sessions.delete(key);
    if (!pending) return;
    try {
      const entry = await pending;
      entry.unsubscribe();
      await entry.session.close();
    } catch {
      /* A failed opening already owns its cleanup. */
    }
  }

  async closeCaller(callerId: string): Promise<void> {
    await Promise.all(
      [...this.sessions.keys()]
        .filter((key) => JSON.parse(key)[0] === callerId)
        .map((key) => this.closeEntry(key))
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.sessions.keys()].map((key) => this.closeEntry(key)));
  }
}
