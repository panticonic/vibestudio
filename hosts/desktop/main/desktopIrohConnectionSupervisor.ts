import { createDevLogger } from "@vibestudio/dev-log";
import type { IrohReach } from "@vibestudio/iroh-transport";
import { createNodeDeviceEndpoint, type NodeDeviceEndpoint } from "@vibestudio/iroh-transport/node";
import {
  createIrohServerClient,
  type IrohServerClient,
  type IrohServerClientArgs,
} from "./irohServerClient.js";

const log = createDevLogger("DesktopIroh");

export type DesktopIrohClientOptions = Omit<
  IrohServerClientArgs,
  "reach" | "deviceSecret" | "deviceEndpoint" | "pipe"
>;

interface DesktopIrohConnectionSupervisorOptions {
  deviceEndpoint?: NodeDeviceEndpoint;
  createClient?: typeof createIrohServerClient;
}

/**
 * Process-level owner for every remote Iroh connection made by one desktop.
 *
 * Hub control and workspace RPC have different peer Endpoint IDs, but they
 * share this process's one fresh endpoint (delegated once by the durable device
 * key) and therefore one native endpoint generation. Keeping their creation, relay history, generation replacement,
 * and shutdown here prevents either peer client from acquiring or disposing
 * native endpoint state independently.
 */
export class DesktopIrohConnectionSupervisor {
  private readonly deviceEndpoint: NodeDeviceEndpoint;
  private readonly clients = new Set<IrohServerClient>();
  private readonly acquisitions = new Set<Promise<IrohServerClient>>();
  private readonly acquisitionCleanupFailures: unknown[] = [];
  private readonly unsubscribeInvalidation: () => void;
  private readonly createClient: typeof createIrohServerClient;
  private closing: Promise<void> | null = null;

  constructor(
    deviceSecret: Uint8Array,
    relays: readonly string[],
    options: DesktopIrohConnectionSupervisorOptions = {}
  ) {
    this.deviceEndpoint = options.deviceEndpoint ?? createNodeDeviceEndpoint(deviceSecret, relays);
    this.createClient = options.createClient ?? createIrohServerClient;
    this.unsubscribeInvalidation = this.deviceEndpoint.owner.onInvalidation((invalidation) => {
      // The most destructive event this process can inflict on itself: every
      // healthy connection on the endpoint dies so that one timed-out dial can
      // be cancelled. It used to happen silently, which is why an oscillation
      // built out of it took two sessions of log archaeology to name.
      const dial = invalidation.timedOutDial;
      log.warn(
        `Iroh endpoint generation ${invalidation.generation} replaced after a dial to ${dial.peerEndpointId.slice(0, 12)} through ${dial.relayUrl} timed out after ${dial.deadlineMs}ms; closing ${this.clients.size} live connection(s)`
      );
      for (const client of this.clients) {
        client.invalidateEndpointGeneration(
          invalidation.generation,
          `Iroh endpoint generation ${invalidation.generation} replaced after a timed-out dial`
        );
      }
    });
  }

  connect(reach: IrohReach, options: DesktopIrohClientOptions): Promise<IrohServerClient> {
    if (this.closing)
      return Promise.reject(new Error("Desktop Iroh connection supervisor is closing"));
    const acquisition = Promise.resolve().then(async () => {
      if (this.closing) throw new Error("Desktop Iroh connection supervisor is closing");
      const client = await this.createClient({
        reach,
        deviceEndpoint: this.deviceEndpoint,
        ...options,
      });
      if (this.closing) {
        try {
          await client.close();
        } catch (error) {
          this.acquisitionCleanupFailures.push(error);
          throw error;
        }
        throw new Error("Desktop Iroh connection supervisor closed while connecting");
      }
      this.clients.add(client);
      return client;
    });
    this.acquisitions.add(acquisition);
    void acquisition.then(
      () => this.acquisitions.delete(acquisition),
      () => this.acquisitions.delete(acquisition)
    );
    return acquisition;
  }

  close(): Promise<void> {
    return (this.closing ??= Promise.resolve().then(async () => {
      const clients = [...this.clients];
      this.clients.clear();
      this.unsubscribeInvalidation();
      // Endpoint retirement releases pending dials and native session I/O.
      // Start it alongside every client, then join all admitted acquisitions.
      const settled = await Promise.allSettled([
        ...clients.map((client, index) =>
          Promise.resolve().then(async () => {
            log.info(`Shutdown client started: ${index}`);
            await client.close();
            log.info(`Shutdown client completed: ${index}`);
          })
        ),
        Promise.resolve().then(async () => {
          log.info("Shutdown endpoint started");
          await this.deviceEndpoint.owner.close();
          log.info("Shutdown endpoint completed");
        }),
      ]);
      log.info(`Shutdown joining ${this.acquisitions.size} client acquisitions`);
      await Promise.allSettled([...this.acquisitions]);
      log.info("Shutdown client acquisitions completed");
      const failures = settled.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      failures.push(...this.acquisitionCleanupFailures);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Desktop Iroh connections could not all be closed");
      }
    }));
  }
}
