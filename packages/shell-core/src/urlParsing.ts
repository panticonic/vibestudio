/**
 * URL parsing utilities for panel URLs.
 *
 * Platform-independent helpers extracted from PanelView (Electron).
 * Used by both Electron and React Native to identify managed URLs
 * and parse panel navigation targets.
 */

import type { PanelDisposition, PanelLocation } from "@vibestudio/shared/panelLocation";
import { isPanelStateArgs } from "@vibestudio/shared/panelLocation";

export interface ParsedPanelUrl extends PanelLocation {
  options: { name?: string; contextId?: string; focus?: boolean; ref?: string };
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

function normalizeBasePath(basePath: string): string {
  if (!basePath || basePath === "/") return "";
  const withLeadingSlash = basePath.startsWith("/") ? basePath : `/${basePath}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

function workspaceFromBasePath(basePath: string): string | undefined {
  const match = normalizeBasePath(basePath).match(/^\/_workspace\/([^/]+)$/);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function stripBasePath(url: string, basePath: string): string | null {
  const normalizedBasePath = normalizeBasePath(basePath);
  if (!normalizedBasePath) return url;

  const parsed = parseUrlLike(url);
  if (!parsed) return null;
  if (
    parsed.pathname !== normalizedBasePath &&
    !parsed.pathname.startsWith(`${normalizedBasePath}/`)
  ) {
    return null;
  }

  const match = url.match(/^(https?:\/\/[^/?#]+)([^?#]*)(\?[^#]*)?(#.*)?$/i);
  if (!match) return null;
  const [, origin, rawPath = "/", query = "", hash = ""] = match;
  const nextPath = rawPath.slice(normalizedBasePath.length) || "/";
  return `${origin}${nextPath}${query}${hash}`;
}

/**
 * Parse a panel URL into its constituent parts (source, contextId, options, stateArgs).
 * Returns null if the URL is not a valid panel URL.
 *
 * @param url - The URL to parse
 * @param externalHost - The managed host domain (e.g. "vibestudio.example.com")
 * @param basePath - Optional selected-workspace route prefix to strip before parsing the source
 */
export function parsePanelUrl(
  url: string,
  externalHost: string,
  basePath = ""
): ParsedPanelUrl | null {
  const strippedUrl = stripBasePath(url, basePath);
  if (!strippedUrl) return null;
  const parsed = parseUrlLike(strippedUrl);
  if (!parsed) return null;
  if (!isManagedHost(strippedUrl, externalHost)) return null;

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
  if (focus !== undefined && focus !== "true" && focus !== "false") return null;
  const disposition = parsed.queryParams.get("disposition");
  if (
    disposition !== undefined &&
    disposition !== "current" &&
    disposition !== "child" &&
    disposition !== "root"
  ) {
    return null;
  }
  const rawStateArgs = parsed.queryParams.get("stateArgs");
  let stateArgs: Record<string, unknown> | undefined;
  if (rawStateArgs !== undefined) {
    try {
      const decoded = JSON.parse(rawStateArgs) as unknown;
      if (!isPanelStateArgs(decoded)) return null;
      stateArgs = decoded;
    } catch {
      return null;
    }
  }

  return {
    source,
    ...(workspaceFromBasePath(basePath) !== undefined
      ? { workspace: workspaceFromBasePath(basePath) }
      : {}),
    contextId: contextId ?? undefined,
    ref: ref ?? undefined,
    ...(stateArgs !== undefined ? { stateArgs } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(focus !== undefined ? { focus: focus === "true" } : {}),
    ...(disposition !== undefined ? { disposition: disposition as PanelDisposition } : {}),
    options: {
      contextId: contextId ?? undefined,
      ref: ref ?? undefined,
      name: name ?? undefined,
      focus: focus !== undefined ? focus === "true" : undefined,
    },
  };
}
