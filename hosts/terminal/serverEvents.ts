import { schemaRpcCaller } from "@vibestudio/rpc/internal";
import { EventsClient } from "@vibestudio/service-schemas/clients/eventsClient";
import type { RpcClient } from "../../src/cli/rpcClient.js";

/** An events session beside a device connection: the server's pushes this host acts on. */
export interface ServerEvents {
  events: EventsClient;
  /** Ends the watch and closes its connection; both are always attempted. */
  close(): Promise<void>;
}

export async function openServerEvents(device: RpcClient): Promise<ServerEvents> {
  const eventRpc = await device.openSiblingConnection();
  const events = new EventsClient(
    schemaRpcCaller({ streamReadable: eventRpc.streamReadable.bind(eventRpc) })
  );
  return {
    events,
    close: async () => {
      try {
        await events.unsubscribeAll();
      } finally {
        await eventRpc.close();
      }
    },
  };
}
