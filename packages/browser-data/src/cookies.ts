export interface BrowserCookiePartitionKey {
  topLevelSite: string;
  hasCrossSiteAncestor: boolean;
}

export function normalizeBrowserCookiePartitionKey(
  key: BrowserCookiePartitionKey
): BrowserCookiePartitionKey {
  const url = new URL(key.topLevelSite);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Cookie partition top-level site must use HTTP(S)");
  }
  return {
    topLevelSite: url.origin,
    hasCrossSiteAncestor: key.hasCrossSiteAncestor,
  };
}

/** Stable SQLite/key-map representation for a structured Chromium partition key. */
export function browserCookiePartitionStorageKey(
  key: BrowserCookiePartitionKey | undefined
): string {
  if (!key) return "";
  const normalized = normalizeBrowserCookiePartitionKey(key);
  return JSON.stringify([normalized.topLevelSite, normalized.hasCrossSiteAncestor ? 1 : 0]);
}

export function browserCookiePartitionFromStorageKey(
  value: string | null | undefined
): BrowserCookiePartitionKey | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    (parsed[1] !== 0 && parsed[1] !== 1)
  ) {
    throw new Error("Stored cookie partition key is invalid");
  }
  return normalizeBrowserCookiePartitionKey({
    topLevelSite: parsed[0],
    hasCrossSiteAncestor: parsed[1] === 1,
  });
}

/**
 * Normalize persisted browser-cookie expiry to Unix seconds, the unit used by
 * Electron's cookie API.
 *
 * Browser profile stores in the wild use seconds, milliseconds, and (for some
 * compatible stores) microseconds. Their contemporary timestamp magnitudes do
 * not overlap.
 */
export function normalizeCookieExpirationSeconds(
  value: number | null | undefined
): number | undefined {
  if (value == null || value === 0) return undefined;
  if (value >= 100_000_000_000_000) return value / 1_000_000;
  if (value >= 100_000_000_000) return value / 1_000;
  return value;
}
