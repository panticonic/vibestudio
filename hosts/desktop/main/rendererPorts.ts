import { ipcMain, MessageChannelMain, type IpcMainEvent, type WebContents } from "electron";
import { createDevLogger } from "@vibestudio/dev-log";
import { formatRpcFailure } from "@vibestudio/rpc";
import {
  RPC_PORT_GRANT_CHANNEL,
  RPC_PORT_LOST_CHANNEL,
  RPC_PORT_REQUEST_CHANNEL,
  type RpcPortGrant,
} from "../connection/rendererPortProtocol.js";
import type { MessagePortLike } from "../connection/controlChannel.js";
import type { ConnectionLink, PortBinding } from "./connectionLink.js";

const log = createDevLogger("RendererPorts");

export interface RendererPortBrokerDeps {
  /** The connection to bind ports on, or null while there is none. */
  link(): ConnectionLink | null;
  /**
   * Who a renderer document is, from main's own records of the views and
   * windows it created. Null for a renderer that is not attached to any
   * principal. Never derived from anything the renderer sent.
   */
  resolveBinding(contents: WebContents): PortBinding | null;
  /** Make the two ends of a port pair. */
  createChannel?(): { port1: MessagePortLike; port2: Electron.MessagePortMain };
}

/**
 * Hands each renderer document its RPC port.
 *
 * This is the whole of main's role in renderer RPC: a document asks once, main
 * establishes who it is from its own records, gives the connection process one
 * end of a fresh channel (bound to that principal's session) and the document
 * the other. Main never holds a port after that, so it never sees a request or
 * a response.
 */
export class RendererPortBroker {
  private readonly holders = new Map<number, WebContents>();
  private lost: string | null = null;
  private installed = false;
  private readonly onRequest = (event: IpcMainEvent): void => {
    void this.grant(event);
  };

  constructor(private readonly deps: RendererPortBrokerDeps) {}

  install(): void {
    if (this.installed) return;
    this.installed = true;
    ipcMain.on(RPC_PORT_REQUEST_CHANNEL, this.onRequest);
  }

  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    ipcMain.off(RPC_PORT_REQUEST_CHANNEL, this.onRequest);
  }

  /**
   * The connection process ended. Every document that holds a port learns the
   * reason from main (its port can only say that it closed), and later requests
   * are refused with it.
   */
  connectionLost(reason: string): void {
    this.lost = reason;
    for (const contents of this.holders.values()) {
      if (!contents.isDestroyed()) contents.send(RPC_PORT_LOST_CHANNEL, reason);
    }
    this.holders.clear();
  }

  /** A replacement connection process is established: documents may ask for their port again. */
  connectionRestored(): void {
    this.lost = null;
  }

  private async grant(event: IpcMainEvent): Promise<void> {
    const frame = event.senderFrame;
    const contents = event.sender;
    if (!frame || frame !== contents.mainFrame) {
      // Only a top-level document is a principal; it is never granted to a subframe.
      log.warn(`Refused an RPC port request from a subframe (webContents ${contents.id})`);
      return;
    }
    const refuse = (error: string): void => {
      if (!frame.isDestroyed())
        frame.postMessage(RPC_PORT_GRANT_CHANNEL, { error } satisfies RpcPortGrant);
    };
    const link = this.deps.link();
    if (this.lost !== null || !link) {
      refuse(this.lost ?? "The desktop connection is not available");
      return;
    }
    const binding = this.deps.resolveBinding(contents);
    if (!binding) {
      refuse("The panel or app is no longer attached.");
      return;
    }
    const { port1, port2 } = this.deps.createChannel?.() ?? new MessageChannelMain();
    try {
      await link.bindPort(binding, port1);
    } catch (error) {
      port2.close();
      refuse(formatRpcFailure(error));
      return;
    }
    if (frame.isDestroyed() || contents.isDestroyed()) {
      // The document went away while its session was being bound: the
      // connection process sees the other end close and releases the session.
      port2.close();
      return;
    }
    this.holders.set(contents.id, contents);
    contents.once("destroyed", () => this.holders.delete(contents.id));
    frame.postMessage(RPC_PORT_GRANT_CHANNEL, {} satisfies RpcPortGrant, [port2]);
  }
}
