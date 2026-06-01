/**
 * SettingsClient -- Shared settings RPC wrapper.
 *
 * Wraps the settings.getData server RPC call. Provider/model mutation methods
 * (setApiKey, removeApiKey, setModelRole) were removed in the Phase 8
 * migration to the chat agent path.
 */
import type { RpcClient } from "@natstack/rpc";
import type { SettingsData } from "../types.js";
export class SettingsClient {
    private rpc: Pick<RpcClient, "call">;
    constructor(rpc: Pick<RpcClient, "call">) {
        this.rpc = rpc;
    }
    getData(): Promise<SettingsData> {
        return this.rpc.call<SettingsData>("main", "settings.getData", []);
    }
}
