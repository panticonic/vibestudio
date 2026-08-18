import { normalizeBrowserCookiePartitionKey, normalizeCookieExpirationSeconds } from "./cookies.js";
import type { BrowserCookieInput } from "./environment.js";

export type ChromiumCookieSameSite = "Strict" | "Lax" | "None";
export type ChromiumCookieSourceScheme = "Unset" | "NonSecure" | "Secure";

export interface ChromiumCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: ChromiumCookieSameSite;
  sourceScheme?: ChromiumCookieSourceScheme;
  sourcePort?: number;
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean };
  partitionKeyOpaque?: boolean;
}

export interface ChromiumCookieParam {
  name: string;
  value: string;
  url: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: ChromiumCookieSameSite;
  expires?: number;
  sourceScheme?: ChromiumCookieSourceScheme;
  sourcePort?: number;
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean };
}

/** Convert Chromium's wire cookie to the canonical browser-vault shape. */
export function browserCookieFromChromium(cookie: ChromiumCookie): BrowserCookieInput {
  const expirationDate = normalizeCookieExpirationSeconds(
    cookie.session || cookie.expires < 0 ? undefined : cookie.expires
  );
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain.toLocaleLowerCase(),
    hostOnly: !cookie.domain.startsWith("."),
    path: cookie.path || "/",
    ...(cookie.partitionKey
      ? { partitionKey: normalizeBrowserCookiePartitionKey(cookie.partitionKey) }
      : {}),
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: sameSiteFromChromium(cookie.sameSite),
    ...(expirationDate === undefined ? {} : { expirationDate }),
    sourceScheme: sourceSchemeFromChromium(cookie.sourceScheme, cookie.secure),
    sourcePort: cookie.sourcePort ?? (cookie.secure ? 443 : 80),
  };
}

/** Convert a canonical browser-vault cookie to Chromium's wire shape. */
export function browserCookieToChromium(cookie: BrowserCookieInput): ChromiumCookieParam {
  const expirationDate = normalizeCookieExpirationSeconds(cookie.expirationDate);
  const sameSite = sameSiteToChromium(cookie.sameSite);
  return {
    url: `${cookie.secure ? "https" : "http"}://${cookie.domain.replace(/^\./, "")}${cookie.path || "/"}`,
    name: cookie.name,
    value: cookie.value,
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    path: cookie.path || "/",
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(sameSite ? { sameSite } : {}),
    ...(expirationDate === undefined ? {} : { expires: expirationDate }),
    ...(cookie.sourceScheme ? { sourceScheme: sourceSchemeToChromium(cookie.sourceScheme) } : {}),
    ...(cookie.sourcePort === undefined ? {} : { sourcePort: cookie.sourcePort }),
    ...(cookie.partitionKey
      ? { partitionKey: normalizeBrowserCookiePartitionKey(cookie.partitionKey) }
      : {}),
  };
}

function sameSiteFromChromium(
  value: ChromiumCookieSameSite | undefined
): BrowserCookieInput["sameSite"] {
  if (value === "Strict") return "strict";
  if (value === "Lax") return "lax";
  if (value === "None") return "no_restriction";
  return "unspecified";
}

function sameSiteToChromium(
  value: BrowserCookieInput["sameSite"]
): ChromiumCookieSameSite | undefined {
  if (value === "strict") return "Strict";
  if (value === "lax") return "Lax";
  if (value === "no_restriction") return "None";
  return undefined;
}

function sourceSchemeFromChromium(
  value: ChromiumCookieSourceScheme | undefined,
  secure: boolean
): string {
  if (value === "Secure") return "secure";
  if (value === "NonSecure") return "non_secure";
  if (value === "Unset") return "unset";
  return secure ? "secure" : "non_secure";
}

function sourceSchemeToChromium(value: string): ChromiumCookieSourceScheme {
  if (value === "secure") return "Secure";
  if (value === "non_secure") return "NonSecure";
  return "Unset";
}
