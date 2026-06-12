import { createTypedServiceClient } from "@natstack/shared/typedServiceClient";
import { scopeMethods } from "@natstack/shared/serviceSchemas/scope";
import type { ScopeEntry, ScopeListEntry, ScopePersistence } from "./scopePersistence.js";
interface ScopeRpc {
    call(targetId: string, method: string, ...args: unknown[]): Promise<unknown>;
}
export class RpcScopePersistence implements ScopePersistence {
    private readonly client: ReturnType<typeof createScopeClient>;
    constructor(rpc: ScopeRpc) {
        this.client = createScopeClient(rpc);
    }
    upsert(entry: ScopeEntry): Promise<void> {
        return this.client.upsert(entry);
    }
    loadCurrent(channelId: string, panelId: string): Promise<ScopeEntry | null> {
        return this.client.loadCurrent(channelId, panelId);
    }
    get(id: string): Promise<ScopeEntry | null> {
        return this.client.get(id);
    }
    list(channelId: string): Promise<ScopeListEntry[]> {
        return this.client.list(channelId);
    }
}
function createScopeClient(rpc: ScopeRpc) {
    return createTypedServiceClient("scope", scopeMethods, (svc, method, args) =>
        rpc.call("main", `${svc}.${method}`, args)
    );
}
