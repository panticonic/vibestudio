interface ResolvedWorkspaceStateService {
  kind: "durable-object" | "worker";
  targetId?: string;
}

export interface WorkspaceStateDirectClient {
  call<T>(method: string, args: unknown[]): Promise<T>;
}

const clients = new WeakMap<object, WorkspaceStateDirectClient>();

export interface WorkspaceStateRpc {
  call(target: string, method: string, args: unknown[]): Promise<unknown>;
}

export function createWorkspaceStateDirectClient(
  rpc: WorkspaceStateRpc
): WorkspaceStateDirectClient {
  const existing = clients.get(rpc);
  if (existing) return existing;
  let targetPromise: Promise<string> | null = null;
  const target = (): Promise<string> => {
    targetPromise ??= rpc
      .call("main", "workers.resolveService", ["vibestudio.workspace-state.v1", null])
      .then((service) => {
        const resolved = service as ResolvedWorkspaceStateService;
        if (resolved.kind !== "durable-object" || !resolved.targetId) {
          throw new Error("The workspace-state builtin must resolve to a durable object");
        }
        return resolved.targetId;
      });
    return targetPromise;
  };
  const client: WorkspaceStateDirectClient = {
    call: async <T>(method: string, args: unknown[]) =>
      (await rpc.call(await target(), method, args)) as T,
  };
  clients.set(rpc, client);
  return client;
}
