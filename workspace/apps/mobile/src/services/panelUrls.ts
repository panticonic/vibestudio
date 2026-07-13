/**
 * Panel URL construction for React Native.
 *
 * Panel identity is injected into the WebView by native code before content
 * loads, so the URL only needs to point at the static panel bundle.
 */

import { isManagedHost, parsePanelUrl } from "@vibestudio/shell-core/urlParsing";

export { isManagedHost, parsePanelUrl };

/**
 * Panels are served from the loopback asset façade on every platform, so the
 * managed-origin gate is loopback — there is no remote managed host.
 */
export const LOOPBACK_PANEL_HOST = "127.0.0.1";

/**
 * Host configuration extracted from the server URL.
 *
 * Example: serverUrl "https://vibestudio.example.com:3000"
 *   -> protocol: "https"
 *   -> host: "vibestudio.example.com"
 *   -> port: "3000" (or empty for default ports)
 */
export interface HostConfig {
  /** Protocol without trailing colon (e.g. "https") */
  protocol: string;
  /** Host without port (e.g. "vibestudio.example.com") */
  host: string;
  /** Port string, or empty if using default port for protocol */
  port: string;
  /** Path prefix for a selected workspace endpoint, without trailing slash */
  basePath: string;
}

/**
 * Parse a server URL into a HostConfig.
 *
 * @param serverUrl - Full server URL, e.g. "https://vibestudio.example.com:3000"
 */
export function parseHostConfig(serverUrl: string): HostConfig {
  // Manual parsing instead of `new URL()` — Hermes doesn't fully implement URL API
  const match = serverUrl
    .trim()
    .match(/^(https?):\/\/(\[[^\]]+\]|[^/?#:@]+)(?::(\d+))?(\/[^?#]*)?$/);
  if (!match) throw new Error(`Invalid server URL: ${serverUrl}`);
  const [, protocol, host, port, rawPath] = match;
  if (!protocol || !host) throw new Error(`Invalid server URL: ${serverUrl}`);
  const path = (rawPath ?? "").replace(/\/+$/, "");
  return {
    protocol,
    host,
    port: port ?? "",
    basePath: path === "/" ? "" : path,
  };
}

/**
 * Build the full URL to load a panel in a WebView.
 *
 * @param source - Panel source path (e.g. "panels/chat")
 * @param contextId - Context ID for storage partition sharing
 * @param hostConfig - Parsed server host configuration
 *
 * @returns The URL string to load in the WebView
 */
export function buildPanelUrl(source: string, contextId: string, hostConfig: HostConfig): string {
  // Panels load from a fixed loopback origin (the on-device asset façade), never
  // a remote server: panel RPC rides the postMessage bridge, not a direct
  // socket. `hostConfig.port` is the loopback façade port; protocol/host are
  // fixed loopback. (Native seam: the embedded loopback server supplies the
  // façade port via `hostConfig.port`.)
  const portSuffix = hostConfig.port ? `:${hostConfig.port}` : "";
  const origin = `http://${LOOPBACK_PANEL_HOST}${portSuffix}${hostConfig.basePath ?? ""}`;
  const encodedPath = encodeURIComponent(source).replace(/%2F/g, "/");
  return `${origin}/${encodedPath}/?contextId=${encodeURIComponent(contextId)}`;
}

/**
 * The host that isManagedHost() and parsePanelUrl() check against. Panels load
 * from the loopback façade, so the managed origin is always loopback regardless
 * of the (now transport-only) server URL in `hostConfig`.
 */
export function getExternalHost(_hostConfig: HostConfig): string {
  return LOOPBACK_PANEL_HOST;
}
