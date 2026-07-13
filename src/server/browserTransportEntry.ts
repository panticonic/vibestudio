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
 * It also applies early `stateArgs:updated` events the host pushes over the
 * bridge before the panel bundle's runtime is up.
 *
 * Timing: the panel bootstrap script runs as a blocking <script> and sets the panel globals
 * before dynamically loading this script. Host preload/injection may already
 * have exposed `__vibestudioShell`; otherwise we synthesize it here before the
 * panel bundle starts.
 */

import { applyStateArgsSnapshot } from "@vibestudio/shared/panel/applyStateArgsSnapshot";
import { installFallbackShellBridge } from "./browserShellBridge.js";

type RuntimeEventMessage = {
  type: "event";
  event: string;
  payload: unknown;
};

function isRuntimeEventMessage(message: unknown): message is RuntimeEventMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "event" &&
    typeof (message as { event?: unknown }).event === "string"
  );
}

// ---------------------------------------------------------------------------
// stateArgs listener
// ---------------------------------------------------------------------------
// The host pushes runtime events (incl. stateArgs:updated) over the shell bridge
// back to the panel's logical session. This early listener applies them before
// the panel bundle's runtime takes over; applyStateArgsSnapshot is idempotent.

const shell = installFallbackShellBridge();

shell?.onEnvelope?.((envelope) => {
  const message = envelope.message;
  if (isRuntimeEventMessage(message) && message.event === "stateArgs:updated") {
    const stateArgs =
      message.payload && typeof message.payload === "object"
        ? (message.payload as Record<string, unknown>)
        : {};
    applyStateArgsSnapshot(stateArgs);
  }
});
