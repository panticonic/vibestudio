/**
 * SettingsClient -- Shared settings RPC wrapper.
 *
 * Wraps the settings.getData server RPC call. Provider/model mutation methods
 * (setApiKey, removeApiKey, setModelRole) were removed in the Phase 8
 * migration to the chat agent path.
 */
import type { RpcClient } from "@vibestudio/rpc";
import type { SettingsData } from "@vibestudio/shared/types";
import {
  createTypedServiceClient,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";
import { settingsMethods } from "../settings.js";
export class SettingsClient {
  private typed: TypedServiceClient<typeof settingsMethods>;
  constructor(rpc: Pick<RpcClient, "call">) {
    this.typed = createTypedServiceClient("settings", settingsMethods, (service, method, args) =>
      rpc.call("main", `${service}.${method}`, args)
    );
  }
  getData(): Promise<SettingsData> {
    return this.typed.getData();
  }
}
