/**
 * Shared panel-asset façade header policy. The desktop (Node `http`) and mobile
 * (`react-native-tcp-socket`) façades both proxy webview asset requests over the
 * host pipe to `gateway.fetch`, so they MUST forward + strip the SAME headers.
 * These lists had drifted — mobile silently dropped `authorization`, so auth'd
 * asset routes loaded on desktop but 401'd on mobile. Single-sourced here so the
 * policy can't diverge again; the per-transport streaming/parsing plumbing stays
 * in each façade (only the policy is shared).
 */

/**
 * Request headers forwarded to the gateway. `host`, `cookie`, and
 * `accept-encoding` are intentionally NOT forwarded — they describe the façade hop,
 * not the upstream asset request (and the gateway serves assets uncompressed).
 * `content-length` is also NOT forwarded: request bodies are re-framed as a
 * stream over the pipe (plan §1.6), so the loopback fetch re-derives framing.
 */
export const FORWARD_REQUEST_HEADERS: readonly string[] = [
  "authorization",
  "accept",
  "accept-language",
  "cache-control",
  // Describes the forwarded request BODY (plan §1.6 — the façades forward
  // non-GET/HEAD bodies); a POST body without its content-type is broken.
  "content-type",
  "range",
  "if-none-match",
  "if-modified-since",
  "user-agent",
];

export function hasRangeRequestHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  return Object.keys(headers).some((name) => name.toLowerCase() === "range");
}

/**
 * Response headers that describe the buffered / re-framed hop and must NOT be
 * echoed to the webview: the body is fully re-sent, so length is recomputed and
 * any upstream content/transfer encoding no longer applies.
 */
export const STRIP_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

/**
 * Set (value `"1"`) by `gateway.fetch` when it gzipped the body on the wire, so a
 * façade can re-derive `Content-Encoding: gzip` for the webview after stripping the
 * upstream encoding header.
 */
export const GZIP_MARKER_HEADER = "x-vibez1-content-gzip";
