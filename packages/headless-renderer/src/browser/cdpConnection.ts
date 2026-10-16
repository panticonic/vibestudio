/**
 * Raw CDP client over Chromium's browser-level WebSocket.
 *
 * The host's main job is verbatim relay of bridge commands (which carry an
 * optional flat-mode sessionId), so this speaks the wire protocol directly:
 * {id, method, params, sessionId?} out, {id, result|error} / {method, params,
 * sessionId?} in. It also maintains a sessionId → slot ownership map so
 * events from panel sessions (and any nested sessions an automation client
 * attaches via Target.attachToTarget) route back to the right bridge target.
 */
import { WebSocket } from "ws";

interface PendingCommand {
  method: string;
  sessionId?: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface CdpEventEnvelope {
  method: string;
  params: unknown;
  sessionId?: string;
}

export class CdpConnection {
  private nextId = 1;
  private closedError: Error | null = null;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly eventListeners = new Set<(event: CdpEventEnvelope) => void>();
  private readonly closeListeners = new Set<() => void>();
  /** sessionId → slotId ownership for event routing. */
  private readonly sessionOwners = new Map<string, string>();

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => this.handleMessage(String(data)));
    ws.on("error", (error) => {
      this.closedError = error;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
    ws.on("close", () => {
      const error = Object.assign(new Error("CDP connection closed"), { code: "CDP_CONNECTION_CLOSED" });
      this.closedError = error;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      for (const listener of this.closeListeners) listener();
    });
  }

  static async connect(wsEndpoint: string): Promise<CdpConnection> {
    const ws = new WebSocket(wsEndpoint, { maxPayload: 256 * 1024 * 1024 });
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          ws.off("open", onOpen);
          ws.off("error", onError);
          ws.off("close", onClose);
        };
        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onClose = () => {
          cleanup();
          reject(new Error("CDP connection closed before opening"));
        };
        ws.once("open", onOpen);
        ws.once("error", onError);
        ws.once("close", onClose);
      });
    } catch (error) {
      ws.terminate();
      throw error;
    }
    return new CdpConnection(ws);
  }

  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    const message: Record<string, unknown> = { id, method };
    if (params !== undefined) message["params"] = params;
    if (sessionId) message["sessionId"] = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, sessionId, resolve, reject });
      this.ws.send(JSON.stringify(message), (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  onEvent(listener: (event: CdpEventEnvelope) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Claim a sessionId (and future children attached on it) for a slot. */
  claimSession(sessionId: string, slotId: string): void {
    this.sessionOwners.set(sessionId, slotId);
  }

  releaseSession(sessionId: string): void {
    this.rejectSessionCommands(sessionId, "CDP_SESSION_RELEASED", "CDP session ownership was released");
    this.sessionOwners.delete(sessionId);
  }

  private rejectSessionCommands(sessionId: string, code: string, message: string): void {
    for (const [id, command] of this.pending) {
      if (command.sessionId !== sessionId) continue;
      this.pending.delete(id);
      command.reject(Object.assign(new Error(`${message}: ${sessionId} (${command.method})`), {
        code, sessionId, operation: command.method,
      }));
    }
  }

  releaseSlotSessions(slotId: string): string[] {
    const released: string[] = [];
    for (const [sessionId, owner] of this.sessionOwners) {
      if (owner === slotId) {
        this.releaseSession(sessionId);
        released.push(sessionId);
      }
    }
    return released;
  }

  ownerOf(sessionId: string | undefined): string | undefined {
    return sessionId ? this.sessionOwners.get(sessionId) : undefined;
  }

  close(): void {
    if (!this.closedError) {
      this.closedError = Object.assign(new Error("CDP connection closed by its owner"), { code: "CDP_CONNECTION_CLOSED" });
      for (const command of this.pending.values()) command.reject(this.closedError);
      this.pending.clear();
    }
    this.ws.close();
  }

  private handleMessage(raw: string): void {
    let parsed: {
      id?: number;
      result?: unknown;
      error?: { message?: string; data?: string };
      method?: string;
      params?: unknown;
      sessionId?: string;
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (parsed.id !== undefined) {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      this.pending.delete(parsed.id);
      if (parsed.error) {
        const detail = parsed.error.data ? `: ${parsed.error.data}` : "";
        pending.reject(new Error(`${parsed.error.message ?? "CDP error"}${detail}`));
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }
    if (!parsed.method) return;
    if (parsed.sessionId && (parsed.method === "Inspector.targetCrashed" || parsed.method === "Inspector.detached")) {
      const crashed = parsed.method === "Inspector.targetCrashed";
      this.rejectSessionCommands(parsed.sessionId, crashed ? "CDP_TARGET_CRASHED" : "CDP_TARGET_DETACHED",
        crashed ? "CDP target crashed" : "CDP target detached");
    }

    // Track nested sessions: an attach event arriving on a session we own
    // claims the child session for the same slot.
    if (parsed.method === "Target.attachedToTarget" && parsed.sessionId) {
      const owner = this.sessionOwners.get(parsed.sessionId);
      const childSessionId = (parsed.params as { sessionId?: string } | undefined)?.sessionId;
      if (owner && childSessionId) this.sessionOwners.set(childSessionId, owner);
    }
    if (parsed.method === "Target.detachedFromTarget") {
      const childSessionId = (parsed.params as { sessionId?: string } | undefined)?.sessionId;
      if (childSessionId) {
        this.rejectSessionCommands(childSessionId, "CDP_TARGET_DETACHED", "CDP target detached");
        this.sessionOwners.delete(childSessionId);
      }
    }

    for (const listener of this.eventListeners) {
      listener({ method: parsed.method, params: parsed.params, sessionId: parsed.sessionId });
    }
  }
}
