import { EndpointGenerationOwner, type IrohReach } from "@vibestudio/iroh-transport";
import {
  createNodeEndpointBinding,
  loadIrohNodeBinding,
  type NodePhysicalConnection,
  type NodePhysicalEndpoint,
} from "@vibestudio/iroh-transport/node";
import {
  createIrohServerClient,
  type IrohServerClient,
  type IrohServerClientArgs,
} from "./irohServerClient.js";

export type DesktopIrohClientOptions = Omit<
  IrohServerClientArgs,
  "reach" | "endpointSecret" | "endpointOwner" | "pipe"
>;

/**
 * Process-level owner for every remote Iroh connection made by one desktop.
 *
 * Hub control and workspace RPC have different peer Endpoint IDs, but they
 * share one durable local identity and therefore one native endpoint
 * generation. Keeping their creation, relay history, generation replacement,
 * and shutdown here prevents either peer client from acquiring or disposing
 * native endpoint state independently.
 */
export class DesktopIrohConnectionSupervisor {
  private readonly endpointOwner: EndpointGenerationOwner<
    NodePhysicalConnection,
    NodePhysicalEndpoint
  >;
  private readonly clients = new Set<IrohServerClient>();
  private closing: Promise<void> | null = null;

  constructor(endpointSecret: Uint8Array, relays: readonly string[]) {
    if (endpointSecret.byteLength !== 32) {
      throw new Error("Stored Iroh endpoint identity is invalid");
    }
    this.endpointOwner = new EndpointGenerationOwner(
      createNodeEndpointBinding({
        secretKey: loadIrohNodeBinding().SecretKey.fromBytes([...endpointSecret]),
        relayUrls: relays,
      })
    );
  }

  async connect(reach: IrohReach, options: DesktopIrohClientOptions): Promise<IrohServerClient> {
    if (this.closing) throw new Error("Desktop Iroh connection supervisor is closing");
    const client = await createIrohServerClient({
      reach,
      endpointOwner: this.endpointOwner,
      ...options,
    });
    if (this.closing) {
      await client.close();
      throw new Error("Desktop Iroh connection supervisor closed while connecting");
    }
    this.clients.add(client);
    return client;
  }

  close(): Promise<void> {
    return (this.closing ??= (async () => {
      const clients = [...this.clients];
      this.clients.clear();
      // Logical sessions finish their control writers while the native
      // endpoint is still alive. Only then release the process endpoint.
      const clientResults = await Promise.allSettled(
        clients.map((client) => Promise.resolve().then(() => client.close()))
      );
      const endpointResult = await Promise.resolve()
        .then(() => this.endpointOwner.close())
        .then(
          () => ({ status: "fulfilled" as const, value: undefined }),
          (reason) => ({ status: "rejected" as const, reason })
        );
      const settled = [...clientResults, endpointResult];
      const failures = settled.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Desktop Iroh connections could not all be closed");
      }
    })());
  }
}
