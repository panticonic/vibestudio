/**
 * Assert that a URL is safe for userland-controlled panel navigation.
 *
 * Only http: and https: are accepted. Schemes like file:, javascript:, data:,
 * chrome:, and about: are intentionally rejected.
 */
export function assertHttpUrl(url: unknown): asserts url is string {
  if (typeof url !== "string") {
    throw new Error(`Invalid URL (only http and https are allowed): ${String(url)}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL (only http and https are allowed): ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid URL (only http and https are allowed): ${url}`);
  }
}
