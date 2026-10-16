/**
 * IPC transport bridge for the shell renderer.
 *
 * Replaces the WebSocket transport with Electron IPC (ipcRenderer ↔ ipcMain).
 * The shell no longer needs a WebSocket connection to the RPC server.
 */

import { ipcRenderer } from "electron";
import type { RpcEnvelope } from "@vibestudio/rpc";
import type { TransportBridge } from "./wsTransport.js";
import type { PanelBootObservation } from "@vibestudio/shared/panel/observation";

type EnvelopeHandler = (envelope: RpcEnvelope) => void;

/**
 * Create an IPC-based transport bridge for the shell.
 *
 * Messages are sent via ipcRenderer.send("vibestudio:rpc:send", envelope)
 * and received via ipcRenderer.on("vibestudio:rpc:message", (event, envelope)).
 */
export function createIpcTransport(): TransportBridge & {
  observeBoot(boot: PanelBootObservation): void;
} {
  const listeners = new Set<EnvelopeHandler>();
  const recoveryListeners = new Map<string, Set<(workspaceId?: string) => void | Promise<void>>>();
  let bootFailure: Error | undefined;
  const registration = new Map<
    string,
    { ready: Promise<void>; resolve(): void; reject(error: Error): void }
  >();
  const registered = (kind: string) => {
    let gate = registration.get(kind);
    if (!gate) {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const ready = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      void ready.catch(() => undefined);
      gate = { ready, resolve, reject };
      if (bootFailure) reject(bootFailure);
      registration.set(kind, gate);
    }
    return gate;
  };

  ipcRenderer.on(
    "vibestudio:rpc:recovery",
    (_event, kind: string, workspaceId?: string, requestId?: string) => {
      // The runtime's first registration is its readiness edge. A renderer
      // still evaluating its modules cannot acknowledge recovery yet.
      const runRecovery = async () => {
        for (;;) {
          if (bootFailure) throw bootFailure;
          const handlers = [...(recoveryListeners.get(kind) ?? [])];
          if (handlers.length > 0) {
            return Promise.allSettled(handlers.map(async (handler) => handler(workspaceId)));
          }
          await registered(kind).ready;
        }
      };
      const reportFailure = (reason: unknown) => {
        if (!requestId) {
          console.error("Renderer recovery failed:", reason);
          return;
        }
        const error = reason as { message?: unknown; code?: unknown; errorKind?: unknown } | null;
        ipcRenderer.send("vibestudio:rpc:recovered", requestId, {
          message: typeof error?.message === "string" ? error.message : String(reason),
          ...(typeof error?.code === "string" ? { code: error.code } : {}),
          ...(typeof error?.errorKind === "string" ? { errorKind: error.errorKind } : {}),
        });
      };
      void runRecovery().then((results) => {
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") {
          reportFailure(failure.reason);
        } else if (requestId) ipcRenderer.send("vibestudio:rpc:recovered", requestId);
      }, reportFailure);
    }
  );

  // Receive messages from main process
  ipcRenderer.on("vibestudio:rpc:message", (_event, envelope: RpcEnvelope) => {
    for (const listener of listeners) {
      try {
        listener(envelope);
      } catch (error) {
        console.error("Error in IPC transport message handler:", error);
      }
    }
  });

  return {
    observeBoot(boot) {
      if (boot.phase !== "failed") return;
      bootFailure = new Error(boot.message ?? "Panel bootstrap failed");
      bootFailure.name = boot.errorName ?? "Error";
      if (boot.stack) bootFailure.stack = boot.stack;
      for (const gate of registration.values()) gate.reject(bootFailure);
    },
    async send(envelope: RpcEnvelope): Promise<void> {
      ipcRenderer.send("vibestudio:rpc:send", envelope);
    },

    onMessage(handler: EnvelopeHandler): () => void {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },

    onRecovery(kind, handler): () => void {
      let handlers = recoveryListeners.get(kind);
      if (!handlers) recoveryListeners.set(kind, (handlers = new Set()));
      handlers.add(handler);
      registered(kind).resolve();
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) registration.delete(kind);
      };
    },
  };
}
