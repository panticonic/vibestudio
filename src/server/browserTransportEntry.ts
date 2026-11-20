/**
 * Browser transport entry point — compiled to an IIFE by the build system and
 * served as `__transport.js` under each panel route.
 *
 * Panel RPC rides the **shell bridge** (`__vibestudioShell` — Electron
 * `contextBridge` on desktop, the React-Native `postMessage` bridge on mobile),
 * which the host muxes onto its control channel as the panel's own logical
 * session. Headless Chromium has no preload/postMessage host boundary, so this
 * entry installs a fallback shell bridge backed by the panel's own `/rpc`
 * WebSocket when the host has not already exposed one.
 *
 * It reconciles the latest committed state arguments before the panel bundle
 * starts. The installed runtime then consumes updates on the same shell.
 *
 * Timing: the panel bootstrap script runs as a blocking <script> and sets the panel globals
 * before dynamically loading this script. Host preload/injection may already
 * have exposed `__vibestudioShell`; otherwise we synthesize it here before the
 * panel bundle starts.
 */

import { createRpcClient, createRpcInitiatorTransport } from "@vibestudio/rpc";
import { PanelShellClient } from "@vibestudio/service-schemas/clients/panelShellClient";
import { decodePanelStateArgs } from "@vibestudio/shared/panelStateArgs";
import {
  installFallbackShellBridge,
  type BrowserShellBridgeGlobals,
} from "./browserShellBridge.js";

// The panel runtime owns reactive updates. Before it subscribes to shell events,
// keep its initial snapshot current without emitting a second DOM event.
const browserWindow = window as Window & { __vibestudioStateArgs?: Record<string, unknown> };
const globals = globalThis as BrowserShellBridgeGlobals & {
  __vibestudioPreparePanelStateArgs?: () => Promise<void>;
};
const shell = installFallbackShellBridge(globals);
let receivedCommit = 0;
shell?.onEnvelope?.(({ delivery, message }) => {
  if (
    delivery.caller.callerKind === "server" &&
    message.type === "event" &&
    message.event === "runtime:stateArgsChanged"
  ) {
    receivedCommit += 1;
    browserWindow.__vibestudioStateArgs = message.payload as Record<string, unknown>;
  }
});

if (shell?.ready) {
  const { __vibestudioEntityId: entityId, __vibestudioSlotId: slotId } = globals;
  globals.__vibestudioPreparePanelStateArgs = async () => {
    if (!entityId || !slotId || !shell.onEnvelope || !shell.postEnvelope) {
      throw new Error("The authenticated panel shell is missing its runtime coordinates");
    }
    const readStartedAt = receivedCommit;
    let releaseRead: (() => void) | undefined;
    const rpc = createRpcClient({
      selfId: entityId,
      workspaceId: globals.__vibestudioWorkspaceId,
      callerKind: "panel",
      transport: createRpcInitiatorTransport({
        send: async (envelope) => shell.postEnvelope!(envelope),
        onMessage: (handler) => {
          const release = shell.onEnvelope!(handler);
          releaseRead = release;
          return release;
        },
      }),
    });
    try {
      const detail = await new PanelShellClient(rpc).getPanelDetail(slotId);
      if (!detail || detail.entity.id !== entityId) {
        throw new Error(`Panel ${slotId} moved while runtime ${entityId} was connecting`);
      }
      if (receivedCommit === readStartedAt) {
        browserWindow.__vibestudioStateArgs = decodePanelStateArgs(
          detail.currentHistory.state_args
        );
      }
    } finally {
      releaseRead?.();
    }
  };
}
