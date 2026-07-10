// Deep-link recognition + one-time-replay guard for Vibestudio pairing links,
// shared by BOTH the native host bootstrap (`apps/mobile/index.js`) and the
// workspace app so there is exactly ONE copy of this logic (the native shell and
// the workspace bundle both import `@vibestudio/mobile-webrtc`). RN-only
// (AsyncStorage); the STRUCTURAL link grammar/validation lives in
// `@vibestudio/shared/connect` (`parseConnectLink`) and is re-exported here for
// convenience.
//
// A pairing link arrives in either carrier form — the custom scheme
// `vibestudio://connect?…` or the verified App Link `https://vibestudio.app/pair#…`
// — and both are user-triggered (scan QR, tap link), so any installed app can
// fire one. The replay guard suppresses a link that was already consumed (so a
// cold-launch `getInitialURL()` followed by an `addEventListener("url")` for the
// same URL doesn't re-run pairing), bounded by a short TTL.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { parseConnectLink, type ConnectLink } from "@vibestudio/shared/connect";

export { parseConnectLink };
export type { ConnectLink };

const CONSUMED_CONNECT_LINK_KEY = "vibestudio:connect:consumed-url";
const CONSUMED_CONNECT_LINK_TTL_MS = 10 * 60 * 1000;

interface ConsumedConnectLink {
  url: string;
  consumedAt: number;
}

/** True for either pairing-link carrier form (cheap prefix gate, not full parse). */
export function isConnectLink(rawUrl: unknown): rawUrl is string {
  return (
    typeof rawUrl === "string" &&
    (rawUrl.startsWith("vibestudio://connect") ||
      rawUrl.startsWith("https://vibestudio.app/pair"))
  );
}

/** Record that `rawUrl` was consumed so an immediate re-delivery is suppressed. */
export async function markConnectLinkConsumed(rawUrl: string, now = Date.now()): Promise<void> {
  if (!isConnectLink(rawUrl)) return;
  await AsyncStorage.setItem(
    CONSUMED_CONNECT_LINK_KEY,
    JSON.stringify({ url: rawUrl, consumedAt: now } satisfies ConsumedConnectLink)
  );
}

/**
 * True when `rawUrl` was already consumed within the replay TTL (i.e. this is a
 * duplicate delivery of a link we already acted on). A stale record is cleared.
 * Storage read/parse failures fail closed (return false) rather than throwing,
 * so a flaky store never blocks a genuine pairing attempt.
 */
export async function consumeConnectLinkReplay(rawUrl: string, now = Date.now()): Promise<boolean> {
  if (!isConnectLink(rawUrl)) return false;

  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(CONSUMED_CONNECT_LINK_KEY);
  } catch {
    return false;
  }
  const stored = parseConsumedConnectLink(raw);
  if (!stored) return false;

  const age = now - stored.consumedAt;
  const sameUrl = stored.url === rawUrl;
  const stale = age < 0 || age > CONSUMED_CONNECT_LINK_TTL_MS;
  if (stale) {
    try {
      await AsyncStorage.removeItem(CONSUMED_CONNECT_LINK_KEY);
    } catch {
      // best-effort cleanup of the stale record
    }
  }
  return sameUrl && !stale;
}

function parseConsumedConnectLink(raw: string | null): ConsumedConnectLink | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ConsumedConnectLink>;
    if (typeof parsed.url !== "string" || typeof parsed.consumedAt !== "number") return null;
    return { url: parsed.url, consumedAt: parsed.consumedAt };
  } catch {
    return null;
  }
}
