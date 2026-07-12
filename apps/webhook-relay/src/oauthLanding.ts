/**
 * Vibestudio callback relay — OAuth profile (dumb, ephemeral landing +
 * universal-link host). Plan §7.
 *
 * The relay is deliberately harmless here: PKCE keeps the `codeVerifier` on the
 * home server, so even on the desktop path where the relay sees the `code`, the
 * code is useless to the relay. `state` is the CSRF token — relayed VERBATIM,
 * never re-signed. Lookup is by the explicit `transactionId` carried through the
 * landing URL (NOT a state-scan).
 *
 * EXACTLY ONE path per platform, and each fails loud:
 *   - mobile  -> deep-link. The relay only HOSTS the Apple App Site Association
 *     / Android assetlinks (see build* below). When that works the OS hands the
 *     URL straight into the already-connected app, which forwards {state,code}
 *     over the WebRTC pipe — this landing HTML never runs. If we DO reach this
 *     handler for a mobile transaction the deep-link failed (app missing /
 *     association broken): we render an error and refuse to forward. We never
 *     fall back to the desktop backhaul — a silent second path is exactly what
 *     the fail-loud rule forbids.
 *   - desktop -> backhaul-forward. Push {state,code} down the owning server's
 *     persistent backhaul. If that backhaul is down, fail loud (the user
 *     retries); there is no buffering.
 */

export type OAuthPlatform = "mobile" | "desktop";

export interface OAuthRegistration {
  platform: OAuthPlatform;
  serverId: string;
  expiresAt: number;
}

export interface OAuthLandingDeps {
  /** Resolve a registered transaction (expiry-checked) by explicit id. */
  lookup: (transactionId: string) => OAuthRegistration | undefined;
  /** Single-use: drop the transaction after a desktop handoff. */
  consume: (transactionId: string) => void;
  /** Send a frame down the owning server's backhaul; false if none connected. */
  deliverToBackhaul: (serverId: string, frame: unknown) => boolean;
}

/**
 * The transactionId is carried in the path (`/oauth/callback/<transactionId>`,
 * which the App-Links / App-Site-Association `*` component matches so the OS
 * can deep-link), with `?transactionId=` accepted as a fallback for IdPs that
 * drop redirect-URI path segments.
 */
function parseTransactionId(url: URL): string | undefined {
  const prefix = "/oauth/callback/";
  if (url.pathname.startsWith(prefix)) {
    const segment = url.pathname.slice(prefix.length).split("/")[0];
    if (segment) {
      // A malformed %-escape (e.g. a lone "%") must NOT throw a URIError that
      // surfaces as a 500 — fail closed as a missing tx (clean 400).
      return safeDecodeURIComponent(segment) ?? undefined;
    }
  }
  return url.searchParams.get("transactionId") ?? undefined;
}

/** decodeURIComponent that returns null on a malformed sequence rather than
 * throwing a URIError. Mirrors the same guard in ./registry. */
function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function handleOAuthLanding(url: URL, now: number, deps: OAuthLandingDeps): Response {
  const transactionId = parseTransactionId(url);
  const code = url.searchParams.get("code") ?? undefined;
  const state = url.searchParams.get("state") ?? undefined;
  const error = url.searchParams.get("error") ?? undefined;
  const errorDescription = url.searchParams.get("error_description") ?? undefined;

  if (!transactionId) {
    return htmlError(400, "Invalid callback", "This OAuth callback is missing its transaction id.");
  }

  const registration = deps.lookup(transactionId);
  if (!registration || now > registration.expiresAt) {
    // Unknown or expired transaction — fail loud (covers replayed / stale links).
    return htmlError(
      404,
      "Unknown sign-in",
      "This sign-in link is unknown or has expired. Start the connection again from Vibestudio."
    );
  }

  if (registration.platform === "mobile") {
    // Reaching the landing HTML means the OS deep-link did not fire. Refuse to
    // forward — the mobile path is the app forwarding over the pipe, not the
    // relay backhaul. (Fail loud, no silent second path.) A non-200 so monitoring
    // sees the failed deep-link instead of a "success" hit.
    return htmlError(
      404,
      "Open the Vibestudio app",
      "This sign-in should have opened the Vibestudio app automatically. Make sure the app is installed, then start the connection again."
    );
  }

  // desktop: forward {state, code, error} verbatim down the owning server's
  // backhaul. We forward even a provider error so the server can fail the pending
  // transaction promptly rather than waiting for it to time out.
  const delivered = deps.deliverToBackhaul(registration.serverId, {
    t: "oauth-callback",
    transactionId,
    state,
    code,
    error,
  });
  if (!delivered) {
    return htmlError(
      503,
      "Server offline",
      "Could not reach your Vibestudio server to finish signing in. Make sure it is running, then start the connection again."
    );
  }
  deps.consume(transactionId);
  if (error) {
    // The provider itself rejected the sign-in (consent denied, invalid client,
    // …). Reflect reality with a non-200 that surfaces the provider's own message
    // instead of a misleading "Sign-in complete."
    return htmlError(
      400,
      "Sign-in failed",
      errorDescription
        ? `The sign-in provider reported an error: ${error} — ${errorDescription}`
        : `The sign-in provider reported an error: ${error}`
    );
  }
  return htmlPage(200, "Sign-in complete", "You can close this window and return to Vibestudio.");
}

// ---- Pair-link landing -----------------------------------------------------

/**
 * HTTPS carrier for pairing QR codes (`https://vibestudio.app/pair#...`).
 *
 * The private pairing material lives in the URL fragment, so it is never sent
 * to this Worker. The page reconstructs the native `vibestudio://connect?...`
 * URL client-side and opens the installed app. Desktop browsers show the custom
 * scheme for copy/retry; Android uses an intent URL for a better install/open
 * handoff.
 */
export function handlePairLanding(url: URL): Response {
  if (url.pathname !== "/pair")
    return htmlError(404, "Not found", "This Vibestudio page does not exist.");
  return new Response(PAIR_LANDING_HTML, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}

export function handleApexLanding(): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vibestudio</title><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:42rem;margin:4rem auto;padding:0 1rem;line-height:1.5;color:#111"><h1>Vibestudio</h1><p>This host serves Vibestudio pairing, mobile app-link verification, OAuth callbacks, and webhook relay endpoints.</p><p><a href="/healthz">Health check</a></p></body>`,
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=300",
        "x-content-type-options": "nosniff",
      },
    }
  );
}

/** Browser fallback for a canonical logical panel-location universal link. */
export function handlePanelLanding(): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open Vibestudio panel</title><style>body{font:16px system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:32px;line-height:1.45;color:#111;background:#fff}main{max-width:680px;margin:0 auto}button{min-height:40px;padding:0 14px;border:1px solid #111;border-radius:6px;background:#111;color:#fff;font-weight:600}code{overflow-wrap:anywhere}.muted{color:#555}</style><main><h1>Open Vibestudio panel</h1><p id="status">Preparing panel link.</p><p><button id="open" type="button">Open in Vibestudio</button></p><p class="muted">Panel links can contain workspace state arguments. Only open links from a source you trust.</p><p><code id="link"></code></p></main><script>(()=>{const fragment=location.hash?location.hash.slice(1):"";const status=document.getElementById("status");const link=document.getElementById("link");const open=document.getElementById("open");if(!fragment){status.textContent="This panel URL is missing its location fragment.";open.disabled=true;return}const scheme="vibestudio://panel?"+fragment;link.textContent=scheme;open.addEventListener("click",()=>{location.href=/Android/i.test(navigator.userAgent)?"intent://panel?"+fragment+"#Intent;scheme=vibestudio;package=app.vibestudio.mobile;end":scheme});status.textContent="Open this logical panel location in Vibestudio."})()</script>`,
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=300",
        "x-content-type-options": "nosniff",
      },
    }
  );
}

// ---- Universal-link host (Apple App Site Association / Android assetlinks) ---

export interface UniversalLinkConfig {
  /** `<teamId>.<bundleId>` app IDs that may claim the relay's links. */
  appleAppIds: string[];
  androidPackageName?: string;
  /** Uppercase colon-separated SHA-256 signing-cert fingerprints. */
  androidFingerprints: string[];
}

export function universalLinkConfigFromEnv(env: {
  VIBESTUDIO_APPLE_APP_ID?: string;
  VIBESTUDIO_ANDROID_PACKAGE_NAME?: string;
  VIBESTUDIO_ANDROID_SHA256_CERT_FINGERPRINTS?: string;
}): UniversalLinkConfig {
  return {
    appleAppIds: splitList(env.VIBESTUDIO_APPLE_APP_ID),
    androidPackageName: env.VIBESTUDIO_ANDROID_PACKAGE_NAME?.trim() || undefined,
    androidFingerprints: splitList(env.VIBESTUDIO_ANDROID_SHA256_CERT_FINGERPRINTS).map((f) =>
      f.toUpperCase()
    ),
  };
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Apple App Site Association. The `*` component lets the OS hand
 * `/oauth/callback/<transactionId>?code&state` straight into the app. Returns
 * null when no Apple app id is configured (the route fails loud rather than
 * serving a broken association that breaks universal links on every device).
 */
export function buildAppleAppSiteAssociation(config: UniversalLinkConfig): unknown | null {
  if (config.appleAppIds.length === 0) return null;
  return {
    applinks: {
      apps: [],
      details: [
        {
          appIDs: config.appleAppIds,
          components: [
            { "/": "/oauth/callback/*", comment: "OAuth provider callbacks" },
            { "/": "/oauth/linkback/*", comment: "OAuth account-linking callbacks" },
            { "/": "/pair", comment: "Pairing trampoline" },
            { "/": "/panel", comment: "Logical panel location" },
          ],
        },
      ],
    },
    webcredentials: { apps: config.appleAppIds },
  };
}

/** Android App Links assetlinks. Returns null when unconfigured. */
export function buildAssetlinks(config: UniversalLinkConfig): unknown | null {
  if (!config.androidPackageName || config.androidFingerprints.length === 0) return null;
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: config.androidPackageName,
        sha256_cert_fingerprints: config.androidFingerprints,
      },
    },
  ];
}

// ---- Minimal landing pages --------------------------------------------------

function htmlPage(status: number, title: string, body: string): Response {
  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(body);
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1>${safeTitle}</h1><p>${safeBody}</p></body>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    }
  );
}

function htmlError(status: number, title: string, body: string): Response {
  return htmlPage(status, title, body);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const PAIR_LANDING_HTML = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair Vibestudio</title>
<style>
body{font:16px system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:32px;line-height:1.45;color:#111;background:#fff}
main{max-width:680px;margin:0 auto}
button{display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:0 14px;border:1px solid #111;border-radius:6px;background:#111;color:#fff;text-decoration:none;font-weight:600}
button:disabled{opacity:.5}
code{overflow-wrap:anywhere}
.muted{color:#555}
</style>
<main>
  <h1>Pair Vibestudio</h1>
  <p id="status">Preparing pairing link.</p>
  <p><button id="open" type="button">Open in Vibestudio</button></p>
  <p class="muted" id="install">If Vibestudio is not installed, install the app from your organization’s distribution source, then return to this page.</p>
  <p><code id="link"></code></p>
</main>
<script>
(() => {
  const fragment = location.hash ? location.hash.slice(1) : "";
  const status = document.getElementById("status");
  const link = document.getElementById("link");
  const open = document.getElementById("open");
  if (!fragment) {
    status.textContent = "This pair URL is missing its private fragment. Scan a fresh QR from Vibestudio.";
    open.disabled = true;
    return;
  }
  const scheme = "vibestudio://connect?" + fragment;
  link.textContent = scheme;
  const isAndroid = /Android/i.test(navigator.userAgent);
  const isIos = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const openLink = () => {
    if (isAndroid) {
      location.href = "intent://connect?" + fragment + "#Intent;scheme=vibestudio;package=app.vibestudio.mobile;end";
      return;
    }
    location.href = scheme;
  };
  if (isAndroid) {
    status.textContent = "Opening Vibestudio. If it does not open, install the Android shell and retry.";
    setTimeout(openLink, 50);
  } else if (isIos) {
    status.textContent = "Tap Open in Vibestudio. If the app is not installed, install it first and then return to this page.";
  } else {
    status.textContent = "Click Open in Vibestudio if it is installed on this computer, or open this page on a paired phone.";
  }
  open.addEventListener("click", openLink);
})();
</script>`;
