import { randomUUID } from "node:crypto";
import type { WebContents, IpcMainInvokeEvent } from "electron";
import type { RuntimeConnectionInfo } from "@vibestudio/rpc";
import type { ServerClient } from "./serverClient.js";

interface DocumentConnection {
  documentId: string;
  contents: WebContents;
  runtimeId: string;
  origin: string;
  frame: Electron.WebFrameMain;
  client: Pick<ServerClient, "call"> & Partial<Pick<ServerClient, "onDirectEvent">>;
  connected: boolean;
  pending?: Promise<unknown>;
  executionId?: string;
  result?: unknown;
  unsubscribe?: () => void;
}

/** Owns native document evidence. No page-provided origin, principal, or credential is accepted. */
export class WebsiteWorkspaceBridge {
  private readonly documents = new Map<number, DocumentConnection>();
  private readonly observed = new Map<number, () => void>();
  private closed = false;
  private readonly epochs = new Map<number, number>();
  constructor(
    private readonly deps: {
      resolve: (contents: WebContents) => {
        runtimeId: string;
        client: Pick<ServerClient, "call"> & Partial<Pick<ServerClient, "onDirectEvent">>;
        bootstrap: () => Promise<unknown>;
      };
      retireTransport: (contents: WebContents) => void;
    }
  ) {}

  connected(contents: WebContents): boolean {
    const doc = this.documents.get(contents.id);
    return Boolean(
      doc?.connected &&
      !contents.isDestroyed() &&
      doc.frame === contents.mainFrame &&
      new URL(contents.getURL()).origin === doc.origin
    );
  }

  /** Called once by the trusted isolated preload, never exposed as a page API. */
  async begin(event: IpcMainInvokeEvent): Promise<string> {
    if (this.closed) throw new Error("Website hosting is closed");
    const contents = event.sender;
    if (!event.senderFrame || event.senderFrame !== contents.mainFrame)
      throw new Error("Only the top-level website document can connect");
    this.observe(contents);
    const retirement = this.retire(contents);
    const epoch = this.epochs.get(contents.id);
    await retirement;
    if (
      this.closed ||
      contents.isDestroyed() ||
      this.epochs.get(contents.id) !== epoch ||
      event.senderFrame !== contents.mainFrame
    )
      throw new Error("Website document was replaced");
    const owner = this.deps.resolve(contents);
    const documentId = randomUUID();
    const doc: DocumentConnection = {
      contents,
      documentId,
      runtimeId: owner.runtimeId,
      origin: new URL(contents.mainFrame.url).origin,
      frame: contents.mainFrame,
      client: owner.client,
      connected: false,
    };
    this.documents.set(contents.id, doc);
    doc.unsubscribe = owner.client.onDirectEvent?.("website:connection-changed", (change) => {
      if (
        change.runtimeId === doc.runtimeId &&
        change.documentId === doc.executionId &&
        !change.connected
      )
        this.disconnectLocal(doc);
    });
    return documentId;
  }

  documentId(contents: WebContents): string | undefined {
    return this.connected(contents) ? this.documents.get(contents.id)?.documentId : undefined;
  }

  async connect(event: IpcMainInvokeEvent, documentId: string): Promise<unknown> {
    if (this.closed) throw new Error("Website hosting is closed");
    const contents = event.sender;
    if (!event.senderFrame || event.senderFrame !== contents.mainFrame)
      throw new Error("Only the top-level website document can connect");
    const owner = this.deps.resolve(contents);
    const url = new URL(contents.mainFrame.url);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error("Workspace connection requires an HTTP(S) website");
    const doc = this.documents.get(contents.id);
    if (
      !doc ||
      doc.documentId !== documentId ||
      !this.current(contents, doc) ||
      doc.runtimeId !== owner.runtimeId
    )
      throw new Error("Website document was replaced");
    if (doc.connected) return doc.result;
    if (doc.pending) return doc.pending;
    const current = doc;
    const executionId = randomUUID();
    current.executionId = executionId;
    current.pending = (async () => {
      await current.client.call("websiteHosting", "begin", [
        {
          runtimeId: current.runtimeId,
          documentId: executionId,
          origin: current.origin,
        },
      ]);
      if (!this.current(contents, current) || current.executionId !== executionId)
        throw new Error("Website document was replaced");
      const allowed = await current.client.call("websiteHosting", "connect", [
        {
          runtimeId: current.runtimeId,
          documentId: executionId,
        },
      ]);
      if (!this.current(contents, current) || current.executionId !== executionId)
        throw new Error("Website document was replaced");
      if (allowed !== true) throw new Error("Workspace connection was declined");
      const raw = await owner.bootstrap();
      if (!raw || typeof raw !== "object")
        throw new Error("Browser runtime configuration is unavailable");
      const config = raw as Record<string, unknown>;
      if (config["entityId"] !== current.runtimeId || typeof config["contextId"] !== "string")
        throw new Error("Browser runtime configuration does not match this document");
      const bootstrap: RuntimeConnectionInfo = {
        runtimeId: current.runtimeId,
        slotId: typeof config["slotId"] === "string" ? config["slotId"] : current.runtimeId,
        contextId: config["contextId"],
        parentId: typeof config["parentId"] === "string" ? config["parentId"] : null,
        parentEntityId:
          typeof config["parentEntityId"] === "string" ? config["parentEntityId"] : null,
        theme: config["theme"] === "dark" ? "dark" : "light",
      };
      if (!this.current(contents, current) || current.executionId !== executionId)
        throw new Error("Website document was replaced");
      current.connected = true;
      // Tokens and gateway credentials never cross the website boundary.
      current.result = { documentId: executionId, origin: current.origin, bootstrap };
      return current.result;
    })().finally(() => {
      current.pending = undefined;
    });
    return current.pending;
  }

  private current(contents: WebContents, doc: DocumentConnection): boolean {
    return (
      !contents.isDestroyed() &&
      this.documents.get(contents.id) === doc &&
      contents.mainFrame === doc.frame &&
      new URL(contents.getURL()).origin === doc.origin
    );
  }

  private observe(contents: WebContents): void {
    if (this.observed.has(contents.id)) return;
    const navigation = (
      _event: Electron.Event,
      _url: string,
      inPlace: boolean,
      mainFrame: boolean
    ) => {
      if (mainFrame && !inPlace) void this.retire(contents).catch(() => {});
    };
    const gone = () => {
      void this.retire(contents).catch(() => {});
    };
    const destroyed = () => {
      this.observed.get(contents.id)?.();
      this.observed.delete(contents.id);
      gone();
      this.epochs.delete(contents.id);
    };
    contents.on("did-start-navigation", navigation);
    contents.on("render-process-gone", gone);
    contents.once("destroyed", destroyed);
    this.observed.set(contents.id, () => {
      contents.off("did-start-navigation", navigation);
      contents.off("render-process-gone", gone);
      contents.off("destroyed", destroyed);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const unsubscribe of this.observed.values()) unsubscribe();
    this.observed.clear();
    this.epochs.clear();
    await Promise.all([...this.documents.values()].map((doc) => this.retire(doc.contents)));
  }

  async disconnect(event: IpcMainInvokeEvent, documentId: string): Promise<void> {
    if (event.senderFrame !== event.sender.mainFrame)
      throw new Error("Top-level document required");
    const doc = this.documents.get(event.sender.id);
    if (!doc || doc.documentId !== documentId) throw new Error("Website document was replaced");
    await this.disconnectDocument(doc);
  }

  private disconnectLocal(doc: DocumentConnection): void {
    doc.connected = false;
    doc.result = undefined;
    doc.executionId = undefined;
    this.deps.retireTransport(doc.contents);
    if (!doc.contents.isDestroyed()) doc.contents.send("vibestudio:website:disconnected");
  }

  private async disconnectDocument(doc: DocumentConnection): Promise<void> {
    const executionId = doc.executionId;
    this.disconnectLocal(doc);
    if (executionId)
      await doc.client.call("websiteHosting", "end", [
        { runtimeId: doc.runtimeId, documentId: executionId },
      ]);
  }

  async retire(contents: WebContents): Promise<void> {
    this.epochs.set(contents.id, (this.epochs.get(contents.id) ?? 0) + 1);
    const doc = this.documents.get(contents.id);
    if (!doc) return;
    this.documents.delete(contents.id);
    doc.unsubscribe?.();
    await this.disconnectDocument(doc);
  }
}
