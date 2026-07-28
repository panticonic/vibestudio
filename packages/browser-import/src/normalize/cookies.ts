import type { ImportedCookie, SameSiteValue, SourceScheme } from "../types.js";
import type { BrowserCookiePartitionKey } from "@vibestudio/browser-data";
import {
  normalizeBrowserCookiePartitionKey,
  normalizeCookieExpirationSeconds,
} from "@vibestudio/browser-data";

export type ImportedCookieIsolation =
  | { partitionKey: BrowserCookiePartitionKey }
  | { unsupportedIsolation: "container" | "private" | "opaque" }
  | Record<string, never>;

export function chromiumCookieIsolation(
  topFrameSiteKey: string,
  hasCrossSiteAncestor: boolean
): ImportedCookieIsolation {
  if (!topFrameSiteKey) return {};
  try {
    return {
      partitionKey: normalizeBrowserCookiePartitionKey({
        topLevelSite: topFrameSiteKey,
        hasCrossSiteAncestor,
      }),
    };
  } catch {
    return { unsupportedIsolation: "opaque" };
  }
}

/**
 * Convert Firefox's serialized OriginAttributes partition key
 * `(<scheme>,<baseDomain>,[port],[ancestorBit])` to Chromium's structured key.
 * Container and private contexts are deliberately distinct: they require
 * separate browser environments rather than CHIPS cookie partitions.
 */
export function firefoxCookieIsolation(
  originAttributes: string,
  cookieDomain: string
): ImportedCookieIsolation {
  if (!originAttributes) return {};
  const attributes = new URLSearchParams(
    originAttributes.startsWith("^") ? originAttributes.slice(1) : originAttributes
  );
  if (Number(attributes.get("privateBrowsingId") ?? "0") !== 0) {
    return { unsupportedIsolation: "private" };
  }
  if (
    Number(attributes.get("userContextId") ?? "0") !== 0 ||
    attributes.has("geckoViewSessionContextId")
  ) {
    return { unsupportedIsolation: "container" };
  }
  const partitionKey = attributes.get("partitionKey");
  const remaining = [...attributes.keys()].filter((key) => key !== "partitionKey");
  if (!partitionKey || remaining.length > 0) {
    return { unsupportedIsolation: "opaque" };
  }

  const match = partitionKey.match(/^\(([^,]+),([^,]+)(?:,([^,]*))?(?:,([01]))?\)$/);
  if (!match) return { unsupportedIsolation: "opaque" };
  const [, scheme, baseDomain, portText, ancestorBit] = match;
  if (!scheme || !baseDomain) return { unsupportedIsolation: "opaque" };
  const port =
    portText && Number.isInteger(Number(portText)) && Number(portText) > 0
      ? `:${Number(portText)}`
      : "";
  try {
    return {
      partitionKey: normalizeBrowserCookiePartitionKey({
        topLevelSite: `${scheme}://${baseDomain}${port}`,
        hasCrossSiteAncestor:
          ancestorBit === undefined
            ? cookieDomain.replace(/^\./, "").toLocaleLowerCase() !== baseDomain.toLocaleLowerCase()
            : ancestorBit === "1",
      }),
    };
  } catch {
    return { unsupportedIsolation: "opaque" };
  }
}

/**
 * Map Chromium sameSite integer to our string enum.
 * Chromium uses: -1=unspecified, 0=no_restriction, 1=lax, 2=strict
 */
export function chromiumSameSite(value: number): SameSiteValue {
  switch (value) {
    case 0:
      return "no_restriction";
    case 1:
      return "lax";
    case 2:
      return "strict";
    default:
      return "unspecified";
  }
}

/**
 * Map Chromium source_scheme integer to our string enum.
 * Chromium uses: 0=unset, 1=non_secure, 2=secure
 */
export function chromiumSourceScheme(value: number): SourceScheme {
  switch (value) {
    case 1:
      return "non_secure";
    case 2:
      return "secure";
    default:
      return "unset";
  }
}

/**
 * Derive a URL from cookie domain, path, and secure flag.
 * This is needed for Electron's cookies.set() API which requires a `url` field.
 */
export function deriveCookieUrl(cookie: ImportedCookie): string {
  const scheme = cookie.secure ? "https" : "http";
  const host = cookie.domain.replace(/^\./, "");
  return `${scheme}://${host}${cookie.path}`;
}

/**
 * Normalize Unix cookie expiry to the seconds expected by Electron.
 *
 * Firefox profiles exist in the wild with both seconds and milliseconds, and
 * some compatible stores use microseconds. Magnitude is unambiguous for
 * contemporary Unix timestamps, so normalize all three without coupling the
 * reader to a particular Firefox release.
 * Returns Unix seconds, or undefined for session cookies.
 */
export function normalizeCookieExpiry(
  value: number | null | undefined,
  isSession: boolean
): number | undefined {
  return isSession ? undefined : normalizeCookieExpirationSeconds(value);
}

/**
 * Determine if a cookie is host-only based on its domain.
 * A domain cookie has a leading dot; a host-only cookie does not.
 */
export function isHostOnlyCookie(domain: string): boolean {
  return !domain.startsWith(".");
}
