/**
 * EventsClient -- Shared event subscription RPC wrappers.
 *
 * Wraps events-related server RPC calls for subscribing to and
 * unsubscribing from shell events (panel-tree-updated, theme changes, etc.).
 */
import type { RpcClient } from "@vibestudio/rpc";
import type { EventName } from "@vibestudio/shared/events";
import { eventsMethods } from "../events.js";
import {
  createTypedServiceClient,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";
import type { RecoveryCoordinator } from "@vibestudio/shell-core/recoveryCoordinator";
export class EventsClient {
  private typed: TypedServiceClient<typeof eventsMethods>;
  private subscriptions = new Set<EventName>();
  constructor(
    rpc: Pick<RpcClient, "call">,
    recoveryCoordinator?: Pick<RecoveryCoordinator, "registerResubscribeHandler">
  ) {
    this.typed = createTypedServiceClient("events", eventsMethods, (service, method, args) =>
      rpc.call("main", `${service}.${method}`, args)
    );
    recoveryCoordinator?.registerResubscribeHandler("events-client", () => this.resubscribeAll());
  }
  async subscribe(event: EventName): Promise<void> {
    this.subscriptions.add(event);
    try {
      await this.typed.subscribe(event);
    } catch (error) {
      this.subscriptions.delete(event);
      throw error;
    }
  }
  async unsubscribe(event: EventName): Promise<void> {
    this.subscriptions.delete(event);
    await this.typed.unsubscribe(event);
  }
  async unsubscribeAll(): Promise<void> {
    this.subscriptions.clear();
    await this.typed.unsubscribeAll();
  }
  async resubscribeAll(): Promise<void> {
    for (const event of this.subscriptions) {
      await this.typed.subscribe(event);
    }
  }
}
