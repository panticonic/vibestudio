import {
  ELECTRON_LOCAL_SERVICE_NAMES,
  responseEnvelopeFor,
  type EnvelopeRpcTransport,
  type RpcEnvelope,
  type RpcRequest,
} from "@natstack/rpc";
import { createRecoveryCoordinator } from "@natstack/shared/shell/recoveryCoordinator";
import type { RecoveryCoordinator, RecoveryKind } from "@natstack/shared/shell/recoveryCoordinator";

type NatstackTransportBridge = {
  send: (envelope: RpcEnvelope) => void | Promise<void>;
  onMessage: (handler: (envelope: RpcEnvelope) => void) => () => void;
  onRecovery?: (kind: RecoveryKind, handler: () => void | Promise<void>) => () => void;
};

export const recoveryCoordinator: RecoveryCoordinator = createRecoveryCoordinator();

function getTransportBridge(): NatstackTransportBridge {
  const bridge = (globalThis as any).__natstackTransport as NatstackTransportBridge | undefined;
  if (!bridge?.send || !bridge?.onMessage) {
    throw new Error("NatStack transport bridge is not available (missing __natstackTransport)");
  }
  return bridge;
}

/**
 * Services that panels should call through Electron main. `events` is local
 * for the shell, but panel event subscriptions must stay on the panel WS
 * connection so EventService has a delivery session for that caller.
 */
const electronLocalServices: ReadonlySet<string> = new Set(
  ELECTRON_LOCAL_SERVICE_NAMES.filter((service) => service !== "events")
);

/**
 * Resolve the Electron shell bridge's serviceCall method, if available.
 * Returns undefined when running outside Electron (mobile, headless).
 */
function getElectronServiceCall():
  | ((method: string, ...args: unknown[]) => Promise<unknown>)
  | undefined {
  const shell = (globalThis as any).__natstackShell ?? (globalThis as any).__natstackElectron;
  return typeof shell?.serviceCall === "function" ? shell.serviceCall : undefined;
}

function isRpcEnvelope(value: unknown): value is RpcEnvelope {
  const envelope = value as Partial<RpcEnvelope> | null;
  const message = envelope?.message as { type?: unknown } | undefined;
  return (
    !!envelope &&
    typeof envelope === "object" &&
    typeof envelope.from === "string" &&
    typeof envelope.target === "string" &&
    !!message &&
    typeof message === "object" &&
    typeof message.type === "string"
  );
}

export function createPanelTransport(): EnvelopeRpcTransport {
  const bridge = getTransportBridge();
  const electronServiceCall = getElectronServiceCall();
  const listeners = new Set<(envelope: RpcEnvelope) => void>();

  const deliver = (envelope: RpcEnvelope): void => {
    for (const listener of listeners) listener(envelope);
  };

  bridge.onRecovery?.("resubscribe", () => recoveryCoordinator.run("resubscribe"));
  bridge.onRecovery?.("cold-recover", () => recoveryCoordinator.run("cold-recover"));

  bridge.onMessage((envelope) => {
    if (isRpcEnvelope(envelope)) deliver(envelope);
  });

  return {
    async send(envelope: RpcEnvelope): Promise<void> {
      // Route RPC requests to "main": Electron-local services go via IPC
      // through __natstackShell.serviceCall. Everything else goes to the
      // server so userland/workerd services do not need static routing edits.
      if (envelope.target === "main" && envelope.message.type === "request") {
        const request = envelope.message as RpcRequest;
        const dotIdx = request.method.indexOf(".");
        const service = dotIdx > 0 ? request.method.slice(0, dotIdx) : "";

        if (electronLocalServices.has(service)) {
          if (!electronServiceCall) {
            // Electron-local service called from a non-Electron context
            // (mobile, headless). Fail fast with a clear message instead
            // of sending to the server where it'd fail with a confusing
            // "Unknown service" error.
            deliver(
              responseEnvelopeFor(
                envelope,
                { callerId: "main", callerKind: "shell" },
                {
                  type: "response",
                  requestId: request.requestId,
                  error:
                    `Service '${service}' is an Electron-local service ` +
                    `and requires the Electron desktop app. It is not available ` +
                    `in this context.`,
                }
              )
            );
            return;
          }

          // Dispatch via Electron IPC and deliver a synthetic response
          void (async () => {
            try {
              const result = await electronServiceCall(request.method, ...(request.args ?? []));
              deliver(
                responseEnvelopeFor(
                  envelope,
                  { callerId: "main", callerKind: "shell" },
                  {
                    type: "response",
                    requestId: request.requestId,
                    result,
                  }
                )
              );
            } catch (err) {
              deliver(
                responseEnvelopeFor(
                  envelope,
                  { callerId: "main", callerKind: "shell" },
                  {
                    type: "response",
                    requestId: request.requestId,
                    error: err instanceof Error ? err.message : String(err),
                  }
                )
              );
            }
          })();
          return;
        }
      }

      await bridge.send(envelope);
    },

    onMessage(handler: (envelope: RpcEnvelope) => void): () => void {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
}
