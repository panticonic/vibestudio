/**
 * Shared constants for the NatStack application.
 * Centralized to avoid magic numbers and ensure consistency.
 */

// =============================================================================
// AI / Tool Execution Timeouts
// =============================================================================

/**
 * Maximum time allowed for a single tool execution (5 minutes).
 * Used by both main process and worker manager.
 */
export const TOOL_EXECUTION_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Maximum duration for an AI stream before forced cancellation (10 minutes).
 * Prevents runaway streams from consuming resources indefinitely.
 */
export const MAX_STREAM_DURATION_MS = 10 * 60 * 1000;

/**
 * Default maximum steps for agent loops (tool-calling iterations).
 */
export const DEFAULT_MAX_STEPS = 10;

// =============================================================================
// Client-side panel GC (local renderer / lease reclamation)
// =============================================================================

/**
 * A panel that has not been the visible/active panel for this long becomes
 * eligible for automatic local unload (renderer destroyed + lease released).
 * The tree entry is untouched; re-focusing transparently rebuilds it.
 */
export const PANEL_UI_IDLE_UNLOAD_MS = 60 * 60 * 1000; // 1h inactivity threshold

/**
 * Cadence of the idle GC sweep on both clients. A panel unloads within one
 * sweep interval after crossing the idle line; this also bounds post-unpin latency.
 */
export const PANEL_UI_IDLE_SWEEP_MS = 5 * 60 * 1000; // sweep cadence (both clients)

/**
 * Maximum number of simultaneously loaded (leased + rendered) panels per client.
 * Pin-aware eviction sheds the oldest unpinned panel when exceeded.
 */
export const PANEL_UI_MAX_LOADED_DESKTOP = 16;
export const PANEL_UI_MAX_LOADED_MOBILE = 5; // replaces local MAX_WEBVIEWS

/**
 * Headless hosts (the always-on in-app headless host and the standalone
 * `apps/headless-host` browser host) shed panels far more aggressively than an
 * interactive client: no human is watching, so an idle automation surface is
 * pure cost. They share the GC selectors but with a tighter threshold + a
 * finer sweep cadence (no pins apply; `keepLoaded` still protects automation).
 */
export const PANEL_UI_IDLE_UNLOAD_MS_HEADLESS = 5 * 60 * 1000; // 5m idle threshold
export const PANEL_UI_IDLE_SWEEP_MS_HEADLESS = 30 * 1000; // 30s sweep cadence
export const PANEL_UI_MAX_LOADED_HEADLESS = 8;

// =============================================================================
// Content Security Policy
// =============================================================================

/**
 * Build a permissive CSP for panels and workers.
 * Allows connections to localhost services and external APIs.
 * When externalHost is provided, also allows connections to that host.
 */
export function buildPanelCsp(externalHost?: string): string {
  const hostEntries = externalHost && externalHost !== "localhost"
    ? ` ws://${externalHost}:* wss://${externalHost}:* http://${externalHost}:* https://${externalHost}:*`
    : "";
  return [
    "default-src 'self' https: data: blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: http://localhost:* http://127.0.0.1:*",
    "style-src 'self' 'unsafe-inline' https:",
    "img-src 'self' https: data: blob:",
    "font-src 'self' https: data:",
    `connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:* http://127.0.0.1:* https://127.0.0.1:* ws://localhost:* wss://localhost:* http://localhost:* https://localhost:* ws: wss: https:${hostEntries}`,
  ].join("; ");
}

/**
 * Default CSP for localhost-only panels (backwards compatible).
 */
export const PANEL_CSP = buildPanelCsp();

/**
 * CSP meta tag for HTML injection.
 */
export const PANEL_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${PANEL_CSP}">`;
