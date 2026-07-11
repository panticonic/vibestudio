/**
 * CLI-facing validation for canonical server base URLs.
 */

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function canonicalServerUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "webrtc:") {
    throw new Error(`Unsupported server URL protocol: ${url.protocol}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Server URL must not contain credentials, query parameters, or a fragment");
  }
  return url;
}

/** Validate and minimally canonicalize the server base URL accepted by RpcClient. */
export function normalizeServerBaseUrl(raw: string): string {
  const url = canonicalServerUrl(raw);
  return stripTrailingSlash(url.toString());
}

/** Compare two canonical server URLs without endpoint/path compatibility folding. */
export function serverUrlsReferToSameBase(left: string, right: string): boolean {
  try {
    return normalizeServerBaseUrl(left) === normalizeServerBaseUrl(right);
  } catch {
    return false;
  }
}
