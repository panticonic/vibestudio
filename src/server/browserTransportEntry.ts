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
 * It retains the latest committed state arguments for startup. The installed
 * runtime consumes the same shell event once the panel bundle starts.
 *
 * Timing: the panel bootstrap script runs as a blocking <script> and sets the panel globals
 * before dynamically loading this script. Host preload/injection may already
 * have exposed `__vibestudioShell`; otherwise we synthesize it here before the
 * panel bundle starts.
 */

import { installFallbackShellBridge } from "./browserShellBridge.js";

// The panel runtime owns reactive updates. Before it subscribes to shell events,
// keep its initial snapshot current without emitting a second DOM event.
const browserWindow = window as Window & { __vibestudioStateArgs?: Record<string, unknown> };
const shell = installFallbackShellBridge();
shell?.onEnvelope?.(({ delivery, message }) => {
  if (
    delivery.caller.callerKind === "server" &&
    message.type === "event" &&
    message.event === "runtime:stateArgsChanged"
  ) {
    browserWindow.__vibestudioStateArgs = message.payload as Record<string, unknown>;
  }
});
