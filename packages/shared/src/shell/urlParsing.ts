/**
 * URL parsing utilities for panel URLs.
 *
 * Platform-independent helpers extracted from PanelView (Electron).
 * Used by both Electron and React Native to identify managed URLs
 * and parse panel navigation targets.
 */

export interface ParsedPanelUrl {
  source: string;
  contextId?: string;
  ref?: string;
  options: { name?: string; contextId?: string; focus?: boolean; ref?: string };
  stateArgs?: Record<string, unknown>;
}

interface ParsedUrlLike {
  hostname: string;
  port: string;
  pathname: string;
  queryParams: Map<string, string>;
}

interface ParsedAuthority {
  hostname: string;
  port: string;
}

function parseAuthority(authority: string): ParsedAuthority | null {
  const trimmed = authority.trim().toLowerCase();
  if (!trimmed) return null;
  const ipv6 = trimmed.match(/^(\[[^\]]+\])(?::(\d+))?$/);
  if (ipv6) return { hostname: ipv6[1]!, port: ipv6[2] ?? "" };
  const match = trimmed.match(/^([^:]+)(?::(\d+))?$/);
  if (!match) return null;
  return { hostname: match[1]!, port: match[2] ?? "" };
}

function parseUrlLike(url: string): ParsedUrlLike | null {
  const match = url.match(/^(https?):\/\/([^/?#]+)([^?#]*)?(?:\?([^#]*))?(?:#.*)?$/i);
  if (!match) return null;

  const host = match[2] ?? "";
  const authority = parseAuthority(host);
  if (!authority) return null;

  const pathname = match[3] && match[3].length > 0 ? match[3] : "/";
  const rawQuery = match[4] ?? "";
  const queryParams = new Map<string, string>();

  for (const part of rawQuery.split("&")) {
    if (!part) continue;
    const separatorIndex = part.indexOf("=");
    const rawKey = separatorIndex === -1 ? part : part.slice(0, separatorIndex);
    const rawValue = separatorIndex === -1 ? "" : part.slice(separatorIndex + 1);
    try {
      const key = decodeURIComponent(rawKey.replace(/\+/g, " "));
      const value = decodeURIComponent(rawValue.replace(/\+/g, " "));
      queryParams.set(key, value);
    } catch {
      return null;
    }
  }

  return {
    hostname: authority.hostname,
    port: authority.port,
    pathname,
    queryParams,
  };
}

/**
 * Check if a URL targets the managed host (with or without explicit port).
 *
 * @param url - The URL to check
 * @param externalHost - The managed host domain (e.g. "vibestudio.example.com")
 */
export function isManagedHost(url: string, externalHost: string): boolean {
  const parsed = parseUrlLike(url);
  if (!parsed) return false;
  const expected = parseAuthority(externalHost);
  if (!expected) return false;
  if (parsed.hostname !== expected.hostname) return false;
  return !expected.port || parsed.port === expected.port;
}

/**
 * Parse a panel URL into its constituent parts (source, contextId, options, stateArgs).
 * Returns null if the URL is not a valid panel URL.
 *
 * @param url - The URL to parse
 * @param externalHost - The managed host domain (e.g. "vibestudio.example.com")
 */
export function parsePanelUrl(url: string, externalHost: string): ParsedPanelUrl | null {
  const parsed = parseUrlLike(url);
  if (!parsed) return null;
  if (!isManagedHost(url, externalHost)) return null;

  const match = parsed.pathname.match(/^\/([^/]+\/[^/]+)(\/.*)?$/);
  if (!match) return null;
  const source = match[1]!;
  if ((match[2] || "/") !== "/") return null;
  if (
    parsed.queryParams.has("_bk") ||
    parsed.queryParams.has("pid") ||
    parsed.queryParams.has("_fresh")
  ) {
    return null;
  }

  const contextId = parsed.queryParams.get("contextId");
  const ref = parsed.queryParams.get("ref");
  const name = parsed.queryParams.get("name");
  const focus = parsed.queryParams.get("focus");
  const rawStateArgs = parsed.queryParams.get("stateArgs");

  return {
    source,
    contextId: contextId ?? undefined,
    ref: ref ?? undefined,
    options: {
      contextId: contextId ?? undefined,
      ref: ref ?? undefined,
      name: name ?? undefined,
      focus: focus === "true" || undefined,
    },
    stateArgs:
      rawStateArgs != null
        ? (() => {
            try {
              return JSON.parse(rawStateArgs) as Record<string, unknown>;
            } catch {
              return undefined;
            }
          })()
        : undefined,
  };
}
