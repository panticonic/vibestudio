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
 *     over the Iroh pipe — this landing HTML never runs. If we DO reach this
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
 * HTTPS carrier for pairing QR codes (`https://vibestudio.app/p#...`).
 *
 * The private pairing material lives in the URL fragment, so it is never sent
 * to this Worker. The page reconstructs the native `vibestudio://connect/...`
 * URL client-side and opens the installed app. Desktop browsers show the custom
 * compact path for copy/retry; Android uses an intent URL for a better install/open
 * handoff.
 */
export function handlePairLanding(url: URL): Response {
  if (url.pathname !== "/p")
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
    APEX_LANDING_HTML,
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=300",
        "x-content-type-options": "nosniff",
        "referrer-policy": "strict-origin-when-cross-origin",
      },
    }
  );
}

const APEX_LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#171321">
  <meta name="description" content="Vibestudio brings your apps, agents, and workspace together on your own computer or server. Download the alpha and get started.">
  <title>Vibestudio — a workspace for apps and agents</title>
  <style>
    :root{color-scheme:dark;--bg:#171321;--panel:#201a2d;--panel2:#261d36;--ink:#f8f5fc;--muted:#beb6cb;--line:#41364f;--violet:#b999ff;--pink:#f18abd;--green:#9ce2c1;--sans:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background-color:#171321;color:#f8f5fc;background:radial-gradient(ellipse at 77% 3%,rgba(132,67,190,.2),transparent 32rem),var(--bg);color:var(--ink);font:16px/1.65 var(--sans);-webkit-font-smoothing:antialiased}a{color:inherit}a:focus-visible,summary:focus-visible{outline:2px solid var(--pink);outline-offset:4px;border-radius:4px}.wrap{width:min(1120px,calc(100% - 48px));margin-inline:auto}.topbar{height:82px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,.09)}.brand{display:flex;gap:11px;align-items:center;text-decoration:none;font-weight:750;letter-spacing:-.035em;font-size:19px}.mark{width:30px;height:30px;display:block;flex:none}.mark img{display:block;width:100%;height:100%}.nav{display:flex;align-items:center;gap:28px;color:var(--muted);font-size:14px}.nav a{text-decoration:none}.nav a:hover{color:var(--ink)}.nav .nav-cta{color:var(--ink);border:1px solid #69548b;padding:8px 14px;border-radius:8px}.hero{padding:91px 0 78px;max-width:890px}.eyebrow{display:flex;align-items:center;gap:10px;color:#d3bfff;text-transform:uppercase;letter-spacing:.13em;font-size:12px;font-weight:700}.eyebrow:before{content:"";width:24px;height:1px;background:linear-gradient(90deg,var(--violet),var(--pink))}h1{font-size:clamp(46px,7vw,78px);line-height:1.02;letter-spacing:-.065em;font-weight:680;max-width:850px;margin:20px 0 22px}h1 span{color:#d9c1ff}@supports ((-webkit-background-clip:text) or (background-clip:text)){h1 span{background:linear-gradient(95deg,#b99aff 5%,#e6a4e8 57%,#f394bd);-webkit-background-clip:text;background-clip:text;color:transparent}}.lede{font-size:19px;color:#d0cad8;max-width:680px;line-height:1.6;margin:0}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:31px}.button{min-height:48px;display:inline-flex;align-items:center;justify-content:center;gap:10px;padding:0 19px;border-radius:9px;text-decoration:none;font-size:14px;font-weight:700;transition:transform .18s ease,border-color .18s ease}.button:hover{transform:translateY(-2px)}.primary{background:linear-gradient(100deg,#874df1,#c154d5);color:#fff;box-shadow:0 8px 24px #854de843}.secondary{border:1px solid #554967;background:#211a2d;color:#f3edf9}.button svg{width:16px;height:16px}.micro{margin-top:14px;color:#aaa1b8;font-size:13px}.micro a{color:#d1c6e3}.workspace-connect{display:grid;grid-template-columns:1fr auto;align-items:center;gap:20px;width:min(100%,660px);margin-top:30px;padding:17px 20px;border:1px solid #514365;border-radius:12px;background:#201a2d}.workspace-connect h2{font-size:15px;line-height:1.35;margin:0 0 2px;letter-spacing:-.015em}.workspace-connect p{margin:0;color:var(--muted);font-size:14px;line-height:1.5}.workspace-connect button{min-height:42px;padding:0 14px;border:1px solid #9b7bd1;border-radius:8px;background:#e7dcff;color:#291c3c;font:650 14px var(--sans);cursor:pointer}.workspace-connect button:disabled{opacity:.68;cursor:wait}.workspace-connect button:focus-visible{outline:2px solid var(--pink);outline-offset:3px}.intro{border-top:1px solid var(--line);padding:27px 0 66px;display:grid;grid-template-columns:1.1fr 1fr 1fr;gap:32px}.intro article{padding-top:14px}.intro .intro-lead{grid-row:span 2;padding:22px 30px 22px 0;border-right:1px solid var(--line)}.kicker{color:var(--violet);font:12px/1.4 var(--mono);letter-spacing:.08em;text-transform:uppercase}.intro h2{font-size:23px;line-height:1.25;letter-spacing:-.035em;margin:9px 0}.intro h3{font-size:16px;line-height:1.3;letter-spacing:-.015em;margin:7px 0}.intro p{color:var(--muted);font-size:15px;line-height:1.65;margin:0}.section{padding:76px 0;border-top:1px solid var(--line)}.section-head{display:flex;align-items:end;justify-content:space-between;gap:32px;margin-bottom:30px}.section-head h2{font-size:clamp(30px,4vw,43px);letter-spacing:-.05em;line-height:1.1;margin:9px 0 0}.section-head p{color:var(--muted);max-width:400px;margin:0}.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:13px}.step{padding:24px;border-radius:12px;background:linear-gradient(145deg,#251f32,#1d1928);border:1px solid #3f354c;min-height:220px}.step-num{font:12px var(--mono);color:#d79fe7}.step h3{font-size:19px;letter-spacing:-.03em;margin:17px 0 7px}.step p{font-size:15px;color:var(--muted);margin:0}.step a,.text-link{color:#dbc4ff;text-decoration-thickness:1px;text-underline-offset:3px}.install{padding:0 0 76px}.install-box{border:1px solid #4e3e64;border-radius:16px;background:linear-gradient(125deg,#241b31,#201a2b 56%,#2c1c37);padding:34px;display:grid;grid-template-columns:1fr .88fr;gap:50px;align-items:center}.install-box h2{font-size:32px;letter-spacing:-.045em;line-height:1.15;margin:8px 0 12px}.install-box p{color:var(--muted);margin:0 0 20px}.install-links{display:flex;gap:12px;flex-wrap:wrap}.platforms{border-left:1px solid #4a3b57;padding-left:30px}.platforms h3{font-size:15px;margin:0 0 12px}.platforms ul{list-style:none;padding:0;margin:0;display:grid;gap:10px}.platforms li{display:grid;grid-template-columns:96px 1fr;gap:12px;color:var(--muted);font-size:14px}.platforms b{color:#f3edf9;font-weight:600}.fine{color:#a9a0b3!important;font-size:13px;margin:18px 0 0!important}.callout{border-left:2px solid #9f78ef;padding:2px 0 2px 17px;color:#d0c7d9;font-size:14px}.callout a{color:#dbc4ff}.end{display:grid;grid-template-columns:1fr 1fr;gap:40px}.end h2{font-size:26px;letter-spacing:-.04em;margin:7px 0 10px}.end p{color:var(--muted);margin:0;font-size:15px}.end-card{border-top:1px solid var(--line);padding-top:20px}footer{padding:23px 0 36px;border-top:1px solid var(--line);margin-top:78px;color:#a9a0b3;font-size:13px;display:flex;justify-content:space-between;gap:20px}footer a{color:#d1c6e3;text-decoration:none}.footer-links{display:flex;gap:19px}@media(max-width:720px){.wrap{width:min(100% - 36px,560px)}.topbar{height:70px}.nav{gap:13px}.nav a:not(.nav-cta){display:none}.hero{padding:72px 0 58px}.lede{font-size:17px}.intro{grid-template-columns:1fr 1fr;gap:20px}.intro .intro-lead{grid-column:1/-1;grid-row:auto;border-right:0;border-bottom:1px solid var(--line);padding:0 0 21px}.section{padding:59px 0}.section-head{align-items:start;display:block}.section-head p{margin-top:14px}.steps{grid-template-columns:1fr}.step{min-height:0}.install{padding-bottom:58px}.install-box{padding:25px;grid-template-columns:1fr;gap:25px}.platforms{border-left:0;border-top:1px solid #4a3b57;padding:20px 0 0}.end{grid-template-columns:1fr;gap:26px}footer{margin-top:58px;display:block}.footer-links{margin-top:14px}.workspace-connect{grid-template-columns:1fr;gap:13px}.workspace-connect button{justify-self:start}}@media(max-width:390px){.intro{grid-template-columns:1fr}.intro article{padding-top:4px}.nav .nav-cta{padding:7px 10px;font-size:13px}.hero{padding-top:57px}h1{font-size:43px}}
    .platforms code{display:inline-block;max-width:100%;padding:2px 5px;border-radius:4px;background:#171321;color:#e2cfff;font:12px/1.55 var(--mono);overflow-wrap:anywhere}
  </style>
</head>
<body>
  <header class="wrap topbar">
    <a class="brand" href="#top" aria-label="Vibestudio home"><span class="mark" aria-hidden="true"><img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDI0IDEwMjQiPgogIDxkZWZzPgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJzeW1ib2wtZ3JhZGllbnQiIHgxPSIyMiUiIHkxPSIyNyUiIHgyPSI3MSUiIHkyPSI4OCUiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiM2NzI4RUQiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIwLjIiIHN0b3AtY29sb3I9IiM3OTI4RjQiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIwLjQiIHN0b3AtY29sb3I9IiM5MjI4RjQiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIwLjYyIiBzdG9wLWNvbG9yPSIjQUQyN0UyIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iMC43OCIgc3RvcC1jb2xvcj0iI0NFMjdCRiIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiNFMjI4OTgiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9IndvcmRtYXJrLWdyYWRpZW50IiB4MT0iMyUiIHkxPSIwIiB4Mj0iMTAwJSIgeTI9IjIlIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjNjAyM0VDIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iMC4yNSIgc3RvcC1jb2xvcj0iIzhEMjJENCIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjAuNSIgc3RvcC1jb2xvcj0iI0I0MjFCOCIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjAuNzUiIHN0b3AtY29sb3I9IiNEMzIzOTIiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjRTkyNDdBIi8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogIDwvZGVmcz4KICA8cGF0aCBmaWxsPSJ1cmwoI3N5bWJvbC1ncmFkaWVudCkiIGZpbGwtcnVsZT0iZXZlbm9kZCIgZD0iTTgzOC41IDM5NlE4MzEgMzg2IDgxMyAzNjcuNVE3OTUgMzQ5IDc4MC41IDMzNy41UTc2NiAzMjYgNzQ2LjUgMzE0LjVRNzI3IDMwMyA3MTkgMjk5LjVRNzExIDI5NiA3MDkuNSAyOTZRNzA4IDI5NiA3MDYgMjk0LjVRNzA0IDI5MyA2OTggMjkxLjVRNjkyIDI5MCA2OTEgMjg5UTY5MCAyODggNjc0IDI4NFE2NTggMjgwIDY1Ni41IDI3OVE2NTUgMjc4IDYzMi41IDI3NVE2MTAgMjcyIDU5MC41IDI3Mi41UTU3MSAyNzMgNTcwIDI3NFE1NjkgMjc1IDU2My41IDI3NlE1NTggMjc3IDU0OC41IDI4Mi41UTUzOSAyODggNTM1IDI5MS41UTUzMSAyOTUgNTI1IDMwMi41UTUxOSAzMTAgNTE2IDMxOFE1MTMgMzI2IDUxMy41IDMzOS41UTUxNCAzNTMgNTE2LjUgMzU4UTUxOSAzNjMgNTIzLjUgMzY5UTUyOCAzNzUgNTM1IDM3OS41UTU0MiAzODQgNTQ5IDM4Ni41UTU1NiAzODkgNTg4LjUgMzg5LjVRNjIxIDM5MCA2MjguNSAzOTFRNjM2IDM5MiA2MzcgMzkzUTYzOCAzOTQgNjQ0LjUgMzk1UTY1MSAzOTYgNjU1IDM5OFE2NTkgNDAwIDY2My41IDQwMVE2NjggNDAyIDY3MSA0MDRRNjc0IDQwNiA2ODAuNSA0MDguNVE2ODcgNDExIDY5NiA0MTYuNVE3MDUgNDIyIDcwOS41IDQyNlE3MTQgNDMwIDcxNSA0MzBRNzE2IDQzMCA3MzAgNDQzLjVRNzQ0IDQ1NyA3NTMgNDY5LjVRNzYyIDQ4MiA3NjcuNSA0OTIuNVE3NzMgNTAzIDc3OCA1MTVRNzgzIDUyNyA3ODcuNSA1NDUuNVE3OTIgNTY0IDc5MyA1NzNRNzk0IDU4MiA3OTQgNjA1UTc5NCA2MjggNzkzIDYzNy41UTc5MiA2NDcgNzkxIDY0OC41UTc5MCA2NTAgNzg4LjUgNjYwUTc4NyA2NzAgNzg2IDY3MVE3ODUgNjcyIDc4NCA2NzcuNVE3ODMgNjgzIDc3Ny41IDY5Ny41UTc3MiA3MTIgNzY1LjUgNzIzUTc1OSA3MzQgNzU4LjUgNzM2UTc1OCA3MzggNzQ3IDc1Mi41UTczNiA3NjcgNzI2IDc3Ny41UTcxNiA3ODggNjk2LjUgODAyLjVRNjc3IDgxNyA2NjAgODI1LjVRNjQzIDgzNCA2NDAgODM0LjVRNjM3IDgzNSA2MzUgODM2LjVRNjMzIDgzOCA2MjUgODQxUTYxNyA4NDQgNjE1IDg0NFE2MTMgODQ0IDYwOC41IDg0NlE2MDQgODQ4IDU5NyA4NDlRNTkwIDg1MCA1ODcgODUxLjVRNTg0IDg1MyA1NzUgODU0UTU2NiA4NTUgNTYxLjUgODU2LjVRNTU3IDg1OCA1MzUgODU5LjVRNTEzIDg2MSA0OTYuNSA4NjFRNDgwIDg2MSA0NTIgODU5UTQyNCA4NTcgNDIyLjUgODU2UTQyMSA4NTUgNDA3IDg1My41UTM5MyA4NTIgMzkyIDg1MVEzOTEgODUwIDM4MyA4NDlRMzc1IDg0OCAzNzEuNSA4NDYuNVEzNjggODQ1IDM1OS41IDg0My41UTM1MSA4NDIgMzQ4IDg0MC41UTM0NSA4MzkgMzM5IDgzOFEzMzMgODM3IDMzMiA4MzZRMzMxIDgzNSAzMjkgODM1UTMyNyA4MzUgMzE2IDgzMS41UTMwNSA4MjggMzAzIDgyNi41UTMwMSA4MjUgMjkwLjUgODIxLjVRMjgwIDgxOCAyNjQuNSA4MTBRMjQ5IDgwMiAyNDcuNSA4MDAuNVEyNDYgNzk5IDI0MiA3OThRMjM4IDc5NyAyMzcgNzk2UTIzNiA3OTUgMjI1IDc5NVEyMTQgNzk1IDIwNyA3OTcuNVEyMDAgODAwIDE5Ni41IDgwMi41UTE5MyA4MDUgMTg2LjUgODExLjVRMTgwIDgxOCAxNzYgODI1UTE3MiA4MzIgMTcwLjUgODM4UTE2OSA4NDQgMTY5IDg1MVExNjkgODU4IDE3MC41IDg2NFExNzIgODcwIDE3NS41IDg3NlExNzkgODgyIDE4NS41IDg4OC41UTE5MiA4OTUgMTk2LjUgODk4UTIwMSA5MDEgMjE2IDkwOC41UTIzMSA5MTYgMjU0LjUgOTI1UTI3OCA5MzQgMjc5IDkzNVEyODAgOTM2IDI4NSA5MzdRMjkwIDkzOCAyOTIuNSA5MzkuNVEyOTUgOTQxIDMwMS41IDk0Mi41UTMwOCA5NDQgMzA5IDk0NVEzMTAgOTQ2IDMyNyA5NTBRMzQ0IDk1NCAzNDUgOTU1UTM0NiA5NTYgMzUzLjUgOTU3UTM2MSA5NTggMzY3IDk2MFEzNzMgOTYyIDM4Mi41IDk2M1EzOTIgOTY0IDM5My41IDk2NVEzOTUgOTY2IDQxMSA5NjcuNVE0MjcgOTY5IDQyOC41IDk3MFE0MzAgOTcxIDQ0NyA5NzJRNDY0IDk3MyA0OTEgOTczUTUxOCA5NzMgNTMzIDk3MlE1NDggOTcxIDU1MCA5NzBRNTUyIDk2OSA1NjggOTY3LjVRNTg0IDk2NiA1ODUuNSA5NjVRNTg3IDk2NCA1OTggOTYyLjVRNjA5IDk2MSA2MTAgOTYwUTYxMSA5NTkgNjE5LjUgOTU3LjVRNjI4IDk1NiA2MjkgOTU1UTYzMCA5NTQgNjM3LjUgOTUyLjVRNjQ1IDk1MSA2NDYgOTUwUTY0NyA5NDkgNjYwIDk0NVE2NzMgOTQxIDY3NSA5MzkuNVE2NzcgOTM4IDY4NCA5MzUuNVE2OTEgOTMzIDcxMS41IDkyMlE3MzIgOTExIDc0OSA4OTlRNzY2IDg4NyA3NzQgODgwUTc4MiA4NzMgNzk3IDg1Ny41UTgxMiA4NDIgODIyLjUgODI4LjVRODMzIDgxNSA4NDIuNSA4MDAuNVE4NTIgNzg2IDg1OS41IDc3MS41UTg2NyA3NTcgODc0IDc0MFE4ODEgNzIzIDg4Mi41IDcxNi41UTg4NCA3MTAgODg1IDcwOVE4ODYgNzA4IDg4Ny41IDcwMVE4ODkgNjk0IDg5MCA2OTIuNVE4OTEgNjkxIDg5MiA2ODQuNVE4OTMgNjc4IDg5NSA2NzJRODk3IDY2NiA4OTggNjU3UTg5OSA2NDggOTAwIDY0NlE5MDEgNjQ0IDkwMi41IDYyNlE5MDQgNjA4IDkwMy41IDU4Ny41UTkwMyA1NjcgOTAyIDU1OFE5MDEgNTQ5IDkwMCA1NDdRODk5IDU0NSA4OTguNSA1MzkuNVE4OTggNTM0IDg5NC41IDUxOVE4OTEgNTA0IDg4My41IDQ4Mi41UTg3NiA0NjEgODY5LjUgNDQ3LjVRODYzIDQzNCA4NTQuNSA0MjBRODQ2IDQwNiA4MzguNSAzOTZaTTcwOS41IDYzLjVRNzAyIDU3IDY5Mi41IDU0UTY4MyA1MSA2MzUuNSA1MVE1ODggNTEgNTgyIDUxLjVRNTc2IDUyIDU3NC41IDUzUTU3MyA1NCA1NTcgNTUuNVE1NDEgNTcgNTQwIDU4UTUzOSA1OSA1MzEuNSA2MFE1MjQgNjEgNTIxIDYyLjVRNTE4IDY0IDUxMC41IDY1LjVRNTAzIDY3IDQ4OSA3MlE0NzUgNzcgNDU1LjUgODdRNDM2IDk3IDQxNiAxMTEuNVEzOTYgMTI2IDM4MSAxNDFRMzY2IDE1NiAzNTQuNSAxNzFRMzQzIDE4NiAzMzUuNSAxOTguNVEzMjggMjExIDMyNyAyMTRRMzI2IDIxNyAzMjQuNSAyMTguNVEzMjMgMjIwIDMyMi41IDIyMi41UTMyMiAyMjUgMzE5IDIzMC41UTMxNiAyMzYgMzE2IDIzNy41UTMxNiAyMzkgMzE0LjUgMjQxUTMxMyAyNDMgMzA4IDI1OFEzMDMgMjczIDMwMS41IDI4MS41UTMwMCAyOTAgMjk5IDI5MS41UTI5OCAyOTMgMjk2LjUgMzA0UTI5NSAzMTUgMjk1IDMyMS41UTI5NSAzMjggMjk0IDMzMC41UTI5MyAzMzMgMjkzIDM0Mi41UTI5MyAzNTIgMjk0IDM1NFEyOTUgMzU2IDI5Ni41IDM3My41UTI5OCAzOTEgMjk5IDM5MlEzMDAgMzkzIDMwMS41IDQwMlEzMDMgNDExIDMwNCA0MTJRMzA1IDQxMyAzMDYuNSA0MTkuNVEzMDggNDI2IDMwOSA0MjdRMzEwIDQyOCAzMTEuNSA0MzMuNVEzMTMgNDM5IDMxOCA0NTBRMzIzIDQ2MSAzMzAuNSA0NzRRMzM4IDQ4NyAzNDIgNDkxLjVRMzQ2IDQ5NiAzNDkgNTAxUTM1MiA1MDYgMzU5LjUgNTE0LjVRMzY3IDUyMyAzODEuNSA1MzdRMzk2IDU1MSA0MDcgNTU5UTQxOCA1NjcgNDE5IDU2N1E0MjAgNTY3IDQzMSA1NzRRNDQyIDU4MSA0NTcuNSA1ODhRNDczIDU5NSA0NzkuNSA1OTYuNVE0ODYgNTk4IDQ4NyA1OTlRNDg4IDYwMCA0OTYgNjAxLjVRNTA0IDYwMyA1MDUuNSA2MDRRNTA3IDYwNSA1MTggNjA2LjVRNTI5IDYwOCA1MzAuNSA2MDlRNTMyIDYxMCA1NTIgNjEwLjVRNTcyIDYxMSA1NzQgNjEyUTU3NiA2MTMgNTc3LjUgNjE1UTU3OSA2MTcgNTc4LjUgNjIzUTU3OCA2MjkgNTcxIDYzMi41UTU2NCA2MzYgNTU0LjUgNjM3LjVRNTQ1IDYzOSA1NDQgNjQwUTU0MyA2NDEgNTMxLjUgNjQyLjVRNTIwIDY0NCA1MTguNSA2NDVRNTE3IDY0NiA1MDkgNjQ3UTUwMSA2NDggNDg4LjUgNjQ4LjVRNDc2IDY0OSA0NTEgNjQ3LjVRNDI2IDY0NiA0MjQuNSA2NDVRNDIzIDY0NCA0MTIuNSA2NDIuNVE0MDIgNjQxIDQwMSA2NDBRNDAwIDYzOSAzOTMgNjM4UTM4NiA2MzcgMzgzIDYzNS41UTM4MCA2MzQgMzc0LjUgNjMzUTM2OSA2MzIgMzY3IDYzMC41UTM2NSA2MjkgMzU5IDYyNy41UTM1MyA2MjYgMzUxIDYyNC41UTM0OSA2MjMgMzQwIDYxOS41UTMzMSA2MTYgMzEwLjUgNjA0UTI5MCA1OTIgMjc5IDU4My41UTI2OCA1NzUgMjU0IDU2MVEyNDAgNTQ3IDIzMS41IDUzNlEyMjMgNTI1IDIxOS41IDUxOVEyMTYgNTEzIDIxMSA1MDhRMjA2IDUwMyAxOTkuNSA0OTkuNVExOTMgNDk2IDE4NyA0OTQuNVExODEgNDkzIDE3Ni41IDQ5M1ExNzIgNDkzIDE2NCA0OTVRMTU2IDQ5NyAxNTIgNDk5UTE0OCA1MDEgMTQwLjUgNTA3LjVRMTMzIDUxNCAxMjkuNSA1MTkuNVExMjYgNTI1IDEyMy41IDUzMlExMjEgNTM5IDEyMSA1NDkuNVExMjEgNTYwIDEyMy41IDU2N1ExMjYgNTc0IDEzMSA1ODFRMTM2IDU4OCAxMzYgNTg5UTEzNiA1OTAgMTM3LjUgNTkxUTEzOSA1OTIgMTM5LjUgNTkzLjVRMTQwIDU5NSAxNTAuNSA2MDcuNVExNjEgNjIwIDE3NCA2MzNRMTg3IDY0NiAxODggNjQ2UTE4OSA2NDYgMjAwLjUgNjU2UTIxMiA2NjYgMjIwIDY3MS41UTIyOCA2NzcgMjI5IDY3N1EyMzAgNjc3IDIzNSA2ODFRMjQwIDY4NSAyNDMgNjg2UTI0NiA2ODcgMjQ5IDY4OS41UTI1MiA2OTIgMjYyIDY5N1EyNzIgNzAyIDI3My41IDcwMy41UTI3NSA3MDUgMjc3LjUgNzA1LjVRMjgwIDcwNiAyODggNzEwLjVRMjk2IDcxNSAzMDEuNSA3MTYuNVEzMDcgNzE4IDMxMCA3MjBRMzEzIDcyMiAzMTYgNzIyLjVRMzE5IDcyMyAzMjYuNSA3MjYuNVEzMzQgNzMwIDM0MSA3MzEuNVEzNDggNzMzIDM1MC41IDczNC41UTM1MyA3MzYgMzU5IDczN1EzNjUgNzM4IDM2OCA3MzkuNVEzNzEgNzQxIDM3OCA3NDJRMzg1IDc0MyAzODguNSA3NDQuNVEzOTIgNzQ2IDM5OC41IDc0Ni41UTQwNSA3NDcgNDEzIDc0OVE0MjEgNzUxIDQzNy41IDc1MlE0NTQgNzUzIDQ1Ni41IDc1NFE0NTkgNzU1IDQ4MSA3NTVRNTAzIDc1NSA1MDUgNzU0UTUwNyA3NTMgNTIyIDc1MlE1MzcgNzUxIDU0NC41IDc0OVE1NTIgNzQ3IDU2MCA3NDZRNTY4IDc0NSA1NjkuNSA3NDRRNTcxIDc0MyA1ODUuNSA3MzlRNjAwIDczNSA2MTEgNzMwUTYyMiA3MjUgNjI3IDcyMVE2MzIgNzE3IDYzNC41IDcxNlE2MzcgNzE1IDY0NyA3MDUuNVE2NTcgNjk2IDY2My41IDY4Ni41UTY3MCA2NzcgNjczIDY3MVE2NzYgNjY1IDY3NyA2NjFRNjc4IDY1NyA2NzkuNSA2NTQuNVE2ODEgNjUyIDY4My41IDY0MVE2ODYgNjMwIDY4NS41IDYxM1E2ODUgNTk2IDY4MC41IDU4Mi41UTY3NiA1NjkgNjcxIDU2MC41UTY2NiA1NTIgNjYyLjUgNTQ3LjVRNjU5IDU0MyA2NTIuNSA1MzdRNjQ2IDUzMSA2MzUgNTI0LjVRNjI0IDUxOCA2MTkgNTE3UTYxNCA1MTYgNjExIDUxNC41UTYwOCA1MTMgNTc4IDUxMC41UTU0OCA1MDggNTM0LjUgNTA1UTUyMSA1MDIgNTA2LjUgNDk2LjVRNDkyIDQ5MSA0ODAuNSA0ODMuNVE0NjkgNDc2IDQ2OCA0NzZRNDY3IDQ3NiA0NjYgNDc0LjVRNDY1IDQ3MyA0NjAuNSA0NzBRNDU2IDQ2NyA0NDMuNSA0NTMuNVE0MzEgNDQwIDQyMy41IDQyOC41UTQxNiA0MTcgNDExLjUgNDA3LjVRNDA3IDM5OCA0MDYgMzkzUTQwNSAzODggNDAzIDM4My41UTQwMSAzNzkgNDAwIDM2OS41UTM5OSAzNjAgMzk4IDM1OFEzOTcgMzU2IDM5NyAzMzdRMzk3IDMxOCAzOTggMzE2LjVRMzk5IDMxNSA0MDAgMzA1LjVRNDAxIDI5NiA0MDIuNSAyOTNRNDA0IDI5MCA0MDUuNSAyODMuNVE0MDcgMjc3IDQxNiAyNTlRNDI1IDI0MSA0MzMgMjMwUTQ0MSAyMTkgNDUxIDIwOVE0NjEgMTk5IDQ3NCAxODkuNVE0ODcgMTgwIDUwMC41IDE3M1E1MTQgMTY2IDUyMCAxNjQuNVE1MjYgMTYzIDUyNi41IDE2MlE1MjcgMTYxIDUzNC41IDE1OC41UTU0MiAxNTYgNTUwLjUgMTU0LjVRNTU5IDE1MyA1NjAuNSAxNTJRNTYyIDE1MSA1NzMuNSAxNDkuNVE1ODUgMTQ4IDU5MSAxNDhRNTk3IDE0OCA2MDAuNSAxNDdRNjA0IDE0NiA2NDUuNSAxNDZRNjg3IDE0NiA2OTIuNSAxNDQuNVE2OTggMTQzIDcwMi41IDE0MC41UTcwNyAxMzggNzExIDEzNFE3MTUgMTMwIDcxOC41IDEyNFE3MjIgMTE4IDcyMi41IDExNC41UTcyMyAxMTEgNzI0IDEwOS41UTcyNSAxMDggNzI1IDk3LjVRNzI1IDg3IDcyMSA3OC41UTcxNyA3MCA3MDkuNSA2My41WiIvPgo8L3N2Zz4K" alt=""></span>Vibestudio</a>
    <nav class="nav" aria-label="Main navigation"><a href="#how">How it works</a><a href="#install">Install</a><a class="nav-cta" href="https://panticonic.github.io/vibestudio/">Get Vibestudio <span aria-hidden="true">↗</span></a></nav>
  </header>
  <main id="top">
    <section class="wrap hero">
      <div class="eyebrow">A workspace for apps and agents</div>
      <h1>Make your own tools.<br><span>Put agents to work.</span></h1>
      <p class="lede">Vibestudio is a desktop workspace where apps, files, and AI agents work together. Start with a ready-to-use workspace, then shape it around the way you work.</p>
      <div class="actions">
        <a class="button primary" href="https://panticonic.github.io/vibestudio/">Download Vibestudio <span aria-hidden="true">↗</span></a>
        <a class="button secondary" href="#how">See how to get started <span aria-hidden="true">↓</span></a>
      </div>
      <section class="workspace-connect" aria-labelledby="workspace-connect-title">
        <div><h2 id="workspace-connect-title">Use this page in your workspace</h2><p id="workspace-connection-status" role="status" aria-live="polite">This page starts without workspace access.</p></div>
        <button id="workspace-connect-button" type="button" disabled>Connect to workspace</button><noscript><p class="fine">JavaScript is off. Downloads and guides remain available.</p></noscript>
      </section>
      <p class="micro">Free to try · Open source · Currently in alpha · <a href="https://github.com/panticonic/vibestudio">View the source</a></p>
    </section>
    <section class="wrap intro" aria-label="About Vibestudio">
      <article class="intro-lead"><div class="kicker">One connected workspace</div><h2>Your software should fit your work.</h2><p>Bring useful apps, your own tools, and AI agents into one place. Ask an agent to help, use an app directly, or let the two work together.</p></article>
      <article><div class="kicker">01 / Make</div><h3>Build and adapt tools</h3><p>Describe what you need and grow a small tool into a full app in your workspace.</p></article>
      <article><div class="kicker">02 / Connect</div><h3>Bring your work together</h3><p>Connect apps and services when you need them. Each workspace keeps its own files and conversations.</p></article>
      <article><div class="kicker">03 / Stay in control</div><h3>Choose what gets access</h3><p>Websites and integrations ask before using protected capabilities. Review each request in context.</p></article>
      <article><div class="kicker">04 / Continue anywhere</div><h3>Your computer or your server</h3><p>Start on your computer. Later, run a server at home and connect another device.</p></article>
    </section>
    <section class="wrap section" id="how">
      <div class="section-head"><div><div class="kicker">Your first few minutes</div><h2>Start with a workspace.</h2></div><p>You don’t need to set up a server or build anything before you can begin.</p></div>
      <div class="steps">
        <article class="step"><div class="step-num">STEP 01</div><h3>Install the desktop app</h3><p>Choose the package for your computer. Package-manager installs receive updates through that same manager.</p></article>
        <article class="step"><div class="step-num">STEP 02</div><h3>Choose a workspace</h3><p>Launch Vibestudio, then create a workspace or open one you already have. Your workspace keeps its apps, files, and chats together.</p></article>
        <article class="step"><div class="step-num">STEP 03</div><h3>Tell the agent what you need</h3><p>The onboarding agent starts a conversation for your new workspace. Describe a goal, try the included apps, and connect a provider when prompted.</p></article>
      </div>
    </section>
    <section class="wrap install" id="install">
      <div class="install-box">
        <div><div class="kicker">Get the app</div><h2>Choose your platform.</h2><p>Download the latest desktop release or follow the package-repository instructions for your system.</p><div class="install-links"><a class="button primary" href="https://panticonic.github.io/vibestudio/">Downloads &amp; packages <span aria-hidden="true">↗</span></a><a class="button secondary" href="https://github.com/panticonic/vibestudio/releases/latest">All release files <span aria-hidden="true">↗</span></a></div><p class="fine">Vibestudio is alpha software; expect rough edges and changes as it develops.</p></div>
        <div class="platforms"><h3>Quick notes</h3><ul><li><b>macOS</b><span>Install with <code>brew install --cask panticonic/tap/vibestudio</code>. On first launch, choose Open Anyway in Privacy &amp; Security. Update with <code>brew upgrade</code>.</span></li><li><b>Debian / Ubuntu</b><span>Add the signed apt repository, then install with apt.</span></li><li><b>Fedora / RHEL</b><span>Add the RPM repository and install with dnf.</span></li><li><b>Windows</b><span>Run the .exe installer. Windows may show a SmartScreen warning.</span></li></ul><div class="callout" style="margin-top:19px">The agent currently requires a <a href="https://chatgpt.com/codex">Codex subscription</a>. Other providers may work, but aren’t actively validated.</div></div>
      </div>
    </section>
    <section class="wrap end">
      <article class="end-card"><div class="kicker">A note on safety</div><h2>Early software, with real permissions.</h2><p>Vibestudio is alpha software and is not yet reliable or suitable for every purpose. Workspace isolation and capability approvals provide boundaries, but don’t treat them as a guarantee that all code or agent actions are safe. Learn how the <a class="text-link" href="https://github.com/panticonic/vibestudio/blob/main/docs/permission-system.md">permission system</a> works before connecting sensitive accounts.</p></article>
      <article class="end-card"><div class="kicker">Want to run it at home?</div><h2>Keep a workspace available.</h2><p>A headless server can stay running while your desktop and mobile devices connect to it. It needs Node.js 22.19 or newer; the <a class="text-link" href="https://github.com/panticonic/vibestudio#headless-server-remotehome-server-clients-connect-to-it">server setup guide</a> covers installation and first-device pairing.</p></article>
    </section>
  </main>
  <footer class="wrap"><span>© Vibestudio · Built in the open.</span><nav class="footer-links" aria-label="Footer"><a href="https://github.com/panticonic/vibestudio">GitHub</a><a href="https://github.com/panticonic/vibestudio/releases/latest">Releases</a><a href="https://github.com/panticonic/vibestudio/blob/main/README.md">Documentation</a></nav></footer>
  <script nomodule>var status = document.getElementById("workspace-connection-status"); if (status) status.textContent = "Workspace connection needs a newer browser. Downloads and guides remain available.";</script>
  <script type="module" src="/connect.js"></script>
</body>
</html>`;

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
            { "/": "/p", comment: "Pairing trampoline" },
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
  const scheme = "vibestudio://connect/" + fragment;
  link.textContent = scheme;
  const isAndroid = /Android/i.test(navigator.userAgent);
  const isIos = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const openLink = () => {
    if (isAndroid) {
      location.href = "intent://connect/" + fragment + "#Intent;scheme=vibestudio;package=app.vibestudio.mobile;end";
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
