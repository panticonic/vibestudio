import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { AddressInfo, Socket } from "node:net";

/** Own every accepted socket, including rejected and upgraded connections. */
export class EgressListener {
  readonly ready: Promise<number>;
  private readonly server;
  private readonly sockets = new Set<Socket>();
  private closePromise: Promise<void> | undefined;
  private rejectReady!: (error: Error) => void;

  constructor(handlers: {
    request(req: IncomingMessage, res: ServerResponse): void;
    connect(req: IncomingMessage, socket: Duplex, head: Buffer): void;
    upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  }) {
    this.server = createServer(handlers.request);
    this.server.on("connect", handlers.connect);
    this.server.on("upgrade", handlers.upgrade);
    this.server.on("connection", (socket) => {
      if (this.closePromise) {
        socket.destroy();
        return;
      }
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    this.ready = new Promise((resolve, reject) => {
      this.rejectReady = reject;
      this.server.on("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        if (this.closePromise) return;
        const address = this.server.address() as AddressInfo | null;
        if (!address) {
          reject(new Error("Egress listener failed to bind"));
          return;
        }
        resolve(address.port);
      });
    });
    // close may retire admission before its caller starts awaiting readiness.
    void this.ready.catch(() => undefined);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.rejectReady(new Error("Egress listener retired during startup"));
    this.closePromise = new Promise((resolve) => {
      this.server.close(() => resolve());
      for (const socket of this.sockets) socket.destroy();
      this.server.closeAllConnections();
    });
    return this.closePromise;
  }
}
