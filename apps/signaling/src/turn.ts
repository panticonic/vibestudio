/**
 * Per-session TURN credential minting (Cloudflare Realtime TURN).
 *
 * Short-lived TURN credentials are minted on demand and handed to a peer when it
 * asks the room (`GET /room/:roomId/ice-servers`). The peer feeds them into its
 * `RTCPeerConnection.iceServers` so TURN-over-TLS:443 is reachable on networks
 * that only permit outbound HTTPS — the single NAT backstop (plan §2).
 */

import type { RtcIceServer } from "./protocol";

export interface TurnEnv {
  /** Cloudflare Realtime TURN key id (a public id, NOT a secret). */
  TURN_KEY_ID?: string;
  /** Cloudflare Realtime TURN API token (secret) — `wrangler secret put`. */
  TURN_KEY_API_TOKEN?: string;
  /** Credential lifetime in seconds. Defaults to 24h; must outlive a session. */
  TURN_TTL_SECONDS?: string;
  /**
   * LOCAL-DEV coturn for testing WebRTC against an Android emulator (which sits
   * behind QEMU's user-mode NAT and so cannot hold a direct pipe — see
   * `scripts/cli/mobile-smoke.mjs`). When `HOST`+`USER`+`PASS` are set,
   * `mintIceServers` returns this relay instead of Cloudflare. Env-guarded:
   * production / desktop / physical-device runs set none of these.
   */
  VIBESTUDIO_LOCAL_TURN_HOST?: string;
  VIBESTUDIO_LOCAL_TURN_PORT?: string;
  VIBESTUDIO_LOCAL_TURN_USER?: string;
  VIBESTUDIO_LOCAL_TURN_PASS?: string;
}

/** Free Cloudflare STUN — always usable, no credentials required. */
const CLOUDFLARE_STUN = "stun:stun.cloudflare.com:3478";
const TURN_API_BASE = "https://rtc.live.cloudflare.com/v1/turn/keys";
const DEFAULT_TTL_SECONDS = 86_400;

/**
 * Returns the ICE servers a peer should use this session.
 *
 * - **TURN provisioned** (both secrets set): mint short-lived credentials and
 *   return them. A mint failure THROWS — we never silently degrade to STUN-only,
 *   because that would hide a broken NAT backstop (plan: "fail loud, never
 *   mask"). The caller turns the throw into a 502 so the peer fails loud.
 * - **TURN not provisioned** (dev / STUN-only deploy): return the free
 *   Cloudflare STUN server. This cannot traverse symmetric NAT and announces
 *   itself as such (`note` field) — a deploy that needs TURN MUST set secrets.
 */
export async function mintIceServers(
  env: TurnEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<{ iceServers: RtcIceServer[]; turn: boolean }> {
  // Local-dev coturn (emulator NAT testing) takes precedence — both peers fetch
  // `/ice-servers`, so returning this here reaches the answerer AND the client,
  // and `VIBESTUDIO_WEBRTC_ICE=relay` forces the pipe through it.
  if (env.VIBESTUDIO_LOCAL_TURN_HOST && env.VIBESTUDIO_LOCAL_TURN_USER && env.VIBESTUDIO_LOCAL_TURN_PASS) {
    const port = env.VIBESTUDIO_LOCAL_TURN_PORT ?? "3478";
    return {
      iceServers: [
        {
          urls: `turn:${env.VIBESTUDIO_LOCAL_TURN_HOST}:${port}?transport=udp`,
          username: env.VIBESTUDIO_LOCAL_TURN_USER,
          credential: env.VIBESTUDIO_LOCAL_TURN_PASS,
        },
      ],
      turn: true,
    };
  }

  const keyId = env.TURN_KEY_ID;
  const token = env.TURN_KEY_API_TOKEN;
  if (!keyId || !token) {
    return { iceServers: [{ urls: CLOUDFLARE_STUN }], turn: false };
  }

  const ttl = Number(env.TURN_TTL_SECONDS ?? DEFAULT_TTL_SECONDS);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error(`Invalid TURN_TTL_SECONDS: ${env.TURN_TTL_SECONDS}`);
  }

  const res = await fetchImpl(
    `${TURN_API_BASE}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ttl }),
    },
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Cloudflare TURN credential mint failed: ${res.status} ${res.statusText} ${detail}`.trim(),
    );
  }

  // Cloudflare returns { iceServers: [...] }. Keep accepting a single object for
  // compatibility with older/internal test doubles, but do not guess on absence.
  const data = (await res.json()) as { iceServers?: RtcIceServer | RtcIceServer[] };
  const minted = data.iceServers;
  if (!minted) {
    throw new Error("Cloudflare TURN response missing `iceServers`");
  }
  const iceServers = Array.isArray(minted) ? minted : [minted];
  for (const server of iceServers) {
    if (!server || server.urls === undefined) {
      throw new Error("Cloudflare TURN response server missing `urls`");
    }
  }
  return { iceServers, turn: true };
}
