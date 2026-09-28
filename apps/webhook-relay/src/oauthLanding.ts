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

const CONNECTION_PAGE_CSS = `
:root{color-scheme:light dark;--bg:#ffffff;--panel:#fff;--ink:#14243d;--muted:#58677d;--line:#d4d9e2;--primary:#204fa3;--on-primary:#fff;--link:#204fa3}
*{box-sizing:border-box}body{font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:clamp(24px,8vw,80px) 24px;background:var(--bg);color:var(--ink)}main{max-width:600px;margin:0 auto;padding:clamp(24px,5vw,48px);border:1px solid var(--line);border-top:4px solid var(--primary);border-radius:4px;background:var(--panel)}main:before{content:"";display:block;width:32px;height:40px;margin-bottom:24px;background:url('/brand/vibestudio-symbol.svg') center/contain no-repeat}h1{font-size:28px;line-height:1.2;letter-spacing:-.035em;font-weight:650;margin:0 0 20px}p{margin:16px 0}button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 18px;border:0;border-radius:4px;background:var(--primary);color:var(--on-primary);font:600 14px system-ui;text-decoration:none;cursor:pointer}button:disabled{opacity:.55;cursor:default}button:focus-visible,a:focus-visible{outline:3px solid var(--link);outline-offset:4px}code{overflow-wrap:anywhere;font-size:12px}a{color:var(--link)}.muted{color:var(--muted);font-size:14px}
@media(prefers-color-scheme:dark){:root{--bg:#1a202a;--panel:#242e3c;--ink:#f4f5f6;--muted:#c7cdd5;--line:#485667;--primary:#496fa8;--on-primary:#fff;--link:#afc8f0}main:before{background-image:url('/brand/vibestudio-symbol-dark.svg')}}
`;

export function handleApexLanding(): Response {
  return new Response(APEX_LANDING_HTML, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}

const APEX_LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#1A202A" media="(prefers-color-scheme: dark)">
  <meta name="description" content="Vibestudio brings apps, files, and AI agents into one workspace on your computer or server.">
  <link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
  <title>Vibestudio — apps, files, and agents</title>
  <style>
    :root{color-scheme:light dark;--bg:#ffffff;--paper:#ffffff;--raised:#f1f3f7;--ink:#14243d;--muted:#58677d;--line:#d4d9e2;--primary:#204fa3;--primary-hover:#183e83;--link:#204fa3;--signal:#c73f2d;--danger:#b42318;--sans:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
    @media(prefers-color-scheme:dark){:root{--bg:#1a202a;--paper:#242e3c;--raised:#323e4e;--ink:#f4f5f6;--muted:#c7cdd5;--line:#485667;--primary:#496fa8;--primary-hover:#5275aa;--link:#afc8f0;--signal:#dc9584;--danger:#ffb4a9}}
    *{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:24px}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 var(--sans);-webkit-font-smoothing:antialiased}a{color:var(--link);text-underline-offset:4px}button,input,textarea{font:inherit}button,a{-webkit-tap-highlight-color:transparent}a:focus-visible,button:focus-visible,textarea:focus-visible{outline:3px solid var(--link);outline-offset:4px}button:disabled{cursor:default;opacity:.65}[hidden]{display:none!important}.wrap{width:min(1184px,calc(100% - 64px));margin-inline:auto}.topbar{height:88px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);gap:24px}.brand{display:flex;align-items:center;gap:10px;font-size:22px;font-weight:750;letter-spacing:-.045em;text-decoration:none;color:var(--ink)}.mark{width:29px;height:38px;object-fit:contain}.brand-mark{display:block;width:29px;height:38px}.brand-mark img{display:block;width:100%;height:100%;object-fit:contain}.nav{display:flex;align-items:center;gap:28px;font-size:14px}.nav a{text-decoration:none;color:var(--link)}.nav a:hover{color:var(--primary)}.nav-cta{border-bottom:2px solid var(--primary);padding:8px 0}
    .hero{display:grid;grid-template-columns:1.45fr 1fr;gap:64px;align-items:center;padding-block:88px 72px}h1{font-size:clamp(44px,5.4vw,76px);line-height:1.06;font-weight:650;letter-spacing:-.055em;margin:0 0 28px;max-width:760px}.lede{font-size:19px;line-height:1.6;color:var(--muted);max-width:560px;margin:0}.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:32px}.button{display:inline-flex;justify-content:center;align-items:center;gap:18px;min-height:48px;padding:11px 20px;border:1px solid var(--line);border-radius:4px;font-size:14px;font-weight:650;text-decoration:none;cursor:pointer}.primary{background:var(--primary);border-color:var(--primary);color:#fff}.primary:hover{background:var(--primary-hover)}.secondary{background:var(--paper);color:var(--ink)}.secondary:hover{border-color:var(--primary)}.fine{font-size:13px;color:var(--muted);margin:18px 0 0}.hero-art{position:relative;min-height:390px;background:var(--raised);border:1px solid var(--line);display:grid;place-items:center;border-radius:4px;overflow:hidden}.hero-art:before,.hero-art:after{content:"";position:absolute;pointer-events:none}.hero-art:before{inset:22px;border:1px solid var(--line)}.hero-art:after{width:14px;height:14px;right:22px;bottom:22px;background:var(--signal)}.hero-art picture{display:block;width:55%;height:290px}.hero-art picture img{display:block;width:100%;height:100%;object-fit:contain}.hero-art span{position:absolute;bottom:38px;left:38px;color:var(--muted);font:11px var(--mono);letter-spacing:.06em}
    .facts{display:grid;grid-template-columns:repeat(3,1fr);gap:36px;padding-block:28px 44px;border-top:3px solid var(--ink)}.facts p{margin:0;color:var(--muted);font-size:15px}.facts strong{display:block;color:var(--ink);font-weight:650;margin-bottom:7px}.install{display:grid;grid-template-columns:1fr 1.15fr;gap:72px;border-top:1px solid var(--line);padding-block:54px}.install-copy p{margin:0 0 18px;color:var(--muted)}.install-copy .actions{margin-top:24px}.platforms{list-style:none;margin:0;padding:0}.platforms li{display:grid;grid-template-columns:124px 1fr;gap:20px;border-bottom:1px solid var(--line);padding:18px 0;font-size:14px}.platforms li:first-child{padding-top:0}.platforms b{font-weight:650}.platforms span{color:var(--muted)}code{font:12px/1.6 var(--mono);overflow-wrap:anywhere;color:var(--ink)}.connection{border-top:1px solid var(--line);padding-block:36px}.workspace-connect{display:flex;align-items:center;justify-content:space-between;gap:28px}.workspace-connect p{margin:0;color:var(--muted);font-size:14px}.workspace-connect button{flex-shrink:0}.notes{border-top:1px solid var(--line);display:grid;grid-template-columns:1fr 1fr;gap:64px;padding-block:32px}.notes p{font-size:14px;color:var(--muted);margin:0}.notes strong{color:var(--ink)}footer{border-top:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:24px;padding-block:24px 40px;font-size:13px;color:var(--muted)}.footer-links{display:flex;gap:24px}.footer-links a{text-decoration:none}
    .image-lab{--copper:#dba77a;--cream:#fff0d9;margin:32px 0 56px;border:1px solid #785750;border-radius:20px;background:#281e2b;color:var(--cream);overflow:hidden;box-shadow:0 22px 70px #281e2b24}.lab-top{padding:34px 36px 28px;background:radial-gradient(ellipse at 85% 0,#745059 0,transparent 65%);border-bottom:1px solid #ffffff26;display:flex;justify-content:space-between;gap:24px}.lab-kicker,.lab-live{font:11px var(--mono);text-transform:uppercase;letter-spacing:.16em;color:var(--copper)}.lab-top h2{font:clamp(30px,4vw,48px)/1.1 Georgia,serif;letter-spacing:-.035em;margin:12px 0}.lab-top p{max-width:48ch;line-height:1.6;color:#d0bec7;margin:0}.lab-seal{flex-shrink:0;align-self:center;width:94px;height:94px;border:1px solid var(--copper);border-radius:50%;display:grid;place-content:center;text-align:center;font:italic 20px Georgia,serif;transform:rotate(12deg);box-shadow:inset 0 0 0 7px #281e2b,inset 0 0 0 8px #dba77a55}.lab-seal small{font:9px var(--mono);margin-top:6px;letter-spacing:.1em}.lab-body{display:grid;grid-template-columns:minmax(0,.85fr) minmax(0,1.4fr)}.lab-controls{padding:28px;border-right:1px solid #ffffff26;min-width:0}.lab-controls label{display:block;font:15px Georgia,serif;margin-bottom:12px}.lab-controls textarea,.lab-controls input{box-sizing:border-box;width:100%;border:1px solid #967c85;border-radius:8px;background:#1c1622;color:var(--cream);padding:14px;font:15px/1.6 inherit;resize:vertical}.lab-ideas{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 24px}.lab-ideas button,.lab-secondary{border:1px solid #ffffff35;border-radius:30px;background:transparent;color:#e7c8aa;min-height:38px;padding:8px 12px;font:12px var(--mono);cursor:pointer}.lab-ideas button:hover,.lab-secondary:hover{background:#ffffff12}.lab-submit{width:100%;background:var(--copper)!important;color:#241b28!important;border-color:var(--copper)!important;border-radius:8px!important;min-height:48px}.image-lab button:disabled{opacity:.55;cursor:wait}.image-lab :focus-visible{outline:3px solid #eeb784;outline-offset:4px}.lab-note,.lab-status{font-size:12px;color:#d0bec7;line-height:1.6}.lab-status{min-height:3.2em;margin-top:16px}.lab-status[data-error="true"]{color:#ffb4ac}.lab-preview{min-width:0;min-height:520px;padding:22px;display:flex;flex-direction:column;align-items:stretch;justify-content:center;background:radial-gradient(ellipse at 50% 45%,#674854 0,#382837 65%,#2c202e 100%);position:relative}.lab-placeholder{text-align:center;padding:60px 12px;position:relative}.lab-orbit{width:160px;height:160px;margin:0 auto 32px;border:1px solid #dba77a70;border-radius:50%;display:grid;place-items:center;position:relative;box-shadow:0 0 80px #dba77a18,inset 0 0 50px #dba77a0d}.lab-orbit:before,.lab-orbit:after{content:"";position:absolute;inset:20px -28px;border:1px solid #dba77a80;border-radius:50%;transform:rotate(-38deg)}.lab-orbit:after{transform:rotate(38deg);inset:-28px 20px}.lab-orbit span{font:italic 78px Georgia,serif;color:var(--copper)}.lab-placeholder h3{font:italic 26px Georgia,serif;margin:0 0 12px}.lab-placeholder p{font-size:13px;color:#d0bec7;max-width:27ch;margin:auto;line-height:1.6}.lab-preview iframe{width:100%;height:530px;border:0;border-radius:10px;background:#fffaf0}.lab-preview>p{text-align:center;color:#ddc7cb;font-size:12px;margin:18px 0 8px}.lab-download{align-self:center;font:12px var(--mono);color:var(--copper);padding:8px}.lab-bottom{border-top:1px solid #ffffff26;padding:18px 28px;display:flex;gap:16px;align-items:center;justify-content:space-between}.lab-bottom p{font:10px/1.6 var(--mono);color:#bda7b4;overflow-wrap:anywhere;margin:0}.lab-transcript{list-style:none;padding:0;margin:16px 0;max-height:220px;overflow:auto}.lab-transcript li{padding:12px 0;border-top:1px solid #ffffff20}.lab-transcript strong{font:10px var(--mono);text-transform:uppercase;letter-spacing:.12em;color:var(--copper)}.lab-transcript p{font-size:13px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0}.lab-revision-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.lab-working-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#dba77a;margin-right:8px}.image-lab[data-working="true"] .lab-working-dot{animation:lab-pulse 1.6s ease-in-out infinite}@keyframes lab-pulse{50%{opacity:.2;box-shadow:0 0 0 5px #dba77a25}}@media(max-width:800px){.lab-body{grid-template-columns:1fr}.lab-controls{border-right:0;border-bottom:1px solid #ffffff26}.lab-preview{min-height:430px}.lab-preview iframe{height:480px}}@media(max-width:560px){.lab-top{padding:24px;gap:12px}.lab-seal{width:64px;height:64px;font-size:16px}.lab-seal small{font-size:7px}.lab-controls{padding:22px}.lab-preview{padding:12px}.lab-bottom{padding:16px 22px}.lab-top h2{font-size:34px}}@media(prefers-reduced-motion:reduce){.lab-working-dot{animation:none!important}}

    @media(max-width:800px){.wrap{width:calc(100% - 40px)}.topbar{height:72px}.nav{gap:18px}.nav a:first-child{display:none}.hero{gap:28px;padding-block:48px;grid-template-columns:1.3fr .7fr}h1{font-size:clamp(40px,6.2vw,60px)}.lede{font-size:17px}.hero-art{min-height:310px}.hero-art picture{height:210px;width:65%}.hero-art span{display:none}.facts{gap:24px}.install{gap:32px}.platforms li{grid-template-columns:1fr;gap:5px}.notes{gap:28px}}@media(max-width:560px){.wrap{width:calc(100% - 36px)}.hero{grid-template-columns:1fr;padding-block:40px;gap:28px}h1{font-size:44px;margin-bottom:22px}.hero-art{min-height:156px}.hero-art picture{height:120px;width:120px}.hero-art:before{inset:14px}.hero-art:after{right:14px;bottom:14px;width:10px;height:10px}.facts{grid-template-columns:1fr;gap:20px;padding-block:24px 32px}.facts strong{margin-bottom:2px}.install{grid-template-columns:1fr;gap:32px;padding-block:32px}.workspace-connect{align-items:stretch;flex-direction:column;gap:16px}.workspace-connect button{align-self:flex-start}.notes{grid-template-columns:1fr;gap:20px}.lab-body{grid-template-columns:1fr}.lab-controls{border-right:0;border-bottom:1px solid var(--line)}.lab-top{align-items:flex-start;flex-direction:column;gap:4px}.lab-preview{min-height:280px}footer{align-items:flex-start;flex-direction:column;gap:16px}.nav{font-size:13px}.brand{font-size:20px}.actions .button{flex:1}.lede{max-width:100%}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
.lab-machine{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden;background:radial-gradient(ellipse at 50% 37%,#614358,#302333 64%);padding:24px 18px;color:#fff0d9;text-align:center}.machine-topline{position:absolute;top:22px;left:22px;right:22px;display:flex;justify-content:space-between;font:9px var(--mono);letter-spacing:.09em;color:#d5b6ba}.machine-topline i{display:inline-block;width:5px;height:5px;background:#c5edda;border-radius:50%;margin-right:7px;box-shadow:0 0 12px #c5edda}.machine-stage{width:min(100%,390px);height:310px;position:relative;flex-shrink:0}.machine-grid{position:absolute;inset:15px;background-image:radial-gradient(#e9c5a330 1px,transparent 1px);background-size:19px 19px;mask-image:radial-gradient(ellipse,#000,transparent 70%)}.machine-apparatus{position:absolute;width:280px;height:280px;inset:15px 0 0;margin:auto;filter:drop-shadow(0 10px 24px #170c2466)}.machine-orbit{position:absolute;inset:28px 36px;border:1px solid #dba77a40;border-radius:50%;animation:machine-spin 14s linear infinite}.machine-orbit span{position:absolute;left:14%;top:8%;font:24px Georgia;color:#f3cb99;background:#473144;border-radius:50%;width:32px;height:32px;line-height:32px}.orbit-two{inset:4px 70px;transform:rotate(35deg);animation-duration:21s;animation-direction:reverse;border-style:dashed}.orbit-two span{color:#c5edda;font-size:29px}.orbit-three{inset:60px 8px;animation-duration:18s}.orbit-three span{color:#efafc7;font-style:italic}.machine-brain{transform-origin:160px 150px;animation:machine-float 3.4s ease-in-out infinite}.machine-eyes{transform-origin:160px 160px;animation:machine-blink 5s infinite}.machine-valve{transform-origin:55px 212px;animation:machine-spin 5s steps(8) infinite}.machine-antenna{transform-origin:160px 63px;animation:machine-wiggle 2.2s ease-in-out infinite}.machine-spark{animation:machine-twinkle 2.7s ease-in-out infinite}.machine-signal{stroke-dasharray:54;animation:machine-signal 1.8s linear infinite}.machine-lamp{animation:machine-twinkle 1.1s ease-in-out infinite}.machine-note{position:absolute;font:10px var(--mono);letter-spacing:.08em;color:#e3bdba;z-index:1}.note-one{left:1%;top:75px;transform:rotate(-15deg);border:1px solid #dba77a70;padding:6px 9px;animation:machine-note 6s ease-in-out infinite}.note-two{right:0;top:197px;transform:rotate(13deg);border:1px dashed #c5edda80;color:#c5edda;padding:7px 9px;font-size:8px}.note-three{right:4%;top:246px;font:italic 11px Georgia}.machine-particle{position:absolute;color:#f3cb99;font:22px Georgia;animation:machine-drift 4s ease-in-out infinite}.p-one{left:20%;top:38%;--drift:-25px}.p-two{right:16%;top:46%;--drift:20px;animation-delay:-1s;color:#c5edda}.p-three{left:39%;top:15%;--drift:-15px;animation-delay:-2s}.p-four{right:29%;top:23%;--drift:28px;animation-delay:-3s;color:#efafc7}.machine-eyebrow{font:8px var(--mono);letter-spacing:.19em;color:#dba77a;margin:0 0 10px}.lab-machine h3{font:italic clamp(27px,3vw,39px)/1.1 Georgia,serif;letter-spacing:-.04em;margin:0 0 14px}.machine-activity{font:12px/1.5 var(--mono);color:#c5edda;max-width:36ch;min-height:36px;margin:0 0 8px}.machine-caption{font:12px/1.5 var(--mono);color:#e3cbd4;margin:0 0 26px;min-height:36px;max-width:32ch}.machine-marquee{width:calc(100% + 36px);overflow:hidden;border-block:1px solid #dba77a40;padding:10px 0;transform:rotate(-3deg);background:#dba77a0c}.machine-marquee span{display:block;white-space:nowrap;width:max-content;font:9px var(--mono);letter-spacing:.15em;color:#dba77a;animation:machine-march 24s linear infinite}.machine-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;font:9px/1.5 var(--mono);color:#c7aeba;margin-top:23px}.machine-foot button{color:#e9c5a3;background:none;border:0;border-bottom:1px solid #dba77a60;padding:4px 0;font:inherit;cursor:pointer}.lab-machine[data-paused="true"] *{animation-play-state:paused!important}.image-lab:not([data-working="true"]) #lab-invention{animation:machine-reveal .7s ease-out}.image-lab[data-working="true"] .lab-preview{min-height:620px}@keyframes machine-spin{to{transform:rotate(360deg)}}@keyframes machine-float{0%,100%{transform:translateY(4px) rotate(-5deg)}50%{transform:translateY(-9px) rotate(5deg)}}@keyframes machine-blink{0%,43%,47%,100%{transform:scaleY(1)}45%{transform:scaleY(.1)}}@keyframes machine-wiggle{0%,100%{transform:rotate(-9deg)}50%{transform:rotate(9deg)}}@keyframes machine-twinkle{50%{opacity:.25}}@keyframes machine-signal{to{stroke-dashoffset:-108}}@keyframes machine-note{50%{transform:translateY(-8px) rotate(-8deg)}}@keyframes machine-drift{0%{opacity:0;transform:translate(0,30px) scale(.5)}40%{opacity:.8}100%{opacity:0;transform:translate(var(--drift),-70px) rotate(90deg)}}@keyframes machine-march{to{transform:translateX(-50%)}}@keyframes machine-reveal{from{opacity:0;transform:translateY(12px) scale(.98)}to{opacity:1;transform:none}}@media(max-width:560px){.machine-stage{width:300px;max-width:100%}.machine-foot{font-size:8px}.machine-topline{font-size:8px}}@media(prefers-reduced-motion:reduce){.lab-machine *,#lab-invention{animation:none!important}.machine-foot button{display:none}}
  </style>
</head>
<body>
  <header class="wrap topbar"><a class="brand" href="#top" aria-label="Vibestudio home"><picture class="brand-mark"><source media="(prefers-color-scheme: dark)" srcset="/brand/vibestudio-symbol-dark.svg"><img class="mark" src="/brand/vibestudio-symbol.svg" alt=""></picture>Vibestudio</a><nav class="nav" aria-label="Main navigation"><a href="https://github.com/panticonic/vibestudio">Source</a><a class="nav-cta" href="#install">Get Vibestudio ↗</a></nav></header>
  <main id="top">
    <section class="wrap hero"><div><h1>A workspace for apps, files, and agents.</h1><p class="lede">Use your tools together. Ask an agent to help with your work or build something of your own. Keep it on your computer or your server.</p><div class="actions"><a class="button primary" href="https://panticonic.github.io/vibestudio/">Download Vibestudio <span aria-hidden="true">↗</span></a><a class="button secondary" href="https://github.com/panticonic/vibestudio/blob/main/README.md">Read the guide</a></div><p class="fine">Open source · Desktop and mobile · Alpha</p></div><div class="hero-art" aria-hidden="true"><picture><source media="(prefers-color-scheme: dark)" srcset="/brand/vibestudio-symbol-dark.svg"><img src="/brand/vibestudio-symbol.svg" alt=""></picture></div></section>
    <div class="wrap facts"><p>Start with the included apps. Describe a tool you need and build it with an agent.</p><p>Connect a supported subscription, an API key, or a local model from the chat panel.</p><p>Review requests from apps, websites, and agents before they use protected capabilities.</p></div>
    <section class="wrap install" id="install" aria-label="Install Vibestudio"><div class="install-copy"><p>Install the desktop app, open a workspace, and tell the onboarding agent what you want to do. Connect your phone to continue in the same workspace.</p><div class="actions"><a class="button primary" href="https://panticonic.github.io/vibestudio/">Downloads &amp; packages ↗</a><a class="button secondary" href="https://github.com/panticonic/vibestudio/releases/latest">Release files</a></div><p class="fine">Package-manager installs update through the same package manager.</p></div><ul class="platforms"><li><b>macOS</b><span><code>brew install --cask panticonic/tap/vibestudio</code><br>On first launch, choose Open Anyway in Privacy &amp; Security.</span></li><li><b>Debian / Ubuntu</b><span>Add the signed apt repository, then install with apt.</span></li><li><b>Fedora / RHEL</b><span>Add the RPM repository, then install with dnf.</span></li><li><b>Windows</b><span>Run the .exe installer. Windows may show a SmartScreen warning.</span></li></ul></section>
    <section class="wrap connection" aria-label="Connect this website"><div class="workspace-connect"><div><p id="workspace-connection-status" role="status" aria-live="polite">This page starts without workspace access.</p><p id="workspace-capabilities" role="status" aria-live="polite"></p></div><button class="button secondary" id="workspace-connect-button" type="button" disabled>Connect to workspace</button><noscript><p class="fine">JavaScript is off. Downloads and guides remain available.</p></noscript></div>
      <section class="image-lab" id="image-lab" aria-label="Bureau of Impossible Inventions" hidden>
        <div class="lab-top"><div><span class="lab-kicker">Est. just now · Powered by your workspace</span><h2>Bureau of<br>Impossible Inventions</h2><p>Two things that should never meet.<br>One extraordinary thing with an intelligence of its own.</p></div><div class="lab-seal" aria-hidden="true">Why not?<small>DEPT. OF WONDER</small></div></div>
        <div class="lab-body"><div class="lab-controls">
          <label for="lab-prompt">What has no business existing?</label><textarea id="lab-prompt" maxlength="1200" rows="3">An orchestra of AI agents that turns my feelings into weather reports from imaginary worlds</textarea>
          <div class="lab-ideas" aria-label="Unlikely collisions"><button type="button" data-idea="An AI gardener that grows illustrated tiny cities from my compliments">Compliments × cities</button><button type="button" data-idea="An agentic time machine that interviews my houseplants about their possible futures">Houseplants × time travel</button><button type="button" data-idea="A pocket moon whose AI astronomer invents new constellations from my mood">Moods × moon tides</button></div>
          <button class="button primary lab-submit" id="lab-generate" type="button">Invent the impossible</button>
          <p class="lab-note">Your agent builds an AI-powered invention right here, with access to your connected workspace. Normal model usage and workspace approvals apply.</p>
          <div class="lab-status" id="lab-status" role="status" aria-live="polite">The improbable is taking appointments.</div>
          <ol class="lab-transcript" id="lab-transcript" aria-label="Conversation with your inventor"></ol>
          <form id="lab-revision-form"><label for="lab-revision">Then change the laws of nature.</label><input id="lab-revision" maxlength="1200" placeholder="What if it could…" autocomplete="off"><div class="lab-revision-actions"><button class="lab-secondary" id="lab-revise" type="submit" disabled>Ask the inventor ↗</button><button class="lab-secondary" id="lab-weirder" type="button" disabled>Make it weirder ✧</button></div></form>
        </div><div class="lab-preview"><div class="lab-machine" id="lab-machine" hidden aria-label="The inventor is working">
  <div class="machine-topline"><span><i></i> IMPOSSIBILITY ENGINE / ON</span><span id="lab-elapsed">00:00</span></div>
  <div class="machine-stage" aria-hidden="true">
    <div class="machine-grid"></div><div class="machine-orbit orbit-one"><span>✦</span></div><div class="machine-orbit orbit-two"><span>☂</span></div><div class="machine-orbit orbit-three"><span>?</span></div>
    <span class="machine-note note-one">WHAT IF?</span><span class="machine-note note-two">PATENT<br>PENDING*</span><span class="machine-note note-three">*on reality</span>
    <svg class="machine-apparatus" viewBox="0 0 320 310" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="jar-light" x1="100" y1="80" x2="230" y2="230" gradientUnits="userSpaceOnUse"><stop stop-color="#b9f6de" stop-opacity=".2"/><stop offset="1" stop-color="#dba77a" stop-opacity=".02"/></linearGradient></defs>
      <path d="M87 245H55V197H26" stroke="#dba77a" stroke-width="7"/><path d="M234 229H275V171H298" stroke="#dba77a" stroke-width="7"/>
      <g class="machine-valve"><circle cx="55" cy="212" r="15" fill="#352637" stroke="#dba77a" stroke-width="2"/><path d="M44 212h22m-11-11v22" stroke="#dba77a" stroke-width="2"/></g>
      <path d="M95 235V129a65 65 0 0 1 130 0v106" fill="url(#jar-light)" stroke="#e9c5a3" stroke-width="2"/><path d="M109 165v-35a51 51 0 0 1 39-50" stroke="#fff0d9" stroke-opacity=".4" stroke-width="3" stroke-linecap="round"/>
      <g class="machine-brain"><path d="M131 168c-15-2-21-23-7-33-2-19 20-29 32-15 11-19 38-12 37 9 22 3 25 31 7 41-2 20-28 24-40 10-10 15-33 7-29-12Z" fill="#c5edda" stroke="#fff0d9" stroke-width="2"/><path d="M151 131c-10 0-15 9-8 16m24-22c-8 6-6 16 3 19m17-5c-9 4-9 15-2 19" stroke="#617e70" stroke-width="2" stroke-linecap="round"/><g class="machine-eyes" fill="#352637"><ellipse cx="147" cy="161" rx="3" ry="5"/><ellipse cx="173" cy="161" rx="3" ry="5"/></g><path d="M155 174q5 5 10 0" stroke="#352637" stroke-width="2" stroke-linecap="round"/></g>
      <g class="machine-spark" stroke="#f6d996" stroke-width="2"><path d="M160 91v-16m-8 8h16M111 201v-12m-6 6h12m84-8v-12m-6 6h12"/></g>
      <rect x="78" y="235" width="164" height="42" rx="9" fill="#dba77a"/><rect x="100" y="246" width="63" height="19" rx="3" fill="#352637"/><path class="machine-signal" d="M105 256h8l4-6 6 12 5-9 5 3h24" stroke="#c5edda" stroke-width="2"/>
      <circle cx="190" cy="256" r="7" fill="#352637"/><circle class="machine-lamp" cx="215" cy="256" r="5" fill="#c5edda"/><path d="M94 277v10m132-10v10" stroke="#dba77a" stroke-width="8" stroke-linecap="round"/>
      <path class="machine-antenna" d="M160 63V44m-12 0 12-12 12 12" stroke="#dba77a" stroke-width="2" stroke-linecap="round"/>
    </svg>
    <div class="machine-particle p-one">✧</div><div class="machine-particle p-two">+</div><div class="machine-particle p-three">✦</div><div class="machine-particle p-four">∴</div>
  </div>
  <p class="machine-eyebrow">A SMALL DISTURBANCE IN THE POSSIBLE</p><h3>Reality, please hold.</h3><p class="machine-activity" id="lab-activity" role="status">Opening the inventor’s workspace</p><p class="machine-caption" id="lab-machine-caption" aria-hidden="true">Warming up the what-if engine…</p>
  <div class="machine-marquee" aria-hidden="true"><span>IDEAS IN ORBIT ✦ LOGIC OPTIONAL ✦ WONDER MANDATORY ✦ IDEAS IN ORBIT ✦ LOGIC OPTIONAL ✦ WONDER MANDATORY ✦ </span></div>
  <div class="machine-foot"><span>Real agent at work. No estimated finish.</span><button id="lab-motion" type="button">Pause animation</button></div>
</div>
<div class="lab-placeholder" id="lab-placeholder"><div class="lab-orbit" aria-hidden="true"><span>?</span></div><h3>A vacancy in reality.</h3><p>Your invention will live here.<br>It is currently enjoying not existing.</p></div><iframe id="lab-invention" title="Your interactive invention" referrerpolicy="no-referrer" hidden></iframe><p id="lab-preview-caption">Made by an agent. Directed by you.</p><a class="lab-download" id="lab-download" download="impossible-invention.html" hidden>Keep this invention ↓</a></div></div>
        <div class="lab-bottom"><p id="lab-location"><span class="lab-working-dot"></span>REAL AGENT · REAL WORKSPACE · UNREAL IDEAS</p><button class="lab-secondary" id="lab-refresh" type="button">Refresh preview</button></div>
      </section>
    </section>
    <div class="wrap notes"><p><strong>Run a server.</strong> Keep a workspace available while your desktop and phone connect to it. Follow the <a href="https://github.com/panticonic/vibestudio#headless-server-remotehome-server-clients-connect-to-it">server setup guide</a> for installation and pairing.</p><p><strong>Vibestudio is alpha software.</strong> Expect rough edges. Review the <a href="https://github.com/panticonic/vibestudio/blob/main/docs/permission-system.md">permission system</a> before connecting sensitive accounts.</p></div>
  </main>
  <footer class="wrap"><span>Vibestudio</span><nav class="footer-links" aria-label="Footer"><a href="https://github.com/panticonic/vibestudio">GitHub</a><a href="https://github.com/panticonic/vibestudio/releases/latest">Releases</a><a href="https://github.com/panticonic/vibestudio/blob/main/README.md">Documentation</a></nav></footer>
  <script nomodule>var status = document.getElementById("workspace-connection-status"); if (status) status.textContent = "Workspace connection needs a newer browser. Downloads and guides remain available.";</script>
  <script type="module" src="/connect.js"></script>
</body>
</html>`;

/** Browser fallback for a canonical logical panel-location universal link. */
export function handlePanelLanding(): Response {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open Vibestudio panel</title><style>${CONNECTION_PAGE_CSS}</style><main><h1>Open Vibestudio panel</h1><p id="status">Preparing panel link.</p><p><button id="open" type="button">Open in Vibestudio</button></p><p class="muted">Panel links can contain workspace state arguments. Only open links from a source you trust.</p><p><code id="link"></code></p></main><script>(()=>{const fragment=location.hash?location.hash.slice(1):"";const status=document.getElementById("status");const link=document.getElementById("link");const open=document.getElementById("open");if(!fragment){status.textContent="This panel URL is missing its location fragment.";open.disabled=true;return}const scheme="vibestudio://panel?"+fragment;link.textContent=scheme;open.addEventListener("click",()=>{location.href=/Android/i.test(navigator.userAgent)?"intent://panel?"+fragment+"#Intent;scheme=vibestudio;package=app.vibestudio.mobile;end":scheme});status.textContent="Open this logical panel location in Vibestudio."})()</script></html>`,
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
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title><style>${CONNECTION_PAGE_CSS}</style><body><main><h1>${safeTitle}</h1><p>${safeBody}</p></main></body></html>`,
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
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair Vibestudio</title>
<style>${CONNECTION_PAGE_CSS}</style>
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
</script>
</html>`;
