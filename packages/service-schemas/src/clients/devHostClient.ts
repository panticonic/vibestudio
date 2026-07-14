import type { RpcCaller } from "@vibestudio/rpc";
import {
  createTypedServiceClient,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";
import {
  devHostMethods,
  devLaunchEventSchema,
  devLogEntrySchema,
  type DevLaunchEvent,
  type DevLogEntry,
} from "../devHost.js";

type WireClient = TypedServiceClient<typeof devHostMethods>;

export type DevHostClient = Omit<WireClient, "logs" | "watch"> & {
  logs(input: { launchId: string; after?: number }): AsyncIterable<DevLogEntry>;
  watch(input: { launchId: string; after?: number }): AsyncIterable<DevLaunchEvent>;
};

/** Typed dev-host client with cancellation-safe async iteration for live streams. */
export function createDevHostClient(rpc: RpcCaller): DevHostClient {
  const wire = createTypedServiceClient("devHost", devHostMethods, (service, method, args) =>
    rpc.call("main", `${service}.${method}`, args)
  );
  return {
    ...wire,
    logs: (input) =>
      readNdjson(
        () => rpc.stream("main", "devHost.logs", [input]),
        (value) => devLogEntrySchema.parse(value)
      ),
    watch: (input) =>
      readNdjson(
        () => rpc.stream("main", "devHost.watch", [input]),
        (value) => devLaunchEventSchema.parse(value)
      ),
  };
}

function readNdjson<T>(open: () => Promise<Response>, parse: (value: unknown) => T): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      const response = await open();
      if (!response.ok || !response.body) {
        throw new Error(
          `Development stream failed with HTTP ${response.status} ${response.statusText}`.trim()
        );
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      try {
        while (true) {
          const next = await reader.read();
          buffered += decoder.decode(next.value, { stream: !next.done });
          let newline = buffered.indexOf("\n");
          while (newline >= 0) {
            const line = buffered.slice(0, newline).trim();
            buffered = buffered.slice(newline + 1);
            if (line) yield parse(JSON.parse(line));
            newline = buffered.indexOf("\n");
          }
          if (next.done) break;
        }
        const finalLine = buffered.trim();
        if (finalLine) yield parse(JSON.parse(finalLine));
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    },
  };
}
