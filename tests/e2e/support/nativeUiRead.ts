import type { Page } from "@playwright/test";
import type { RpcEnvelope, RpcDestination } from "@vibestudio/rpc";

/** Read-only assertions use the same admitted native System UI transport as the product. */
export async function nativeUiRead<T>(
  page: Page,
  destination: RpcDestination,
  method: string,
  args: unknown[]
): Promise<T> {
  return page.evaluate(
    async ({ destination, method, args }) => {
      const bridge = (
        window as unknown as {
          __vibestudioTransport: {
            identity: { runtimeId: string; workspaceId: string };
            send(envelope: RpcEnvelope): Promise<void>;
            onMessage(handler: (envelope: RpcEnvelope) => void): () => void;
          };
        }
      ).__vibestudioTransport;
      const requestId = `e2e-copy-read-${crypto.randomUUID()}`;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          reject(new Error(`Timed out reading ${method}`));
        }, 30_000);
        const off = bridge.onMessage(({ message, delivery }) => {
          if (message.type !== "response" || message.requestId !== requestId) return;
          clearTimeout(timer);
          off();
          if (
            delivery.caller.workspaceId !==
            (destination.kind === "workspace" ? destination.workspaceId : undefined)
          ) {
            reject(new Error(`Received ${method} from a different owner`));
            return;
          }
          if ("error" in message) reject(new Error(message.error));
          else resolve(message.result as T);
        });
        const caller = {
          callerId: bridge.identity.runtimeId,
          callerKind: "app" as const,
          workspaceId: bridge.identity.workspaceId,
        };
        void bridge
          .send({
            from: caller.callerId,
            target: "main",
            destination,
            delivery: { caller },
            provenance: [caller],
            message: { type: "request", requestId, fromId: caller.callerId, method, args },
          })
          .catch((error) => {
            clearTimeout(timer);
            off();
            reject(error);
          });
      });
    },
    { destination, method, args }
  );
}
